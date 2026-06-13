import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BevyElement } from './bevyParser';

// ==========================================
// 0. 辅助函数：构建精美富文本提示 tooltip
// ==========================================
function buildElementTooltip(element: BevyElement, elementErrors: vscode.Diagnostic[]): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;

    // 区分诊断中的错误和警告
    const errors = elementErrors.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
    const warnings = elementErrors.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);

    let errorTag = '';
    if (errors.length > 0) {
        errorTag = ' 🔴';
    } else if (warnings.length > 0) {
        errorTag = ' 🟡';
    }

    markdown.appendMarkdown(`### **${element.name}** \`[${element.type}]\`${errorTag}\n\n`);
    markdown.appendMarkdown(`* **文件**: \`${path.basename(element.filePath)}\` (行 ${element.line})\n\n`);

    // System 调度与访问分析展示
    if (element.type === 'System' && element.systemMetadata) {
        const meta = element.systemMetadata;
        markdown.appendMarkdown(`---\n\n`);
        markdown.appendMarkdown(`#### ⚙️ **System Schedule & Bounds**\n`);
        if (meta.schedulePhase) {
            markdown.appendMarkdown(`* **运行阶段 (Stage)**: \`${meta.schedulePhase}\`\n`);
        }
        if (meta.belongsToSets.length > 0) {
            markdown.appendMarkdown(`* **属于系统集 (SystemSets)**: ${meta.belongsToSets.map(s => `\`${s}\``).join(', ')}\n`);
        }
        if (meta.runsAfter.length > 0) {
            markdown.appendMarkdown(`* **在其后运行 (After)**: ${meta.runsAfter.map(s => `\`${s}\``).join(', ')}\n`);
        }
        if (meta.runsBefore.length > 0) {
            markdown.appendMarkdown(`* **在其前运行 (Before)**: ${meta.runsBefore.map(s => `\`${s}\``).join(', ')}\n`);
        }
        if (meta.runConditions.length > 0) {
            markdown.appendMarkdown(`* **运行条件 (Run Conditions)**: \`${meta.runConditions.join(' && ')}\`\n`);
        }

        markdown.appendMarkdown(`\n#### 📊 **数据访问签名 (Data Access)**\n`);
        if (meta.mutableResources.length > 0) {
            markdown.appendMarkdown(`* **写资源 (Mut Res)**: ${meta.mutableResources.map(r => `\`${r}\``).join(', ')}\n`);
        }
        if (meta.readableResources.length > 0) {
            markdown.appendMarkdown(`* **读资源 (Res)**: ${meta.readableResources.map(r => `\`${r}\``).join(', ')}\n`);
        }
        if (meta.mutableComponents.length > 0) {
            markdown.appendMarkdown(`* **写组件 (Mut Comp)**: ${meta.mutableComponents.map(c => `\`${c}\``).join(', ')}\n`);
        }
        if (meta.readableComponents.length > 0) {
            markdown.appendMarkdown(`* **读组件 (Comp)**: ${meta.readableComponents.map(c => `\`${c}\``).join(', ')}\n`);
        }
        markdown.appendMarkdown(`\n`);
    }

    // BindGroup (Material / Shader) 绑定分析展示
    if (element.bindGroupMetadata) {
        markdown.appendMarkdown(`---\n\n`);
        markdown.appendMarkdown(`#### 🎨 **BindGroup Uniforms**\n`);
        element.bindGroupMetadata.bindings.forEach(b => {
            markdown.appendMarkdown(`* \`@binding(${b.binding})\` **${b.type}** -> \`${b.name}\`\n`);
        });
        markdown.appendMarkdown('\n');
    }

    // Shader Uniforms & Entry Points 元数据展示
    if (element.shaderMetadata) {
        markdown.appendMarkdown(`---\n\n`);
        if (element.shaderMetadata.bindings.length > 0) {
            markdown.appendMarkdown(`#### 🎨 **Shader Bindings**\n`);
            element.shaderMetadata.bindings.forEach(b => {
                markdown.appendMarkdown(`* \`@binding(${b.binding})\` **${b.type}** -> \`${b.name}\`\n`);
            });
            markdown.appendMarkdown('\n');
        }
        if (element.shaderMetadata.entryPoints.length > 0) {
            markdown.appendMarkdown(`#### 🚀 **Shader Entry Points**\n`);
            element.shaderMetadata.entryPoints.forEach(ep => {
                const wg = ep.workgroupSize ? ` (workgroup_size: \`${ep.workgroupSize}\`)` : '';
                markdown.appendMarkdown(`* **@${ep.type}** -> \`fn ${ep.name}()\`${wg}\n`);
            });
            markdown.appendMarkdown('\n');
        }
    }

    markdown.appendMarkdown(`---\n\n`);

    // 展示语法诊断警告/错误
    if (elementErrors.length > 0) {
        markdown.appendMarkdown(`> ⚠️ **LSP & Concurrency Diagnostics**:\n`);
        elementErrors.forEach(err => {
            const icon = err.severity === vscode.DiagnosticSeverity.Error ? '❌' : '⚠️';
            markdown.appendMarkdown(`> * ${icon} \`${err.message.trim()}\`\n`);
        });
        markdown.appendMarkdown(`\n---\n\n`);
    }

    markdown.appendMarkdown(element.docstring || '*No documentation description provided.*');
    return markdown;
}

