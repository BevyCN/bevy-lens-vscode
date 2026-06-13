import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BevyElement } from './bevyParser';

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

export type RegistryNode = RegistryCategory | BevyElement;

export class BevyGlobalRegistryProvider implements vscode.TreeDataProvider<RegistryNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<RegistryNode | undefined | null | void> = new vscode.EventEmitter<RegistryNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<RegistryNode | undefined | null | void> = this._onDidChangeTreeData.event;

    private elements: BevyElement[] = [];
    private filterText: string = '';

    constructor(private readonly context: vscode.ExtensionContext) {}

    public updateData(elements: BevyElement[]) {
        this.elements = elements;
        this.refresh();
    }

    public setSearchFilter(filter: string) {
        this.filterText = filter.toLowerCase().trim();
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
            
            // 构建富文本 Markdown 悬停提示
            const markdown = new vscode.MarkdownString();
            markdown.appendMarkdown(`### **${element.name}** \`[${element.type}]\`${errorTag}\n\n`);
            markdown.appendMarkdown(`* **文件**: \`${path.basename(element.filePath)}\` (行 ${element.line})\n\n`);
            markdown.appendMarkdown(`---\n\n`);

            // 如果本元素有编译错误，悬停时直接将报错信息高亮提示
            if (elementErrors.length > 0) {
                markdown.appendMarkdown(`> ❌ **LSP 语法错误诊断**:\n`);
                elementErrors.forEach(err => {
                    markdown.appendMarkdown(`> * \`${err.message.trim()}\`\n`);
                });
                markdown.appendMarkdown(`\n---\n\n`);
            }

            markdown.appendMarkdown(element.docstring || '*无可用注释描述*');
            item.tooltip = markdown;

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
                new RegistryCategory('Resources', 'Resource', 'database'),
                new RegistryCategory('Events', 'Event', 'zap'),
                new RegistryCategory('Messages', 'Message', 'mail'),
                new RegistryCategory('Plugins', 'Plugin', 'plug'),
                new RegistryCategory('Shaders', 'Shader', 'paintcan'),
                new RegistryCategory('Assets', 'Asset', 'package'),
                new RegistryCategory('Systems', 'System', 'gear')
            ];
        }

        if (element instanceof RegistryCategory) {
            return this.getFilteredElementsByType(element.type);
        }

        return [];
    }

    private getFilteredElementsByType(type: BevyElement['type']): BevyElement[] {
        return this.elements.filter(e => {
            if (e.type !== type) { return false; }
            if (this.filterText) {
                return e.name.toLowerCase().includes(this.filterText) ||
                       e.description.toLowerCase().includes(this.filterText);
            }
            return true;
        });
    }

    private getElementIcon(type: BevyElement['type']): vscode.ThemeIcon {
        switch (type) {
            case 'Component': return new vscode.ThemeIcon('symbol-structure', new vscode.ThemeColor('charts.green'));
            case 'Resource': return new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.blue'));
            case 'Event': return new vscode.ThemeIcon('zap', new vscode.ThemeColor('charts.orange'));
            case 'Message': return new vscode.ThemeIcon('mail', new vscode.ThemeColor('charts.yellow'));
            case 'Plugin': return new vscode.ThemeIcon('plug', new vscode.ThemeColor('charts.purple'));
            case 'Shader': return new vscode.ThemeIcon('paintcan', new vscode.ThemeColor('charts.red'));
            case 'Asset': return new vscode.ThemeIcon('package', new vscode.ThemeColor('charts.foreground'));
            case 'System': return new vscode.ThemeIcon('gear', new vscode.ThemeColor('debugIcon.startForeground'));
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
            if (ext === '.rs' || ext === '.wgsl') {
                node = new ExplorerNode(filePath, path.basename(filePath), 'file', filePath);
                this.nodeMap.set(filePath, node);
            }
        }
        return node;
    }

    getTreeItem(node: ExplorerNode): vscode.TreeItem {
        // 恢复成：目录与文件都是 Collapsed 可折叠/展开结构！
        const item = new vscode.TreeItem(
            node.label,
            node.kind === 'element' 
                ? vscode.TreeItemCollapsibleState.None 
                : vscode.TreeItemCollapsibleState.Collapsed
        );

        if (node.kind === 'directory') {
            item.contextValue = 'directory';
            item.resourceUri = vscode.Uri.file(node.fsPath);
            // 目录依然使用 VS Code 自动配的文件夹图标
        } else if (node.kind === 'file') {
            item.contextValue = 'file';

            // ✨【关键修复】✨
            // 因为本文件节点是可折叠结构 (Collapsed)，VS Code 默认强制展示为文件夹图标。
            // 我们通过直接为 item.iconPath 赋值我们在 resources/ 中打包的 Rust/WGSL 专属 SVG 图标路径，
            // 成功覆盖掉 VS Code 文件夹图标的强制设定，让它既能展开，又显示为正确的 Rust 螃蟹图标！
            const ext = path.extname(node.fsPath);
            if (ext === '.rs') {
                item.iconPath = vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'rust.svg'));
            } else if (ext === '.wgsl') {
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
            
            // 富文本注释
            const markdown = new vscode.MarkdownString();
            markdown.appendMarkdown(`### **${el.name}** \`[${el.type}]\`${statusTag}\n\n`);
            
            if (elementErrors.length > 0) {
                markdown.appendMarkdown(`> ❌ **LSP 编译报错诊断**:\n`);
                elementErrors.forEach(err => {
                    markdown.appendMarkdown(`> * \`${err.message.trim()}\`\n`);
                });
                markdown.appendMarkdown(`\n---\n\n`);
            }

            markdown.appendMarkdown(`---\n\n`);
            markdown.appendMarkdown(el.docstring || '*无可用注释描述*');
            item.tooltip = markdown;

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
                const ext = path.extname(item);
                if (ext === '.rs' || ext === '.wgsl') {
                    const fileNode = new ExplorerNode(fullPath, item, 'file', fullPath);
                    this.nodeMap.set(fullPath, fileNode);
                    files.push(fileNode);
                }
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
            case 'Resource': return new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.blue'));
            case 'Event': return new vscode.ThemeIcon('zap', new vscode.ThemeColor('charts.orange'));
            case 'Message': return new vscode.ThemeIcon('mail', new vscode.ThemeColor('charts.yellow'));
            case 'Plugin': return new vscode.ThemeIcon('plug', new vscode.ThemeColor('charts.purple'));
            case 'Shader': return new vscode.ThemeIcon('paintcan', new vscode.ThemeColor('charts.red'));
            case 'Asset': return new vscode.ThemeIcon('package', new vscode.ThemeColor('charts.foreground'));
            case 'System': return new vscode.ThemeIcon('gear', new vscode.ThemeColor('debugIcon.startForeground'));
        }
    }
}
