import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface BevyElement {
    name: string;
    type: 'Component' | 'Resource' | 'Event' | 'Message' | 'Plugin' | 'Shader' | 'Asset' | 'System' | 'State' | 'SystemParam' | 'Bundle' | 'SystemSet' | 'TestSystem' | 'TestComponent' | 'TestResource' | 'TestEvent' | 'TestSystemParam' | 'TestBundle' | 'TestSystemSet';
    filePath: string;
    crateName?: string; // 所属的 Crate 名称
    sourceTarget?: { type: 'lib' | 'bin' | 'example'; name?: string }; // Rust 构建目标类型与名字
    line: number;
    description: string; // 首行注释摘要
    docstring: string;   // 完整文档注释
    // 扩展数据结构，支持高级静态分析
    systemMetadata?: {
        mutableResources: string[];
        readableResources: string[];
        mutableComponents: string[];
        readableComponents: string[];
        schedulePhase?: string; 
        belongsToSets: string[];
        runConditions: string[];
        runsAfter: string[];
        runsBefore: string[];
    };
    bindGroupMetadata?: {
        bindings: { binding: number; type: 'uniform' | 'texture' | 'sampler'; name: string }[];
    };
    shaderMetadata?: {
        bindings: { binding: number; type: 'uniform' | 'texture' | 'sampler'; name: string }[];
        entryPoints: { name: string; type: 'vertex' | 'fragment' | 'compute'; workgroupSize?: string }[];
    };
}

