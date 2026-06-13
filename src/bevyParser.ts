import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface BevyElement {
    name: string;
    type: 'Component' | 'Resource' | 'Event' | 'Message' | 'Plugin' | 'Shader' | 'Asset' | 'System';
    filePath: string;
    line: number;
    description: string; // 首行注释摘要
    docstring: string;   // 完整文档注释
}

export class BevyParser {
    /**
     * 递归扫描指定目录下的文件，并提取 Bevy 语义元素
     */
    public static async parseWorkspace(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<BevyElement[]> {
        const elements: BevyElement[] = [];

        for (const folder of workspaceFolders) {
            const rootPath = folder.uri.fsPath;
            await this.scanDir(rootPath, rootPath, elements);
        }

        return elements;
    }

    private static async scanDir(dir: string, rootPath: string, elements: BevyElement[]): Promise<void> {
        if (dir.includes('target') || dir.includes('.git') || dir.includes('node_modules')) {
            return;
        }

        let files: string[];
        try {
            files = fs.readdirSync(dir);
        } catch {
            return;
        }

        for (const file of files) {
            const fullPath = path.join(dir, file);
            let stat: fs.Stats;
            try {
                stat = fs.statSync(fullPath);
            } catch {
                continue;
            }

            if (stat.isDirectory()) {
                await this.scanDir(fullPath, rootPath, elements);
            } else if (stat.isFile()) {
                const ext = path.extname(file);
                if (ext === '.rs') {
                    this.parseRustFile(fullPath, elements);
                } else if (ext === '.wgsl') {
                    this.parseShaderFile(fullPath, elements);
                }
            }
        }
    }

    /**
     * 解析 Rust 文件，分析 Bevy 特有语法
     */
    private static parseRustFile(filePath: string, elements: BevyElement[]): void {
        let content = '';
        try {
            content = fs.readFileSync(filePath, 'utf8');
        } catch {
            return;
        }

        const lines = content.split(/\r?\n/);
        
        // 提取文档注释的辅助函数
        const getDocstring = (startLineIndex: number): { docstring: string, firstLine: string } => {
            const docLines: string[] = [];
            let i = startLineIndex - 1;
            // 向上寻找所有的 /// 注释
            while (i >= 0) {
                const trimLine = lines[i].trim();
                if (trimLine.startsWith('///')) {
                    // 去掉 '///' 并去掉最外侧的一个空格（如果存在）
                    const comment = trimLine.substring(3).replace(/^\s/, '');
                    docLines.unshift(comment);
                    i--;
                } else if (trimLine.startsWith('//') || trimLine.startsWith('#[')) {
                    // 跳过常规注释或其它属性宏，继续向上找 docstring
                    i--;
                } else {
                    break;
                }
            }
            const docstring = docLines.join('\n');
            const firstLine = docLines.length > 0 ? docLines[0] : '';
            return { docstring, firstLine };
        };

        // 用于匹配 derive 中的 Bevy 概念
        // 匹配模式：#[derive(..., Component, ...)] struct MyComponent
        // 或者 #[derive(Component)]
        const deriveRegex = /#\[derive\(([^)]+)\)\]/g;
        
        for (let i = 0; i < lines.length; i++) {
            const lineContent = lines[i];

            // 1. 解析 Component / Resource / Event / Asset
            if (lineContent.includes('#[derive(')) {
                const match = deriveRegex.exec(lineContent);
                // 重置 RegExp 的 lastIndex 避免状态影响
                deriveRegex.lastIndex = 0;

                if (match) {
                    const derives = match[1].split(',').map(d => d.trim());
                    // 寻找紧随其后的 struct / enum 定义
                    let nextStructLine = -1;
                    let nextStructName = '';
                    
                    // 向下探测最多 5 行，寻找 struct 或 enum 定义
                    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
                        const nextLine = lines[j].trim();
                        // 匹配 struct / enum / union
                        const structMatch = nextLine.match(/^(?:pub\s+)?(?:struct|enum|union)\s+([A-Za-z0-9_]+)/);
                        if (structMatch) {
                            nextStructLine = j;
                            nextStructName = structMatch[1];
                            break;
                        }
                    }

                    if (nextStructName) {
                        for (const derive of derives) {
                            let type: BevyElement['type'] | null = null;
                            if (derive === 'Component') { type = 'Component'; }
                            else if (derive === 'Resource') { type = 'Resource'; }
                            else if (derive === 'Event') { type = 'Event'; }
                            else if (derive === 'Asset') { type = 'Asset'; }

                            if (type) {
                                const { docstring, firstLine } = getDocstring(i);
                                elements.push({
                                    name: nextStructName,
                                    type: type,
                                    filePath,
                                    line: nextStructLine + 1,
                                    description: firstLine || `${type} struct`,
                                    docstring: docstring || `No documentation description provided for ${nextStructName}.`
                                });
                            }
                        }
                    }
                }
            }

            // 2. 解析 Plugin (如 impl Plugin for MyPlugin)
            if (lineContent.includes('impl') && lineContent.includes('Plugin') && lineContent.includes('for')) {
                const pluginMatch = lineContent.match(/impl\s+(?:.*?\s+)?Plugin\s+for\s+([A-Za-z0-9_]+)/);
                if (pluginMatch) {
                    const pluginName = pluginMatch[1];
                    const { docstring, firstLine } = getDocstring(i);
                    elements.push({
                        name: pluginName,
                        type: 'Plugin',
                        filePath,
                        line: i + 1,
                        description: firstLine || 'Bevy Plugin implementation',
                        docstring: docstring || `Implements Bevy Plugin trait for ${pluginName}.`
                    });
                }
            }

            // 3. 解析 System (带有 Bevy 参数特性的函数)
            // Bevy System 函数往往包含：Query<, Res<, ResMut<, Commands, EventReader<, EventWriter<, Local< 等参数
            if (lineContent.trim().startsWith('pub fn ') || lineContent.trim().startsWith('fn ')) {
                const fnMatch = lineContent.match(/(?:pub\s+)?fn\s+([A-Za-z0-9_]+)\s*\(/);
                if (fnMatch) {
                    const fnName = fnMatch[1];
                    
                    // 我们读取函数的完整签名，最多向后探测 10 行直到遇到 { 或者是结束括号
                    let fullSignature = '';
                    for (let j = i; j < Math.min(lines.length, i + 10); j++) {
                        fullSignature += ' ' + lines[j].trim();
                        if (lines[j].includes('{') || lines[j].includes(')')) {
                            break;
                        }
                    }

                    // 检查函数签名中是否含有 Bevy 典型的 System 注入参数
                    const hasBevyParams = 
                        fullSignature.includes('Query<') || 
                        fullSignature.includes('Res<') || 
                        fullSignature.includes('ResMut<') || 
                        fullSignature.includes('Commands') || 
                        fullSignature.includes('EventReader<') || 
                        fullSignature.includes('EventWriter<') || 
                        fullSignature.includes('Local<') ||
                        fullSignature.includes('NonSend<') ||
                        fullSignature.includes('NonSendMut<');

                    if (hasBevyParams) {
                        const { docstring, firstLine } = getDocstring(i);
                        elements.push({
                            name: fnName,
                            type: 'System',
                            filePath,
                            line: i + 1,
                            description: firstLine || 'Bevy System function',
                            docstring: docstring || `Bevy system: ${fnName}\nSignature: \`${fullSignature.trim().replace(/\s+/g, ' ')}\``
                        });
                    }
                }
            }

            // 4. 解析 Message (自定义网络或进程通信的消息结构)
            // 根据 Bevy 生态中常用的 Message 规则（例如派生了 Message，或者实现了某些 Message trait，或者包含特定的宏）
            // 在此，我们支持：#[derive(Message)] 或 impl Message for MyStruct
            if (lineContent.includes('Message')) {
                // 情况A：派生 #[derive(..., Message, ...)]
                if (lineContent.includes('#[derive(')) {
                    const match = deriveRegex.exec(lineContent);
                    deriveRegex.lastIndex = 0;
                    if (match && match[1].split(',').map(d => d.trim()).includes('Message')) {
                        // 寻找 struct / enum
                        for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
                            const nextLine = lines[j].trim();
                            const structMatch = nextLine.match(/^(?:pub\s+)?(?:struct|enum)\s+([A-Za-z0-9_]+)/);
                            if (structMatch) {
                                const name = structMatch[1];
                                const { docstring, firstLine } = getDocstring(i);
                                elements.push({
                                    name,
                                    type: 'Message',
                                    filePath,
                                    line: j + 1,
                                    description: firstLine || 'Network or communication message',
                                    docstring: docstring || `Message structure: ${name}`
                                });
                                break;
                            }
                        }
                    }
                }
                // 情况B：实现 impl Message for MyStruct
                const implMsgMatch = lineContent.match(/impl\s+(?:.*?\s+)?Message\s+for\s+([A-Za-z0-9_]+)/);
                if (implMsgMatch) {
                    const name = implMsgMatch[1];
                    const { docstring, firstLine } = getDocstring(i);
                    elements.push({
                        name,
                        type: 'Message',
                        filePath,
                        line: i + 1,
                        description: firstLine || 'Message implementation',
                        docstring: docstring || `Implements Message trait for ${name}`
                    });
                }
            }
        }
    }

    /**
     * 解析 WGSL 着色器文件
     */
    private static parseShaderFile(filePath: string, elements: BevyElement[]): void {
        let content = '';
        try {
            content = fs.readFileSync(filePath, 'utf8');
        } catch {
            return;
        }

        const lines = content.split(/\r?\n/);
        const fileName = path.basename(filePath);

        // 提取着色器开头的 // 注释
        const docLines: string[] = [];
        for (const line of lines) {
            const trimLine = line.trim();
            if (trimLine.startsWith('//')) {
                docLines.push(trimLine.substring(2).trim());
            } else if (trimLine === '') {
                continue;
            } else {
                break;
            }
        }

        const firstLine = docLines.length > 0 ? docLines[0] : '';
        const docstring = docLines.join('\n');

        elements.push({
            name: fileName,
            type: 'Shader',
            filePath,
            line: 1,
            description: firstLine || 'WGSL Shader file',
            docstring: docstring || `WGSL shader asset located at ${fileName}.`
        });
    }
}
