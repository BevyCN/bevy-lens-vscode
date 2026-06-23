import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface BevyElement {
    name: string;
    type: 'Component' | 'Resource' | 'Event' | 'Message' | 'Plugin' | 'Shader' | 'Asset' | 'System' | 'State' | 'SystemParam' | 'Bundle' | 'SystemSet' | 'TestSystem' | 'TestComponent' | 'TestResource' | 'TestEvent' | 'TestSystemParam' | 'TestBundle' | 'TestSystemSet' | 'Observer' | 'TestObserver' | 'MainSystem' | 'RenderSystem' | 'TestMainSystem' | 'TestRenderSystem' | 'BSN' | 'TestBSN' | 'BSNList' | 'TestBSNList' | 'AppSettings' | 'TestAppSettings' | 'RenderGraph' | 'TestRenderGraph';
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

export interface BevyReference {
    sourceName: string;
    sourceType: 'System' | 'AppInit' | 'Observer' | 'Unknown';
    filePath: string;
    line: number;
    relationType: 'Init' | 'Create' | 'Read' | 'Write';
    details?: string;
}

export class BevyParser {
    private static parsedFilesCache = new Map<string, BevyElement[]>();
    private static addSystemsCache = new Map<string, Array<{ appName: string, phase: string, chainText: string, isRenderWorld: boolean }>>();
    private static addObserversCache = new Map<string, Array<{ chainText: string }>>();

    /**
     * 递归扫描指定目录下的文件，并提取 Bevy 语义元素
     */
    public static async parseWorkspace(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<BevyElement[]> {
        this.parsedFilesCache.clear();
        this.addSystemsCache.clear();
        this.addObserversCache.clear();

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
            const fileElements: BevyElement[] = [];
            if (ext === '.rs') {
                await this.parseRustFileAsync(filePath, fileElements);
            } else if (ext === '.wgsl' || ext === '.wesl') {
                await this.parseShaderFileAsync(filePath, fileElements);
            }
            this.parsedFilesCache.set(filePath, fileElements);
        });

        await Promise.all(parsePromises);

        return this.assembleElementsFromCache();
    }

    /**
     * 增量解析发生变化的文件，合并缓存并返回最新的 BevyElement[]
     */
    public static async updateIncremental(uris: readonly vscode.Uri[]): Promise<BevyElement[]> {
        for (const uri of uris) {
            const filePath = uri.fsPath;
            const ext = path.extname(filePath);

            // 如果文件已被删除，从缓存中清理
            if (!fs.existsSync(filePath)) {
                this.parsedFilesCache.delete(filePath);
                this.addSystemsCache.delete(filePath);
                this.addObserversCache.delete(filePath);
                continue;
            }

            const fileElements: BevyElement[] = [];
            if (ext === '.rs') {
                await this.parseRustFileAsync(filePath, fileElements);
            } else if (ext === '.wgsl' || ext === '.wesl') {
                await this.parseShaderFileAsync(filePath, fileElements);
            }
            this.parsedFilesCache.set(filePath, fileElements);
        }

        return this.assembleElementsFromCache();
    }

    /**
     * 从静态内存缓存中组装并克隆所有的 BevyElement，消除磁盘 I/O 并进行全局 link 后处理
     */
    private static assembleElementsFromCache(): BevyElement[] {
        const elements: BevyElement[] = [];

        // 1. 深克隆缓存中的元素以防在后处理中修改了缓存的源对象
        for (const cachedList of this.parsedFilesCache.values()) {
            for (const el of cachedList) {
                const cloned: BevyElement = {
                    ...el,
                    systemMetadata: el.systemMetadata ? {
                        ...el.systemMetadata,
                        belongsToSets: [...el.systemMetadata.belongsToSets],
                        runConditions: [...el.systemMetadata.runConditions],
                        runsAfter: [...el.systemMetadata.runsAfter],
                        runsBefore: [...el.systemMetadata.runsBefore]
                    } : undefined,
                    bindGroupMetadata: el.bindGroupMetadata ? {
                        bindings: el.bindGroupMetadata.bindings.map(b => ({ ...b }))
                    } : undefined,
                    shaderMetadata: el.shaderMetadata ? {
                        bindings: el.shaderMetadata.bindings.map(b => ({ ...b })),
                        entryPoints: el.shaderMetadata.entryPoints.map(ep => ({ ...ep }))
                    } : undefined
                };
                elements.push(cloned);
            }
        }

        // 2. 辅助缓存目录 -> crateName
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

        for (const element of elements) {
            element.crateName = getCrateName(element.filePath);
            element.sourceTarget = getSourceTarget(element.filePath);
        }

        // 3. 全局后处理：链接 add_systems (0 I/O 纯内存运行)
        const globalSystems = elements.filter(e => (e.type === 'System' || e.type === 'TestSystem' || e.type === 'MainSystem' || e.type === 'TestMainSystem' || e.type === 'RenderSystem' || e.type === 'TestRenderSystem' || e.type === 'RenderGraph' || e.type === 'TestRenderGraph'));

        const config = vscode.workspace.getConfiguration('bevyLens');
        const customSchedules = config.get<string[]>('customRenderGraphSchedules', []) || [];

        for (const [addSystemsFilePath, addSystemsList] of this.addSystemsCache.entries()) {
            const addSystemsCrate = getCrateName(addSystemsFilePath);

            for (const item of addSystemsList) {
                const phase = item.phase;
                const chainText = item.chainText;

                // 提取公共修饰文本
                let publicText = '';
                const trimmedChain = chainText.trim();
                if (trimmedChain.startsWith('(')) {
                    let depth = 0;
                    let matchIdx = -1;
                    for (let k = 0; k < chainText.length; k++) {
                        const char = chainText[k];
                        if (char === '(') {
                            depth++;
                        } else if (char === ')') {
                            depth--;
                            if (depth === 0) {
                                matchIdx = k;
                                break;
                            }
                        }
                    }
                    if (matchIdx !== -1) {
                        publicText = chainText.substring(matchIdx + 1);
                    }
                }

                for (const system of globalSystems) {
                    // 核心约束 1：必须在同一个 Crate 内，完全杜绝跨 Crate 同名误伤！
                    if (system.crateName !== addSystemsCrate) continue;

                    // 核心约束 2：文件局部优先原则，如果当前文件已经声明了同名的系统，那么简单标识符引用绝对不能污染其它文件内的同名系统！
                    const isSimpleIdentifier = !chainText.includes('::' + system.name) && !chainText.includes(system.name + '::');
                    if (isSimpleIdentifier && system.filePath !== addSystemsFilePath) {
                        const currentFileHasSameNameSystem = globalSystems.some(s => s.name === system.name && s.filePath === addSystemsFilePath);
                        if (currentFileHasSameNameSystem) {
                            continue;
                        }
                    }

                    // 使用精确单词边界匹配，避免如 system.name = 'draw' 匹配到 'cpu_draw' 或 'draw_gizmos' 导致的严重误命中
                    const wordRegex = new RegExp(`\\b${system.name}\\b`, 'g');
                    let wordMatch: RegExpExecArray | null;
                    
                    while ((wordMatch = wordRegex.exec(chainText)) !== null) {
                        if (!system.systemMetadata) continue;

                        // 从系统名后结束位置开始向后遍历，找到其专属的局部修饰链终止位置 (遇到逗号或外层右括号或分号终止)
                        const endIdx = wordMatch.index + system.name.length;
                        let localEndIdx = chainText.length;
                        let pDepth = 0;
                        for (let k = endIdx; k < chainText.length; k++) {
                            const char = chainText[k];
                            if (char === '(') {
                                pDepth++;
                            } else if (char === ')') {
                                if (pDepth > 0) {
                                    pDepth--;
                                } else {
                                    localEndIdx = k;
                                    break;
                                }
                            } else if (char === ',' && pDepth === 0) {
                                localEndIdx = k;
                                break;
                            } else if (char === ';' && pDepth === 0) {
                                localEndIdx = k;
                                break;
                            }
                        }

                        const localText = chainText.substring(endIdx, localEndIdx);
                        // 局部修饰文本与公共修饰文本拼接
                        const decoratorText = localText + ' ' + publicText;

                        system.systemMetadata.schedulePhase = phase;

                        // 渲染世界系统类型修正
                        if (item.isRenderWorld) {
                            if (system.type === 'MainSystem') {
                                system.type = 'RenderSystem';
                            } else if (system.type === 'TestMainSystem') {
                                system.type = 'TestRenderSystem';
                            }
                        }

                        // 新版 Render Graph 修正：如果系统运行在指定的 Core3d, Core2d 或自定义的渲染图阶段，则归类为 RenderGraph/TestRenderGraph
                        const isCore3dOr2d = phase === 'Core3d' || phase === 'Core2d' || phase.startsWith('Core3d::') || phase.startsWith('Core2d::') || customSchedules.includes(phase) || customSchedules.some(cs => phase.startsWith(cs + '::'));
                        if (isCore3dOr2d) {
                            if (system.type === 'MainSystem' || system.type === 'RenderSystem') {
                                system.type = 'RenderGraph';
                            } else if (system.type === 'TestMainSystem' || system.type === 'TestRenderSystem') {
                                system.type = 'TestRenderGraph';
                            }
                        }

                        const afterRegex = /\.after\(\s*([A-Za-z0-9_:]+)\s*\)/g;
                        let specMatch: RegExpExecArray | null;
                        while ((specMatch = afterRegex.exec(decoratorText)) !== null) { if (!system.systemMetadata.runsAfter.includes(specMatch[1])) system.systemMetadata.runsAfter.push(specMatch[1]); }
                        const beforeRegex = /\.before\(\s*([A-Za-z0-9_:]+)\s*\)/g;
                        while ((specMatch = beforeRegex.exec(decoratorText)) !== null) { if (!system.systemMetadata.runsBefore.includes(specMatch[1])) system.systemMetadata.runsBefore.push(specMatch[1]); }
                        const inSetRegex = /\.in_set\(\s*([A-Za-z0-9_:]+)\s*\)/g;
                        while ((specMatch = inSetRegex.exec(decoratorText)) !== null) { if (!system.systemMetadata.belongsToSets.includes(specMatch[1])) system.systemMetadata.belongsToSets.push(specMatch[1]); }
                        const runIfRegex = /\.run_if\(\s*([^)]+)\)/g;
                        while ((specMatch = runIfRegex.exec(decoratorText)) !== null) { if (!system.systemMetadata.runConditions.includes(specMatch[1])) system.systemMetadata.runConditions.push(specMatch[1]); }
                    }
                }

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
        }

        // 4. 全局后处理：链接 add_observer 并提取 run_if 条件
        const globalObservers = elements.filter(e => (e.type === 'Observer' || e.type === 'TestObserver'));
        for (const addObserversList of this.addObserversCache.values()) {
            for (const item of addObserversList) {
                const chainText = item.chainText;
                for (const observer of globalObservers) {
                    if (chainText.includes(observer.name) && observer.systemMetadata) {
                        const runIfRegex = /\.run_if\(\s*([^)]+)\)/g;
                        let specMatch: RegExpExecArray | null;
                        while ((specMatch = runIfRegex.exec(chainText)) !== null) {
                            if (!observer.systemMetadata.runConditions.includes(specMatch[1])) {
                                observer.systemMetadata.runConditions.push(specMatch[1]);
                            }
                        }
                    }
                }
            }
        }

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
        
        // 1. 扫描 RenderApp 子 App 变量定义
        const renderAppVars = new Set<string>();
        const subAppRegex = /let\s+(?:Ok|Some)?\(?\s*(?:mut\s+)?([A-Za-z0-9_]+)\s*\)?\s*=\s*[A-Za-z0-9_.]+\.(?:get_)?sub_app_mut\(\s*RenderApp\s*\)/g;
        let subAppMatch;
        while ((subAppMatch = subAppRegex.exec(content)) !== null) {
            renderAppVars.add(subAppMatch[1]);
        }

        // 2. 扫描 BSN / BSN List 宏定义，并向上寻找最近的 fn 绑定
        const bsnFunctions = new Map<string, 'bsn' | 'bsn_list'>();
        const bsnListRegex = /\bbsn_list!/g;
        let bsnListMatch;
        while ((bsnListMatch = bsnListRegex.exec(content)) !== null) {
            const index = bsnListMatch.index;
            const beforeContent = content.substring(0, index);
            const lineIndex = beforeContent.split('\n').length - 1;
            for (let k = lineIndex; k >= 0; k--) {
                const kLine = lines[k];
                const fnMatch = kLine.match(/(?:pub\s+)?fn\s+([A-Za-z0-9_]+)\s*\(/);
                if (fnMatch) {
                    bsnFunctions.set(fnMatch[1], 'bsn_list');
                    break;
                }
            }
        }

        const bsnRegex = /\bbsn!/g;
        let bsnMatch;
        while ((bsnMatch = bsnRegex.exec(content)) !== null) {
            const index = bsnMatch.index;
            const beforeContent = content.substring(0, index);
            const lineIndex = beforeContent.split('\n').length - 1;
            for (let k = lineIndex; k >= 0; k--) {
                const kLine = lines[k];
                const fnMatch = kLine.match(/(?:pub\s+)?fn\s+([A-Za-z0-9_]+)\s*\(/);
                if (fnMatch) {
                    if (!bsnFunctions.has(fnMatch[1])) {
                        bsnFunctions.set(fnMatch[1], 'bsn');
                    }
                    break;
                }
            }
        }
        
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

                        let hasSettingsGroup = false;
                        for (let m = i; m <= nextStructLine; m++) {
                            if (lines[m].includes('SettingsGroup')) {
                                hasSettingsGroup = true;
                                break;
                            }
                        }

                        for (const derive of derives) {
                            let type: BevyElement['type'] | null = null;
                            if (derive === 'Component') { type = inTestModule ? 'TestComponent' : 'Component'; }
                            else if (derive === 'Resource') {
                                type = hasSettingsGroup
                                    ? (inTestModule ? 'TestAppSettings' : 'AppSettings')
                                    : (inTestModule ? 'TestResource' : 'Resource');
                            }
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

            // 3. 解析 System 和 BSN
            if (lineContent.trim().startsWith('pub fn ') || lineContent.trim().startsWith('fn ')) {
                const fnMatch = lineContent.match(/(?:pub\s+)?fn\s+([A-Za-z0-9_]+)\s*\(/);
                if (fnMatch) {
                    const fnName = fnMatch[1];

                    // 优先检查是否为 BSN 宏关联函数
                    if (bsnFunctions.has(fnName)) {
                        const macroType = bsnFunctions.get(fnName);
                        const { docstring, firstLine } = getDocstring(i);
                        let type: BevyElement['type'];
                        if (macroType === 'bsn_list') {
                            type = inTestModule ? 'TestBSNList' : 'BSNList';
                        } else {
                            type = inTestModule ? 'TestBSN' : 'BSN';
                        }
                        elements.push({
                            name: fnName,
                            type: type,
                            filePath,
                            line: i + 1,
                            description: firstLine || `${macroType === 'bsn_list' ? 'BSN List' : 'BSN'} Scene definition`,
                            docstring: docstring || `${macroType === 'bsn_list' ? 'BSN List' : 'BSN'} Scene: ${fnName}`
                        });
                        continue;
                    }

                    let fullSignature = '';
                    for (let j = i; j < Math.min(lines.length, i + 10); j++) {
                        fullSignature += ' ' + lines[j].trim();
                        if (lines[j].includes('{') || lines[j].includes(')')) break;
                    }

                    const isObserver = /\(\s*(?:mut\s+)?(?:[A-Za-z0-9_]+)\s*:\s*On\s*</.test(fullSignature);

                    const hasBevyParams = 
                        isObserver ||
                        fullSignature.includes('Query<') || 
                        fullSignature.includes('Res<') || 
                        fullSignature.includes('ResMut<') || 
                        fullSignature.includes('Commands') || 
                        fullSignature.includes('EventReader<') || 
                        fullSignature.includes('EventWriter<') || 
                        fullSignature.includes('Local<') ||
                        fullSignature.includes('NonSend<') ||
                        fullSignature.includes('NonSendMut<') ||
                        fullSignature.includes('RenderContext');

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

                        // Components (from Query and filters)
                        const mutCompRegex = /&mut\s+([A-Za-z0-9_]+)/g;
                        while ((match = mutCompRegex.exec(fullSignature)) !== null) { mutableComponents.push(match[1]); }
                        
                        const readCompRegex = /&\s*(?!mut\s)([A-Za-z0-9_]+)/g;
                        while ((match = readCompRegex.exec(fullSignature)) !== null) { readableComponents.push(match[1]); }

                        const withRegex = /With<\s*([A-Za-z0-9_]+)\s*>/g;
                        while ((match = withRegex.exec(fullSignature)) !== null) { readableComponents.push(match[1]); }
                        
                        const withoutRegex = /Without<\s*([A-Za-z0-9_]+)\s*>/g;
                        while ((match = withoutRegex.exec(fullSignature)) !== null) { readableComponents.push(match[1]); }

                        const { docstring, firstLine } = getDocstring(i);
                        const isRenderGraph = fullSignature.includes('RenderContext');
                        const type = isObserver 
                            ? (inTestModule ? 'TestObserver' : 'Observer') 
                            : (isRenderGraph 
                                ? (inTestModule ? 'TestRenderGraph' : 'RenderGraph') 
                                : (inTestModule ? 'TestMainSystem' : 'MainSystem'));

                        elements.push({
                            name: fnName,
                            type: type,
                            filePath,
                            line: i + 1,
                            description: firstLine || `${type} function`,
                            docstring: docstring || `Bevy ${isObserver ? 'observer' : 'system'}: ${fnName}\nSignature: \`${fullSignature.trim().replace(/\s+/g, ' ')}\``,
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

        // 顺便提取并缓存此文件内的 add_systems 与 add_observer 调度配置，减少后续重复的磁盘读取
        const addSystems: Array<{ appName: string, phase: string, chainText: string, isRenderWorld: boolean }> = [];
        let searchIndex = 0;
        while (true) {
            const addSystemsMatch = content.indexOf('.add_systems', searchIndex);
            if (addSystemsMatch === -1) break;

            const startIdx = addSystemsMatch;
            searchIndex = startIdx + 12; // 越过 '.add_systems'

            // 寻找紧随其后的左括号 '('
            let leftParenIdx = content.indexOf('(', searchIndex);
            if (leftParenIdx === -1) continue;

            // 如果中间夹杂了非空白字符，说明可能不是函数调用，跳过
            const midText = content.substring(searchIndex, leftParenIdx).trim();
            if (midText.length > 0) {
                continue;
            }

            // 括号匹配算法
            let depth = 1;
            let currentIdx = leftParenIdx + 1;
            let foundMatch = false;
            while (currentIdx < content.length) {
                const char = content[currentIdx];
                if (char === '(') {
                    depth++;
                } else if (char === ')') {
                    depth--;
                    if (depth === 0) {
                        foundMatch = true;
                        break;
                    }
                }
                currentIdx++;
            }

            if (!foundMatch) continue;

            // 提取出整个括号内的参数文本
            const paramsText = content.substring(leftParenIdx + 1, currentIdx);
            searchIndex = currentIdx + 1; // 更新下次搜索起始点

            // 在最外层寻找第一个逗号
            let splitCommaIdx = -1;
            let pDepth = 0;
            for (let k = 0; k < paramsText.length; k++) {
                const char = paramsText[k];
                if (char === '(') pDepth++;
                else if (char === ')') pDepth--;
                else if (char === ',' && pDepth === 0) {
                    splitCommaIdx = k;
                    break;
                }
            }

            if (splitCommaIdx === -1) continue;

            const phase = paramsText.substring(0, splitCommaIdx).trim();
            const chainText = paramsText.substring(splitCommaIdx + 1).trim();

            // 寻找 stmtPrefix
            const beforeContent = content.substring(0, startIdx);
            const lastStmtTerminator = Math.max(
                beforeContent.lastIndexOf(';'),
                beforeContent.lastIndexOf('{'),
                beforeContent.lastIndexOf('}')
            );
            const stmtPrefix = lastStmtTerminator !== -1 
                ? beforeContent.substring(lastStmtTerminator + 1) 
                : beforeContent;

            const appNameMatch = stmtPrefix.trim().match(/^([A-Za-z0-9_]+)/);
            const appName = appNameMatch ? appNameMatch[1] : '';

            let isRenderWorld = stmtPrefix.includes('RenderApp');
            if (!isRenderWorld) {
                for (const renderVar of renderAppVars) {
                    const varWordRegex = new RegExp(`\\b${renderVar}\\b`);
                    if (varWordRegex.test(stmtPrefix)) {
                        isRenderWorld = true;
                        break;
                    }
                }
            }

            // 兜底判定：如果时间表(Schedule/Phase)是渲染时间表 Render，则属于渲染世界系统
            if (!isRenderWorld) {
                if (phase === 'Render' || phase.startsWith('Render::') || phase === 'ExtractSchedule' || phase.startsWith('ExtractSchedule::')) {
                    isRenderWorld = true;
                }
            }

            addSystems.push({
                appName,
                phase,
                chainText,
                isRenderWorld
            });
        }
        this.addSystemsCache.set(filePath, addSystems);

        const addObservers: Array<{ chainText: string }> = [];
        let obsSearchIdx = 0;
        while (true) {
            const addObserverMatch = content.indexOf('.add_observer', obsSearchIdx);
            if (addObserverMatch === -1) break;

            const startIdx = addObserverMatch;
            obsSearchIdx = startIdx + 13; // 越过 '.add_observer'

            let leftParenIdx = content.indexOf('(', obsSearchIdx);
            if (leftParenIdx === -1) continue;

            const midText = content.substring(obsSearchIdx, leftParenIdx).trim();
            if (midText.length > 0) {
                continue;
            }

            let depth = 1;
            let currentIdx = leftParenIdx + 1;
            let foundMatch = false;
            while (currentIdx < content.length) {
                const char = content[currentIdx];
                if (char === '(') {
                    depth++;
                } else if (char === ')') {
                    depth--;
                    if (depth === 0) {
                        foundMatch = true;
                        break;
                    }
                }
                currentIdx++;
            }

            if (!foundMatch) continue;

            const paramsText = content.substring(leftParenIdx + 1, currentIdx);
            obsSearchIdx = currentIdx + 1;

            addObservers.push({
                chainText: paramsText.trim()
            });
        }
        this.addObserversCache.set(filePath, addObservers);
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

    /**
     * Finds all references of a Bevy element (Component, Resource, Asset, etc.) in the workspace,
     * identifying if it is initialized, created/spawned, mutably written, or read.
     */
    public static async findReferences(targetName: string, targetType: string): Promise<BevyReference[]> {
        const references: BevyReference[] = [];

        // 1. Get all cached elements
        const elements = this.assembleElementsFromCache();

        // 2. Map existing metadata (Read/Write from system parameters)
        for (const el of elements) {
            const isSystemType = el.type === 'System' || el.type === 'MainSystem' || el.type === 'RenderSystem' || 
                                 el.type === 'TestSystem' || el.type === 'TestMainSystem' || el.type === 'TestRenderSystem' ||
                                 el.type === 'RenderGraph' || el.type === 'TestRenderGraph';
            const isObserverType = el.type === 'Observer' || el.type === 'TestObserver';

            if ((isSystemType || isObserverType) && el.systemMetadata) {
                const meta = el.systemMetadata;
                const sourceType = isObserverType ? 'Observer' : 'System';

                // Check Component / Resource reads & writes
                if (meta.mutableComponents.includes(targetName) || meta.mutableResources.includes(targetName)) {
                    references.push({
                        sourceName: el.name,
                        sourceType,
                        filePath: el.filePath,
                        line: el.line,
                        relationType: 'Write',
                        details: `Mutably accessed in signature`
                    });
                } else if (meta.readableComponents.includes(targetName) || meta.readableResources.includes(targetName)) {
                    references.push({
                        sourceName: el.name,
                        sourceType,
                        filePath: el.filePath,
                        line: el.line,
                        relationType: 'Read',
                        details: `Immutably accessed in signature`
                    });
                }
            }
        }

        // 3. Scan file contents in parallel to find spawn, insert, init_resource, insert_resource, EventReader/Writer, Observers triggers
        const filePaths = Array.from(this.parsedFilesCache.keys()).filter(fp => fp.endsWith('.rs'));
        const wordRegex = new RegExp(`\\b${targetName}\\b`);
        
        const processFile = async (filePath: string) => {
            let content = '';
            try {
                content = await fs.promises.readFile(filePath, 'utf8');
            } catch {
                return;
            }

            if (!content.includes(targetName)) {
                return;
            }

            if (!wordRegex.test(content)) {
                return;
            }

            const lines = content.split(/\r?\n/);

            // Let's first build a map of line ranges for functions/impls in this file
            // to associate code lines with their containing function/plugin
            const functionRanges: Array<{ name: string; type: 'System' | 'AppInit' | 'Observer' | 'Unknown'; startLine: number; endLine: number }> = [];
            
            // We can match functions from elements that belong to this file
            const fileElements = elements.filter(el => el.filePath === filePath);
            const systemsAndObservers = fileElements.filter(el => 
                el.type === 'System' || el.type === 'MainSystem' || el.type === 'RenderSystem' ||
                el.type === 'TestSystem' || el.type === 'TestMainSystem' || el.type === 'TestRenderSystem' ||
                el.type === 'RenderGraph' || el.type === 'TestRenderGraph' ||
                el.type === 'Observer' || el.type === 'TestObserver' ||
                el.type === 'Plugin'
            );

            // Approximate function end lines by looking at brace depth or next function
            const sortedFunctions = [...systemsAndObservers].sort((a, b) => a.line - b.line);
            for (let i = 0; i < sortedFunctions.length; i++) {
                const current = sortedFunctions[i];
                const startIdx = current.line - 1;
                // find end line by brace matching or next function start
                let endLine = lines.length;
                if (i < sortedFunctions.length - 1) {
                    endLine = sortedFunctions[i + 1].line - 1;
                }
                
                // Let's count braces to find actual end line if possible
                let braceCount = 0;
                let foundBrace = false;
                for (let l = startIdx; l < endLine; l++) {
                    const line = lines[l];
                    const openCount = (line.match(/\{/g) || []).length;
                    const closeCount = (line.match(/\}/g) || []).length;
                    if (openCount > 0) foundBrace = true;
                    braceCount += openCount - closeCount;
                    if (foundBrace && braceCount <= 0) {
                        endLine = l + 1;
                        break;
                    }
                }

                functionRanges.push({
                    name: current.name,
                    type: (current.type === 'Observer' || current.type === 'TestObserver') ? 'Observer' :
                          (current.type === 'Plugin' ? 'AppInit' : 'System'),
                    startLine: current.line,
                    endLine: endLine
                });
            }

            const getContainingFunction = (lineNum: number) => {
                for (const range of functionRanges) {
                    if (lineNum >= range.startLine && lineNum <= range.endLine) {
                        return range;
                    }
                }
                return null;
            };

            // Now scan line by line
            for (let idx = 0; idx < lines.length; idx++) {
                const lineContent = lines[idx];
                const lineNum = idx + 1;

                // Word boundary check for targetName
                if (!wordRegex.test(lineContent)) {
                    continue;
                }

                const containingFunc = getContainingFunction(lineNum);
                const sourceName = containingFunc ? containingFunc.name : 'Unknown';
                const sourceType = containingFunc ? containingFunc.type : 'Unknown';

                // Look for init_resource/insert_resource
                const initMatch = lineContent.match(/\.(init_resource|insert_resource|init_non_send_resource|insert_non_send_resource)/);
                if (initMatch) {
                    references.push({
                        sourceName: sourceName === 'Unknown' ? 'App' : sourceName,
                        sourceType: sourceType === 'Unknown' ? 'AppInit' : sourceType,
                        filePath,
                        line: lineNum,
                        relationType: 'Init',
                        details: `Initialized: \`${lineContent.trim()}\``
                    });
                    continue;
                }

                // Look for spawn / insert Component
                // Look for spawn / insert Component or remove
                const spawnMatch = lineContent.match(/\.(spawn|insert|spawn_empty)\(/);
                const removeMatch = lineContent.match(/\.(remove|remove_resource)::</);
                if (spawnMatch || removeMatch) {
                    references.push({
                        sourceName,
                        sourceType: sourceType === 'Unknown' ? 'System' : sourceType,
                        filePath,
                        line: lineNum,
                        relationType: spawnMatch ? 'Create' : 'Write',
                        details: spawnMatch ? `Inserted/Created: \`${lineContent.trim()}\`` : `Removed: \`${lineContent.trim()}\``
                    });
                    continue;
                }

                // Event reader/writer/trigger in parameters signature that were not caught by systemMetadata
                if (targetType === 'Event') {
                    if (lineContent.includes(`EventReader<`) || lineContent.includes(`Trigger<`) || lineContent.includes(`On<`)) {
                        // verify it's not already added
                        const exists = references.some(r => r.filePath === filePath && r.line === lineNum);
                        if (!exists) {
                            references.push({
                                sourceName,
                                sourceType: sourceType === 'Unknown' ? 'System' : sourceType,
                                filePath,
                                line: lineNum,
                                relationType: 'Read',
                                details: `Event/Trigger reader signature: \`${lineContent.trim()}\``
                            });
                        }
                        continue;
                    }
                    if (lineContent.includes(`EventWriter<`)) {
                        const exists = references.some(r => r.filePath === filePath && r.line === lineNum);
                        if (!exists) {
                            references.push({
                                sourceName,
                                sourceType: sourceType === 'Unknown' ? 'System' : sourceType,
                                filePath,
                                line: lineNum,
                                relationType: 'Write',
                                details: `Event writer signature: \`${lineContent.trim()}\``
                            });
                        }
                        continue;
                    }
                }
            }
        };
        
        const CHUNK_SIZE = 50;
        for (let i = 0; i < filePaths.length; i += CHUNK_SIZE) {
            const chunk = filePaths.slice(i, i + CHUNK_SIZE);
            await Promise.all(chunk.map(processFile));
        }

        // Deduplicate references based on filePath, line, and relationType
        const uniqueRefs: BevyReference[] = [];
        const seen = new Set<string>();
        for (const ref of references) {
            const key = `${ref.filePath}:${ref.line}:${ref.relationType}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueRefs.push(ref);
            }
        }

        return uniqueRefs;
    }
}