// ==========================================
// 1. 全局资源管理器 TreeDataProvider (Global Registry)
// ==========================================

export class RegistryCategory {
    constructor(
        public readonly label: string,
        public readonly type: BevyElement['type'],
        public readonly icon: string
    ) {}
}

export class CrateCategory {
    constructor(
        public readonly crateName: string,
        public readonly parentCategory: RegistryCategory
    ) {}
}

export type RegistryNode = RegistryCategory | CrateCategory | BevyElement;

export class BevyGlobalRegistryProvider implements vscode.TreeDataProvider<RegistryNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<RegistryNode | undefined | null | void> = new vscode.EventEmitter<RegistryNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<RegistryNode | undefined | null | void> = this._onDidChangeTreeData.event;

    private elements: BevyElement[] = [];
    private filterText: string = '';
    private includesKeywords: string[] = [];
    private excludesKeywords: string[] = [];

    constructor(private readonly context: vscode.ExtensionContext) {}

    public updateData(elements: BevyElement[]) {
        this.elements = elements;
        this.refresh();
    }

    public setSearchFilter(filter: string) {
        this.filterText = filter.trim();
        this.includesKeywords = [];
        this.excludesKeywords = [];

        if (this.filterText) {
            const tokens = this.filterText.split(/\s+/).filter(Boolean);
            for (const token of tokens) {
                if (token.startsWith('!') && token.length > 1) {
                    this.excludesKeywords.push(token.substring(1).toLowerCase());
                } else {
                    this.includesKeywords.push(token.toLowerCase());
                }
            }
        }
        this.refresh();
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: RegistryNode): vscode.TreeItem {
        if (element instanceof RegistryCategory) {
            const items = this.getFilteredElementsByType(element.type);
            const item = new vscode.TreeItem(
                `${element.label} (${items.length})`,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            item.contextValue = 'category';
            item.iconPath = new vscode.ThemeIcon(element.icon);
            return item;
        } else if (element instanceof CrateCategory) {
            const items = this.getFilteredElementsByTypeAndCrate(element.parentCategory.type, element.crateName);
            const item = new vscode.TreeItem(
                `${element.crateName} (${items.length})`,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            item.contextValue = 'crateCategory';
            item.iconPath = new vscode.ThemeIcon('package', new vscode.ThemeColor('charts.purple'));
            return item;
        } else {
            // 检查全局注册表中的元素其所在文件是否有编译错误
            const fileUri = vscode.Uri.file(element.filePath);
            const diagnostics = vscode.languages.getDiagnostics(fileUri);
            
            // 精准判定该元素所在行附近是否存在语法错误
            const lineIndex = element.line - 1;
            const elementErrors = diagnostics.filter(d => 
                d.severity === vscode.DiagnosticSeverity.Error && 
                d.range.start.line <= lineIndex && lineIndex <= d.range.end.line
            );
            const elementWarnings = diagnostics.filter(d => 
                d.severity === vscode.DiagnosticSeverity.Warning && 
                d.range.start.line <= lineIndex && lineIndex <= d.range.end.line
            );

            let errorTag = '';
            if (elementErrors.length > 0) {
                errorTag = ' 🔴';
            } else if (elementWarnings.length > 0) {
                errorTag = ' 🟡';
            }

            const item = new vscode.TreeItem(element.name + errorTag, vscode.TreeItemCollapsibleState.None);
            item.description = element.description;
            
            // 借助辅助函数构建精美的富文本 Markdown 悬停提示
            item.tooltip = buildElementTooltip(element, [...elementErrors, ...elementWarnings]);

            // 设置对应的图标
            item.iconPath = this.getElementIcon(element.type);
            item.contextValue = 'bevyElement';

            // 点击命令：定位至代码行
            item.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [
                    fileUri,
                    {
                        selection: new vscode.Range(
                            new vscode.Position(lineIndex, 0),
                            new vscode.Position(lineIndex, 0)
                        )
                    }
                ]
            };

            return item;
        }
    }

    getChildren(element?: RegistryNode): vscode.ProviderResult<RegistryNode[]> {
        if (!element) {
            // 根分类节点
            return [
                new RegistryCategory('Components', 'Component', 'symbol-structure'),
                new RegistryCategory('Bundles', 'Bundle', 'library'),
                new RegistryCategory('Resources', 'Resource', 'database'),
                new RegistryCategory('Events', 'Event', 'zap'),
                new RegistryCategory('States', 'State', 'symbol-enum'),
                new RegistryCategory('System Params', 'SystemParam', 'list-unordered'),
                new RegistryCategory('System Sets', 'SystemSet', 'symbol-namespace'),
                new RegistryCategory('Messages', 'Message', 'mail'),
                new RegistryCategory('Plugins', 'Plugin', 'plug'),
                new RegistryCategory('Shaders', 'Shader', 'paintcan'),
                new RegistryCategory('Assets', 'Asset', 'package'),
                new RegistryCategory('Systems', 'System', 'gear'),
                // 新增测试分类
                new RegistryCategory('Test Systems', 'TestSystem', 'beaker'),
                new RegistryCategory('Test ECS Types', 'TestComponent', 'package'),
                new RegistryCategory('Test Logic & Bounds', 'TestEvent', 'pulse')
            ];
        }

        if (element instanceof RegistryCategory) {
            const elements = this.getFilteredElementsByType(element.type);
            const crateNames = Array.from(new Set(elements.map(e => e.crateName || 'unknown'))).sort();
            
            // 如果仅有一个 crate 或是未定义，可以考虑直接显示元素，但为了层级一致性，我们始终显示 Crate 级别
            return crateNames.map(crate => new CrateCategory(crate, element));
        }

        if (element instanceof CrateCategory) {
            return this.getFilteredElementsByTypeAndCrate(element.parentCategory.type, element.crateName);
        }

        return [];
    }

    private getFilteredElementsByTypeAndCrate(type: BevyElement['type'], crateName: string): BevyElement[] {
        return this.getFilteredElementsByType(type).filter(e => (e.crateName || 'unknown') === crateName);
    }

    private getFilteredElementsByType(type: BevyElement['type']): BevyElement[] {
        return this.elements.filter(e => {
            if (type === 'TestComponent') {
                // 汇总测试 ECS 概念
                if (e.type !== 'TestComponent' && e.type !== 'TestResource' && e.type !== 'TestBundle' && e.type !== 'TestSystemParam') {
                    return false;
                }
            } else if (type === 'TestEvent') {
                // 汇总测试事件和系统集
                if (e.type !== 'TestEvent' && e.type !== 'TestSystemSet') {
                    return false;
                }
            } else {
                if (e.type !== type) { return false; }
            }

            if (this.filterText) {
                const nameLower = e.name.toLowerCase();
                const descLower = e.description.toLowerCase();

                // 检查是否包含所有包括的关键词
                for (const kw of this.includesKeywords) {
                    if (!nameLower.includes(kw) && !descLower.includes(kw)) {
                        return false;
                    }
                }

                // 检查是否包含任何排除的关键词
                for (const kw of this.excludesKeywords) {
                    if (nameLower.includes(kw) || descLower.includes(kw)) {
                        return false;
                    }
                }
            }
            return true;
        });
    }

    private getElementIcon(type: BevyElement['type']): vscode.ThemeIcon {
        switch (type) {
            case 'Component': return new vscode.ThemeIcon('symbol-structure', new vscode.ThemeColor('charts.green'));
            case 'Bundle': return new vscode.ThemeIcon('library', new vscode.ThemeColor('charts.green'));
            case 'Resource': return new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.blue'));
            case 'Event': return new vscode.ThemeIcon('zap', new vscode.ThemeColor('charts.orange'));
            case 'State': return new vscode.ThemeIcon('symbol-enum', new vscode.ThemeColor('charts.purple'));
            case 'SystemParam': return new vscode.ThemeIcon('list-unordered', new vscode.ThemeColor('charts.blue'));
            case 'SystemSet': return new vscode.ThemeIcon('symbol-namespace', new vscode.ThemeColor('charts.orange'));
            case 'TestSystem': return new vscode.ThemeIcon('beaker', new vscode.ThemeColor('charts.purple'));
            case 'TestComponent': return new vscode.ThemeIcon('symbol-structure', new vscode.ThemeColor('charts.yellow'));
            case 'TestResource': return new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.yellow'));
            case 'TestBundle': return new vscode.ThemeIcon('library', new vscode.ThemeColor('charts.yellow'));
            case 'TestSystemParam': return new vscode.ThemeIcon('list-unordered', new vscode.ThemeColor('charts.yellow'));
            case 'TestEvent': return new vscode.ThemeIcon('zap', new vscode.ThemeColor('charts.yellow'));
            case 'TestSystemSet': return new vscode.ThemeIcon('symbol-namespace', new vscode.ThemeColor('charts.yellow'));
            case 'Message': return new vscode.ThemeIcon('mail', new vscode.ThemeColor('charts.yellow'));
            case 'Plugin': return new vscode.ThemeIcon('plug', new vscode.ThemeColor('charts.purple'));
            case 'Shader': return new vscode.ThemeIcon('paintcan', new vscode.ThemeColor('charts.red'));
            case 'Asset': return new vscode.ThemeIcon('package', new vscode.ThemeColor('charts.foreground'));
            case 'System': return new vscode.ThemeIcon('gear', new vscode.ThemeColor('debugIcon.startForeground'));
            default: return new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.foreground'));
        }
    }
}