export class BevyParser {
    /**
     * 递归扫描指定目录下的文件，并提取 Bevy 语义元素
     */
    public static async parseWorkspace(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<BevyElement[]> {
        const elements: BevyElement[] = [];

        // 使用 VS Code 优化的 findFiles API，忽略 target, .git, node_modules 等目录
        const filesUris = await vscode.workspace.findFiles(
            '{**/*.rs,**/*.wgsl,**/*.wesl}',
            '{**/target/**,**/.git/**,**/node_modules/**}',
            100000
        );

        // 异步并行读取并解析文件
        const parsePromises = filesUris.map(async (uri) => {
            const filePath = uri.fsPath;
            const ext = path.extname(filePath);
            if (ext === '.rs') {
                await this.parseRustFileAsync(filePath, elements);
            } else if (ext === '.wgsl' || ext === '.wesl') {
                await this.parseShaderFileAsync(filePath, elements);
            }
        });

        await Promise.all(parsePromises);

        // 辅助缓存：目录 -> crateName
        const crateCache = new Map<string, string>();
        const getCrateName = (filePath: string): string => {
            let dir = path.dirname(filePath);
            while (true) {
                if (crateCache.has(dir)) {
                    return crateCache.get(dir)!;
                }
                const cargoPath = path.join(dir, 'Cargo.toml');
                if (fs.existsSync(cargoPath)) {
                    try {
                        const content = fs.readFileSync(cargoPath, 'utf8');
                        const match = content.match(/^name\s*=\s*"([^"]+)"/m);
                        if (match) {
                            const name = match[1];
                            crateCache.set(dir, name);
                            return name;
                        }
                    } catch (err) {
                        console.error('Failed to parse Cargo.toml for crate name:', cargoPath, err);
                    }
                }
                const parent = path.dirname(dir);
                if (parent === dir) {
                    break;
                }
                dir = parent;
            }
            return 'unknown';
        };

        // 辅助检测构建目标类型：检测路径中是否含有 examples 目录或是 src/bin
        const getSourceTarget = (filePath: string): BevyElement['sourceTarget'] => {
            const normalizedPath = filePath.replace(/\\/g, '/');
            const parts = normalizedPath.split('/');
            
            const examplesIndex = parts.indexOf('examples');
            if (examplesIndex !== -1 && examplesIndex < parts.length - 1) {
                const subParts = parts.slice(examplesIndex + 1);
                
                if (subParts.length > 1 && subParts[subParts.length - 1] === 'main.rs') {
                    subParts.pop();
                }
                
                if (subParts.length > 0) {
                    const lastIdx = subParts.length - 1;
                    if (subParts[lastIdx].endsWith('.rs')) {
                        subParts[lastIdx] = subParts[lastIdx].replace(/\.rs$/, '');
                    }
                }
                
                const exampleName = subParts.join('/');
                return { type: 'example', name: exampleName };
            }
            
            const srcIndex = parts.indexOf('src');
            if (srcIndex !== -1 && srcIndex < parts.length - 1 && parts[srcIndex + 1] === 'bin') {
                const subParts = parts.slice(srcIndex + 2);
                if (subParts.length > 1 && subParts[subParts.length - 1] === 'main.rs') {
                    subParts.pop();
                }
                if (subParts.length > 0) {
                    const lastIdx = subParts.length - 1;
                    if (subParts[lastIdx].endsWith('.rs')) {
                        subParts[lastIdx] = subParts[lastIdx].replace(/\.rs$/, '');
                    }
                }
                const binName = subParts.join('/');
                return { type: 'bin', name: binName };
            }

            return { type: 'lib' };
        };

        // 填充每个元素的 crateName 与 sourceTarget
        for (const element of elements) {
            element.crateName = getCrateName(element.filePath);
            element.sourceTarget = getSourceTarget(element.filePath);
        }

        // 全局后处理步骤：分析跨文件的 add_systems 调度配置
        const allFiles = Array.from(new Set(elements.map(e => e.filePath)));
        const globalSystems = elements.filter(e => (e.type === 'System' || e.type === 'TestSystem'));
        
        const readPromises = allFiles.map(async (filePath) => {
            if (path.extname(filePath) !== '.rs') return;
            try {
                const content = await fs.promises.readFile(filePath, 'utf8');
                const addSystemsRegex = /\.add_systems\(\s*([A-Za-z0-9_:]+)\s*,\s*([^;]+?)\)/g;
                let scheduleMatch: RegExpExecArray | null;
                while ((scheduleMatch = addSystemsRegex.exec(content)) !== null) {
                    const phase = scheduleMatch[1];
                    const chainText = scheduleMatch[2];
                    
                    for (const system of globalSystems) {
                        if (chainText.includes(system.name) && system.systemMetadata) {
                            system.systemMetadata.schedulePhase = phase;
                            const afterRegex = /\.after\(\s*([A-Za-z0-9_:]+)\s*\)/g;
                            let specMatch: RegExpExecArray | null;
                            while ((specMatch = afterRegex.exec(chainText)) !== null) { if (!system.systemMetadata.runsAfter.includes(specMatch[1])) system.systemMetadata.runsAfter.push(specMatch[1]); }
                            const beforeRegex = /\.before\(\s*([A-Za-z0-9_:]+)\s*\)/g;
                            while ((specMatch = beforeRegex.exec(chainText)) !== null) { if (!system.systemMetadata.runsBefore.includes(specMatch[1])) system.systemMetadata.runsBefore.push(specMatch[1]); }
                            const inSetRegex = /\.in_set\(\s*([A-Za-z0-9_:]+)\s*\)/g;
                            while ((specMatch = inSetRegex.exec(chainText)) !== null) { if (!system.systemMetadata.belongsToSets.includes(specMatch[1])) system.systemMetadata.belongsToSets.push(specMatch[1]); }
                            const runIfRegex = /\.run_if\(\s*([^)]+)\)/g;
                            while ((specMatch = runIfRegex.exec(chainText)) !== null) { if (!system.systemMetadata.runConditions.includes(specMatch[1])) system.systemMetadata.runConditions.push(specMatch[1]); }
                        }
                    }

                    // 解析 chain() 并生成系统间的串行 runsBefore/runsAfter 关系
                    if (chainText.includes('.chain(')) {
                        const chainRegex = /\(\s*([A-Za-z0-9_,\s\n\r:]+)\s*\)\s*\.chain\(\)/g;
                        let chainMatch: RegExpExecArray | null;
                        while ((chainMatch = chainRegex.exec(chainText)) !== null) {
                            const rawNames = chainMatch[1].split(',').map(s => s.trim()).filter(s => s.length > 0);
                            const sysNames = rawNames.map(name => name.split('::').pop() || name);
                            for (let idx = 1; idx < sysNames.length; idx++) {
                                const prevSysName = sysNames[idx - 1];
                                const currentSysName = sysNames[idx];

                                const currentSys = globalSystems.find(s => s.name === currentSysName);
                                if (currentSys && currentSys.systemMetadata) {
                                    if (!currentSys.systemMetadata.runsAfter.includes(prevSysName)) {
                                        currentSys.systemMetadata.runsAfter.push(prevSysName);
                                    }
                                }

                                const prevSys = globalSystems.find(s => s.name === prevSysName);
                                if (prevSys && prevSys.systemMetadata) {
                                    if (!prevSys.systemMetadata.runsBefore.includes(currentSysName)) {
                                        prevSys.systemMetadata.runsBefore.push(currentSysName);
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('Failed to perform global link step for file:', filePath, err);
            }
        });
        await Promise.all(readPromises);

        return elements;
    }

    /**
     * 解析 Rust 文件，分析 Bevy 特有语法
     */
    private static async parseRustFileAsync(filePath: string, elements: BevyElement[]): Promise<void> {
        let content = '';
        try {
            content = await fs.promises.readFile(filePath, 'utf8');
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
        const deriveRegex = /#\[derive\(([^)]+)\)\]/g;

        let inTestModule = false;
        let testModuleBraceDepth = 0;
        let currentBraceDepth = 0;
        
        for (let i = 0; i < lines.length; i++) {
            const lineContent = lines[i];
            const trimmedLine = lineContent.trim();

            // 检查当前行有无进入 mod tests 或 #[cfg(test)]
            if (!inTestModule) {
                if (trimmedLine.startsWith('mod tests') || trimmedLine.startsWith('pub mod tests') || trimmedLine.includes('cfg(test)')) {
                    inTestModule = true;
                    testModuleBraceDepth = currentBraceDepth;
                }
            }

            // 大括号深度更新
            const openBraces = (lineContent.match(/\{/g) || []).length;
            const closeBraces = (lineContent.match(/\}/g) || []).length;
            currentBraceDepth += openBraces;
            currentBraceDepth -= closeBraces;

            // 检查有无离开 mod tests
            if (inTestModule && currentBraceDepth <= testModuleBraceDepth) {
                inTestModule = false;
                testModuleBraceDepth = 0;
            }

            // 1. 解析 Component / Resource / Event / Asset / State / SystemParam / Bundle / SystemSet
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
                        const structMatch = nextLine.match(/^(?:pub\s+)?\(?(?:struct|enum|union)\s+([A-Za-z0-9_]+)/);
                        if (structMatch) {
                            nextStructLine = j;
                            nextStructName = structMatch[1];
                            break;
                        }
                    }

                    if (nextStructName) {
                        // 检查是否派生了 AsBindGroup
                        let bindGroupMetadata: BevyElement['bindGroupMetadata'] | undefined;
                        if (derives.includes('AsBindGroup')) {
                            const bindings: { binding: number; type: 'uniform' | 'texture' | 'sampler'; name: string }[] = [];
                            // 扫描内部成员 of struct
                            for (let k = nextStructLine + 1; k < Math.min(lines.length, nextStructLine + 30); k++) {
                                const fieldLine = lines[k].trim();
                                if (fieldLine.includes('}')) break;
                                // 提取 uniform(0, color)
                                const uniformMatch = fieldLine.match(/#\[uniform\(\s*([0-9]+)\s*,\s*([A-Za-z0-9_]+)\)/);
                                if (uniformMatch) {
                                    bindings.push({
                                        binding: parseInt(uniformMatch[1]),
                                        type: 'uniform',
                                        name: uniformMatch[2]
                                    });
                                }
                                // 提取 texture(1)
                                const textureMatch = fieldLine.match(/#\[texture\(\s*([0-9]+)\s*\)\]/);
                                if (textureMatch) {
                                    bindings.push({
                                        binding: parseInt(textureMatch[1]),
                                        type: 'texture',
                                        name: 'texture'
                                    });
                                }
                                // 提取 sampler(2)
                                const samplerMatch = fieldLine.match(/#\[sampler\(\s*([0-9]+)\s*\)\]/);
                                if (samplerMatch) {
                                    bindings.push({
                                        binding: parseInt(samplerMatch[1]),
                                        type: 'sampler',
                                        name: 'sampler'
                                    });
                                }
                            }
                            if (bindings.length > 0) {
                                bindGroupMetadata = { bindings };
                            }
                        }

                        for (const derive of derives) {
                            let type: BevyElement['type'] | null = null;
                            if (derive === 'Component') { type = inTestModule ? 'TestComponent' : 'Component'; }
                            else if (derive === 'Resource') { type = inTestModule ? 'TestResource' : 'Resource'; }
                            else if (derive === 'Event') { type = inTestModule ? 'TestEvent' : 'Event'; }
                            else if (derive === 'Asset') { type = 'Asset'; }
                            else if (derive === 'States') { type = 'State'; }
                            else if (derive === 'SystemParam') { type = inTestModule ? 'TestSystemParam' : 'SystemParam'; }
                            else if (derive === 'Bundle') { type = inTestModule ? 'TestBundle' : 'Bundle'; }
                            else if (derive === 'SystemSet') { type = inTestModule ? 'TestSystemSet' : 'SystemSet'; }

                            if (type) {
                                const { docstring, firstLine } = getDocstring(i);
                                elements.push({
                                    name: nextStructName,
                                    type: type,
                                    filePath,
                                    line: nextStructLine + 1,
                                    description: firstLine || `${type} struct`,
                                    docstring: docstring || `No documentation description provided for ${nextStructName}.`,
                                    bindGroupMetadata
                                });
                            }
                        }
                    }
                }
            }

            // 2. 解析 Plugin
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

            // 3. 解析 System
            if (lineContent.trim().startsWith('pub fn ') || lineContent.trim().startsWith('fn ')) {
                const fnMatch = lineContent.match(/(?:pub\s+)?fn\s+([A-Za-z0-9_]+)\s*\(/);
                if (fnMatch) {
                    const fnName = fnMatch[1];
                    let fullSignature = '';
                    for (let j = i; j < Math.min(lines.length, i + 10); j++) {
                        fullSignature += ' ' + lines[j].trim();
                        if (lines[j].includes('{') || lines[j].includes(')')) break;
                    }

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
                        const mutableResources: string[] = [];
                        const readableResources: string[] = [];
                        const mutableComponents: string[] = [];
                        const readableComponents: string[] = [];

                        const resMutRegex = /ResMut<\s*([A-Za-z0-9_]+)\s*>/g;
                        const resRegex = /Res<\s*([A-Za-z0-9_]+)\s*>/g;
                        let match: RegExpExecArray | null;
                        while ((match = resMutRegex.exec(fullSignature)) !== null) { mutableResources.push(match[1]); }
                        while ((match = resRegex.exec(fullSignature)) !== null) { readableResources.push(match[1]); }

                        const queryRegex = /Query<\s*([^>]+)\s*>/g;
                        while ((match = queryRegex.exec(fullSignature)) !== null) {
                            const queryInner = match[1];
                            const mutCompRegex = /&mut\s+([A-Za-z0-9_]+)/g;
                            let compMatch: RegExpExecArray | null;
                            while ((compMatch = mutCompRegex.exec(queryInner)) !== null) { mutableComponents.push(compMatch[1]); }
                            const readCompRegex = /&\s*(?!mut\s)([A-Za-z0-9_]+)/g;
                            while ((compMatch = readCompRegex.exec(queryInner)) !== null) { readableComponents.push(compMatch[1]); }
                        }

                        const { docstring, firstLine } = getDocstring(i);
                        const type = inTestModule ? 'TestSystem' : 'System';
                        elements.push({
                            name: fnName,
                            type: type,
                            filePath,
                            line: i + 1,
                            description: firstLine || `${type} function`,
                            docstring: docstring || `Bevy system: ${fnName}\nSignature: \`${fullSignature.trim().replace(/\s+/g, ' ')}\``,
                            systemMetadata: {
                                mutableResources, readableResources, mutableComponents, readableComponents,
                                belongsToSets: [], runConditions: [], runsAfter: [], runsBefore: []
                            }
                        });
                    }
                }
            }

            // 4. 解析 Message
            if (lineContent.includes('Message')) {
                if (lineContent.includes('#[derive(')) {
                    const match = deriveRegex.exec(lineContent);
                    deriveRegex.lastIndex = 0;
                    if (match && match[1].split(',').map(d => d.trim()).includes('Message')) {
                        for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
                            const nextLine = lines[j].trim();
                            const structMatch = nextLine.match(/^(?:pub\s+)?(?:struct|enum)\s+([A-Za-z0-9_]+)/);
                            if (structMatch) {
                                const name = structMatch[1];
                                const { docstring, firstLine } = getDocstring(i);
                                elements.push({
                                    name, type: 'Message', filePath, line: j + 1,
                                    description: firstLine || 'Network or communication message',
                                    docstring: docstring || `Message structure: ${name}`
                                });
                                break;
                            }
                        }
                    }
                }
                const implMsgMatch = lineContent.match(/impl\s+(?:.*?\s+)?Message\s+for\s+([A-Za-z0-9_]+)/);
                if (implMsgMatch) {
                    const name = implMsgMatch[1];
                    const { docstring, firstLine } = getDocstring(i);
                    elements.push({
                        name, type: 'Message', filePath, line: i + 1,
                        description: firstLine || 'Message implementation',
                        docstring: docstring || `Implements Message trait for ${name}`
                    });
                }
            }
        }
    }

    /**
     * 解析 WGSL 着色器文件，分析 Uniform @binding 绑定关系
     */
    private static async parseShaderFileAsync(filePath: string, elements: BevyElement[]): Promise<void> {
        let content = '';
        try {
            content = await fs.promises.readFile(filePath, 'utf8');
        } catch {
            return;
        }

        const lines = content.split(/\r?\n/);
        const fileName = path.basename(filePath);

        const docLines: string[] = [];
        for (const line of lines) {
            const trimLine = line.trim();
            if (trimLine.startsWith('//')) {
                docLines.push(trimLine.substring(2).trim());
            } else if (trimLine === '') continue;
            else break;
        }

        const firstLine = docLines.length > 0 ? docLines[0] : '';
        const docstring = docLines.join('\n');

        const bindings: { binding: number; type: 'uniform' | 'texture' | 'sampler'; name: string }[] = [];
        const entryPoints: { name: string; type: 'vertex' | 'fragment' | 'compute'; workgroupSize?: string }[] = [];

        // 1. 匹配 Bindings 资源变量声明 (支持跨行和不同的@group/@binding顺序)
        const bindingRegex = /(?:@group\(\s*\d+\s*\)\s*@binding\(\s*(\d+)\s*\)|@binding\(\s*(\d+)\s*\)\s*@group\(\s*\d+\s*\))\s*var\s*(?:<\s*([a-zA-Z0-9_,\s]+)\s*>)?\s*([a-zA-Z0-9_]+)\s*:\s*([^;]+);/g;
        let bindingMatch;
        while ((bindingMatch = bindingRegex.exec(content)) !== null) {
            const bindingNumStr = bindingMatch[1] || bindingMatch[2];
            const bindingNum = parseInt(bindingNumStr);
            const varName = bindingMatch[4];
            const typeDecl = bindingMatch[5].trim();

            let bindingType: 'uniform' | 'texture' | 'sampler' = 'uniform';
            if (typeDecl.includes('texture')) {
                bindingType = 'texture';
            } else if (typeDecl.includes('sampler')) {
                bindingType = 'sampler';
            }

            bindings.push({
                binding: bindingNum,
                type: bindingType,
                name: varName
            });
        }

        // 2. 匹配 入口函数 Entry Points (支持跨行各种修饰器)
        const entryRegex = /(?:@[a-zA-Z0-9_]+(?:\([^\)]*\))?\s*)*@(vertex|fragment|compute)(?:\s*@[a-zA-Z0-9_]+(?:\([^\)]*\))?)*\s*fn\s+([a-zA-Z0-9_]+)/g;
        let entryMatch;
        while ((entryMatch = entryRegex.exec(content)) !== null) {
            const decoratorType = entryMatch[1] as 'vertex' | 'fragment' | 'compute';
            const fnName = entryMatch[2];
            const entireMatch = entryMatch[0];

            let workgroupSize: string | undefined;
            if (decoratorType === 'compute') {
                const sizeMatch = entireMatch.match(/@workgroup_size\s*\(([^\)]+)\)/);
                if (sizeMatch) {
                    workgroupSize = sizeMatch[1].trim();
                }
            }

            entryPoints.push({
                name: fnName,
                type: decoratorType,
                workgroupSize
            });
        }

        let finalDocstring = docstring || `WGSL shader asset located at ${fileName}.`;
        if (entryPoints.length > 0) {
            finalDocstring += `\n\n### 🚀 Entry Points\n`;
            for (const ep of entryPoints) {
                const wgStr = ep.workgroupSize ? ` (workgroup_size: \`${ep.workgroupSize}\`)` : '';
                finalDocstring += `* **@${ep.type}** -> \`fn ${ep.name}()\`${wgStr}\n`;
            }
        }

        elements.push({
            name: fileName,
            type: 'Shader',
            filePath,
            line: 1,
            description: firstLine || 'WGSL Shader file',
            docstring: finalDocstring,
            shaderMetadata: {
                bindings,
                entryPoints
            }
        });
    }
}