// ==========================================
// 2. Bevy 语义化目录树 TreeDataProvider (Semantic Explorer)
// ==========================================

export class ExplorerNode {
    constructor(
        public readonly key: string, // 唯一标识，若是文件/文件夹则是 fsPath，若是元素则是 `fsPath:name:type`
        public readonly label: string,
        public readonly kind: 'directory' | 'file' | 'element',
        public readonly fsPath: string,
        public readonly elementData?: BevyElement
    ) {}
}

export class BevySemanticExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<ExplorerNode | undefined | null | void> = new vscode.EventEmitter<ExplorerNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ExplorerNode | undefined | null | void> = this._onDidChangeTreeData.event;

    private elements: BevyElement[] = [];
    private workspaceRoot: string = '';
    private nodeMap: Map<string, ExplorerNode> = new Map(); // 用于实现 getParent

    constructor(private readonly context: vscode.ExtensionContext) {}

    public updateData(elements: BevyElement[], workspaceRoot: string) {
        this.elements = elements;
        this.workspaceRoot = workspaceRoot;
        this.nodeMap.clear();
        this.refresh();
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    // 根据文件路径找到 Tree 中的 ExplorerNode 节点，以便在编辑器打开时 Reveal
    public findFileNode(filePath: string): ExplorerNode | undefined {
        let node = this.nodeMap.get(filePath);
        if (!node) {
            // 如果缓存中暂时没有，为了能成功 reveal，主动动态构建节点树缓存
            const ext = path.extname(filePath);
            if (ext === '.rs' || ext === '.wgsl' || ext === '.wesl') {
                node = new ExplorerNode(filePath, path.basename(filePath), 'file', filePath);
                this.nodeMap.set(filePath, node);
            }
        }
        return node;
    }

    getTreeItem(node: ExplorerNode): vscode.TreeItem {
        const ext = path.extname(node.fsPath);
        const isBevyFile = ext === '.rs' || ext === '.wgsl' || ext === '.wesl';

        const item = new vscode.TreeItem(
            node.label,
            node.kind === 'element' 
                ? vscode.TreeItemCollapsibleState.None 
                : (node.kind === 'file' && !isBevyFile 
                    ? vscode.TreeItemCollapsibleState.None 
                    : vscode.TreeItemCollapsibleState.Collapsed)
        );

        if (node.kind === 'directory') {
            item.contextValue = 'directory';
            item.resourceUri = vscode.Uri.file(node.fsPath);
            // 目录依然使用 VS Code 自动配的文件夹图标
        } else if (node.kind === 'file') {
            item.contextValue = 'file';
            item.resourceUri = vscode.Uri.file(node.fsPath);

            // ✨【关键修复】✨
            // 因为本文件节点是可折叠结构 (Collapsed)，VS Code 默认强制展示为文件夹图标。
            // 我们通过直接为 item.iconPath 赋值我们在 resources/ 中打包的 Rust/WGSL 专属 SVG 图标路径，
            // 成功覆盖掉 VS Code 文件夹图标的强制设定，让它既能展开，又显示为正确的 Rust 螃蟹图标！
            const ext = path.extname(node.fsPath);
            if (ext === '.rs') {
                item.iconPath = vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'rust.svg'));
            } else if (ext === '.wgsl' || ext === '.wesl') {
                item.iconPath = vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'wgsl.svg'));
            }

            // 读取 rust-analyzer 的诊断报错情况
            const fileUri = vscode.Uri.file(node.fsPath);
            const diagnostics = vscode.languages.getDiagnostics(fileUri);
            const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
            const warnings = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);

            let statusTag = '';
            if (errors.length > 0) {
                statusTag = ` 🔴 ${errors.length} Errors`;
            } else if (warnings.length > 0) {
                statusTag = ` 🟡 ${warnings.length} Warnings`;
            }

            const fileElements = this.elements.filter(e => e.filePath === node.fsPath);
            const descParts: string[] = [];
            if (fileElements.length > 0) {
                descParts.push(`${fileElements.length} elements`);
            }
            if (statusTag) {
                descParts.push(statusTag);
            }
            if (descParts.length > 0) {
                item.description = `[${descParts.join(' | ')}]`;
            }

            // 在文件悬停 tooltip 中展示编译错误概览
            const markdown = new vscode.MarkdownString();
            markdown.appendMarkdown(`### **${node.label}**\n\n`);
            if (errors.length > 0) {
                markdown.appendMarkdown(`#### ❌ **语法错误 (${errors.length})**:\n`);
                errors.slice(0, 5).forEach(err => {
                    markdown.appendMarkdown(`* [行 ${err.range.start.line + 1}]: \`${err.message.trim()}\`\n`);
                });
                markdown.appendMarkdown(`\n---\n`);
            }
            if (warnings.length > 0) {
                markdown.appendMarkdown(`#### ⚠️ **警告 (${warnings.length})**:\n`);
                warnings.slice(0, 5).forEach(warn => {
                    markdown.appendMarkdown(`* [行 ${warn.range.start.line + 1}]: \`${warn.message.trim()}\`\n`);
                });
                markdown.appendMarkdown(`\n---\n`);
            }
            markdown.appendMarkdown(`* 物理路径: \`${node.fsPath}\``);
            item.tooltip = markdown;

            // 让文件本身支持点击命令直接打开
            item.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [fileUri]
            };

        } else if (node.kind === 'element' && node.elementData) {
            const el = node.elementData;
            const fileUri = vscode.Uri.file(el.filePath);
            const diagnostics = vscode.languages.getDiagnostics(fileUri);
            
            // 检查具体这一行是否有 Diagnostics
            const lineIndex = el.line - 1;
            const elementErrors = diagnostics.filter(d => 
                d.severity === vscode.DiagnosticSeverity.Error && 
                d.range.start.line <= lineIndex && lineIndex <= d.range.end.line
            );
            const elementWarnings = diagnostics.filter(d => 
                d.severity === vscode.DiagnosticSeverity.Warning && 
                d.range.start.line <= lineIndex && lineIndex <= d.range.end.line
            );

            let statusTag = '';
            if (elementErrors.length > 0) {
                statusTag = ' 🔴';
            } else if (elementWarnings.length > 0) {
                statusTag = ' 🟡';
            }

            item.label = node.label + statusTag;
            item.description = el.description;
            
            // 借助辅助函数构建精美的富文本 Markdown 悬停提示
            item.tooltip = buildElementTooltip(el, [...elementErrors, ...elementWarnings]);

            // 图标与 tag (对于叶子节点元素，不需要图标主题，仍用 Bevy 语义专属彩标)
            item.iconPath = this.getElementIcon(el.type);
            item.contextValue = 'bevyElement';

            // 点击直接跳转
            item.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [
                    fileUri,
                    {
                        selection: new vscode.Range(
                            new vscode.Position(lineIndex, 0),
                            new vscode.Position(lineIndex, 0)
                        )
                    }
                ]
            };
        }

        return item;
    }

    getParent(node: ExplorerNode): vscode.ProviderResult<ExplorerNode> {
        if (node.kind === 'element') {
            // 恢复真实的父子结构：元素的父节点是它所属的文件节点！
            let parentNode = this.nodeMap.get(node.fsPath);
            if (!parentNode) {
                parentNode = new ExplorerNode(node.fsPath, path.basename(node.fsPath), 'file', node.fsPath);
                this.nodeMap.set(node.fsPath, parentNode);
            }
            return parentNode;
        } else {
            // 文件/文件夹的父节点是其父级物理目录
            const parentDir = path.dirname(node.fsPath);
            if (parentDir.startsWith(this.workspaceRoot) && parentDir !== this.workspaceRoot) {
                let parentNode = this.nodeMap.get(parentDir);
                if (!parentNode) {
                    parentNode = new ExplorerNode(parentDir, path.basename(parentDir), 'directory', parentDir);
                    this.nodeMap.set(parentDir, parentNode);
                }
                return parentNode;
            }
        }
        return undefined;
    }

    getChildren(node?: ExplorerNode): vscode.ProviderResult<ExplorerNode[]> {
        if (!this.workspaceRoot) {
            return [];
        }

        const currentPath = node ? node.fsPath : this.workspaceRoot;

        // 如果节点是 element，没有子节点
        if (node && node.kind === 'element') {
            return [];
        }

        // 如果节点是 file，返回该文件下的 Bevy 元素子节点（重新回归折叠树状层级！）
        if (node && node.kind === 'file') {
            const fileElements = this.elements.filter(e => e.filePath === currentPath);
            return fileElements.map(el => {
                const key = `${el.filePath}:${el.name}:${el.type}`;
                // 恢复默认的名称，不需要空格缩进了（因为现在是标准的展开结构了）
                const elNode = new ExplorerNode(key, el.name, 'element', el.filePath, el);
                this.nodeMap.set(key, elNode);
                return elNode;
            });
        }

        // 否则当前节点是目录，读取物理目录下的子目录和子文件
        let items: string[] = [];
        try {
            items = fs.readdirSync(currentPath);
        } catch {
            return [];
        }

        const dirs: ExplorerNode[] = [];
        const files: ExplorerNode[] = [];

        for (const item of items) {
            if (item === 'target' || item === '.git' || item === 'node_modules') {
                continue;
            }

            const fullPath = path.join(currentPath, item);
            let stat: fs.Stats;
            try {
                stat = fs.statSync(fullPath);
            } catch {
                continue;
            }

            if (stat.isDirectory()) {
                const dirNode = new ExplorerNode(fullPath, item, 'directory', fullPath);
                this.nodeMap.set(fullPath, dirNode);
                dirs.push(dirNode);
            } else if (stat.isFile()) {
                const fileNode = new ExplorerNode(fullPath, item, 'file', fullPath);
                this.nodeMap.set(fullPath, fileNode);
                files.push(fileNode);
            }
        }

        // 排序：目录在前，文件在后
        dirs.sort((a, b) => a.label.localeCompare(b.label));
        files.sort((a, b) => a.label.localeCompare(b.label));

        return [...dirs, ...files];
    }

    private getElementIcon(type: BevyElement['type']): vscode.ThemeIcon {
        switch (type) {
            case 'Component': return new vscode.ThemeIcon('symbol-structure', new vscode.ThemeColor('charts.green'));
            case 'Bundle': return new vscode.ThemeIcon('library', new vscode.ThemeColor('charts.green'));
            case 'Resource': return new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.blue'));
            case 'Event': return new vscode.ThemeIcon('zap', new vscode.ThemeColor('charts.orange'));
            case 'State': return new vscode.ThemeIcon('symbol-enum', new vscode.ThemeColor('charts.purple'));
            case 'SystemParam': return new vscode.ThemeIcon('list-unordered', new vscode.ThemeColor('charts.blue'));
            case 'SystemSet': return new vscode.ThemeIcon('symbol-namespace', new vscode.ThemeColor('charts.orange'));
            case 'TestSystem': return new vscode.ThemeIcon('beaker', new vscode.ThemeColor('charts.purple'));
            case 'TestComponent': return new vscode.ThemeIcon('symbol-structure', new vscode.ThemeColor('charts.yellow'));
            case 'TestResource': return new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.yellow'));
            case 'TestBundle': return new vscode.ThemeIcon('library', new vscode.ThemeColor('charts.yellow'));
            case 'TestSystemParam': return new vscode.ThemeIcon('list-unordered', new vscode.ThemeColor('charts.yellow'));
            case 'TestEvent': return new vscode.ThemeIcon('zap', new vscode.ThemeColor('charts.yellow'));
            case 'TestSystemSet': return new vscode.ThemeIcon('symbol-namespace', new vscode.ThemeColor('charts.yellow'));
            case 'Message': return new vscode.ThemeIcon('mail', new vscode.ThemeColor('charts.yellow'));
            case 'Plugin': return new vscode.ThemeIcon('plug', new vscode.ThemeColor('charts.purple'));
            case 'Shader': return new vscode.ThemeIcon('paintcan', new vscode.ThemeColor('charts.red'));
            case 'Asset': return new vscode.ThemeIcon('package', new vscode.ThemeColor('charts.foreground'));
            case 'System': return new vscode.ThemeIcon('gear', new vscode.ThemeColor('debugIcon.startForeground'));
            default: return new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.foreground'));
        }
    }
}
