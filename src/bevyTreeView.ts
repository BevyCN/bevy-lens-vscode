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
    markdown.appendMarkdown(`* **File**: \`${path.basename(element.filePath)}\` (Line ${element.line})\n\n`);

    // System 调度与访问分析展示
    if (element.type === 'System' && element.systemMetadata) {
        const meta = element.systemMetadata;
        markdown.appendMarkdown(`---\n\n`);
        markdown.appendMarkdown(`#### ⚙️ **System Schedule & Bounds**\n`);
        if (meta.schedulePhase) {
            markdown.appendMarkdown(`* **Stage**: \`${meta.schedulePhase}\`\n`);
        }
        if (meta.belongsToSets.length > 0) {
            markdown.appendMarkdown(`* **SystemSets**: ${meta.belongsToSets.map(s => `\`${s}\``).join(', ')}\n`);
        }
        if (meta.runsAfter.length > 0) {
            markdown.appendMarkdown(`* **After**: ${meta.runsAfter.map(s => `\`${s}\``).join(', ')}\n`);
        }
        if (meta.runsBefore.length > 0) {
            markdown.appendMarkdown(`* **Before**: ${meta.runsBefore.map(s => `\`${s}\``).join(', ')}\n`);
        }
        if (meta.runConditions.length > 0) {
            markdown.appendMarkdown(`* **Run Conditions**: \`${meta.runConditions.join(' && ')}\`\n`);
        }

        markdown.appendMarkdown(`\n#### 📊 **Data Access**\n`);
        if (meta.mutableResources.length > 0) {
            markdown.appendMarkdown(`* **Mut Res**: ${meta.mutableResources.map(r => `\`${r}\``).join(', ')}\n`);
        }
        if (meta.readableResources.length > 0) {
            markdown.appendMarkdown(`* **Res**: ${meta.readableResources.map(r => `\`${r}\``).join(', ')}\n`);
        }
        if (meta.mutableComponents.length > 0) {
            markdown.appendMarkdown(`* **Mut Comp**: ${meta.mutableComponents.map(c => `\`${c}\``).join(', ')}\n`);
        }
        if (meta.readableComponents.length > 0) {
            markdown.appendMarkdown(`* **Comp**: ${meta.readableComponents.map(c => `\`${c}\``).join(', ')}\n`);
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

export class TargetCategory {
    constructor(
        public readonly label: string, // 例如 "Examples", "Bins"
        public readonly targetType: 'example' | 'bin' | 'lib',
        public readonly parentCrate: CrateCategory,
        public readonly specificName?: string // 具体的 example 名字或 bin 名字
    ) {}
}

export type RegistryNode = RegistryCategory | CrateCategory | TargetCategory | BevyElement;

export class BevyGlobalRegistryProvider implements vscode.TreeDataProvider<RegistryNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<RegistryNode | undefined | null | void> = new vscode.EventEmitter<RegistryNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<RegistryNode | undefined | null | void> = this._onDidChangeTreeData.event;

    private elements: BevyElement[] = [];
    private filterText: string = '';
    private includesKeywords: string[] = [];
    private excludesKeywords: string[] = [];

    // 缓存全局文件的诊断结果，避免 TreeItem 每次渲染时发起 IPC 调用 vscode.languages.getDiagnostics
    private diagnosticsCache: Map<string, vscode.Diagnostic[]> = new Map();

    constructor(private readonly context: vscode.ExtensionContext) {}

    public updateData(elements: BevyElement[]) {
        this.elements = elements;
        this.rebuildDiagnosticsCache();
        this.refresh();
    }

    // 重新构建文件编译诊断缓存
    private rebuildDiagnosticsCache() {
        this.diagnosticsCache.clear();
        const files = new Set(this.elements.map(e => e.filePath));
        for (const filePath of files) {
            const uri = vscode.Uri.file(filePath);
            const diags = vscode.languages.getDiagnostics(uri);
            if (diags && diags.length > 0) {
                this.diagnosticsCache.set(filePath, diags);
            }
        }
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
        // 在强制刷新时也同步更新一次诊断缓存
        this.rebuildDiagnosticsCache();
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
        } else if (element instanceof TargetCategory) {
            let label = element.label;
            const items = this.getFilteredElementsByTarget(element);
            const item = new vscode.TreeItem(
                `${label} (${items.length})`,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            item.contextValue = 'targetCategory';
            if (element.targetType === 'example') {
                item.iconPath = new vscode.ThemeIcon('beaker', new vscode.ThemeColor('charts.orange'));
            } else if (element.targetType === 'bin') {
                item.iconPath = new vscode.ThemeIcon('terminal', new vscode.ThemeColor('charts.blue'));
            } else {
                item.iconPath = new vscode.ThemeIcon('library', new vscode.ThemeColor('charts.green'));
            }
            return item;
        } else {
            // 使用缓存的诊断结果进行 O(1) 过滤，极速渲染
            const diagnostics = this.diagnosticsCache.get(element.filePath) || [];
            
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
            const fileUri = vscode.Uri.file(element.filePath);
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
            
            return crateNames.map(crate => new CrateCategory(crate, element));
        }

        if (element instanceof CrateCategory) {
            const items = this.getFilteredElementsByTypeAndCrate(element.parentCategory.type, element.crateName);
            
            const hasExamples = items.some(e => e.sourceTarget?.type === 'example');
            const hasBins = items.some(e => e.sourceTarget?.type === 'bin');
            
            const nodes: RegistryNode[] = [];
            
            // 1. examples 放到 "Examples" 汇总分组节点下，而不是直接平铺
            if (hasExamples) {
                nodes.push(new TargetCategory("Examples", 'example', element));
            }
            
            // 2. bins 放到 "Bins" 汇总分组节点下，而不是直接平铺
            if (hasBins) {
                nodes.push(new TargetCategory("Bins", 'bin', element));
            }
            
            // 3. 不属于 examples 和 bins 的系统直接放在 Crate 下展示 (lib 类型)
            const libItems = items.filter(e => !e.sourceTarget || e.sourceTarget.type === 'lib');
            nodes.push(...libItems);
            
            return nodes;
        }

        if (element instanceof TargetCategory) {
            // 如果 specificName 不存在，说明是 "Examples" 或 "Bins" 总节点，应当列出所有的具体例子/命令名
            if (!element.specificName) {
                const items = this.getFilteredElementsByTypeAndCrate(element.parentCrate.parentCategory.type, element.parentCrate.crateName);
                const filtered = items.filter(e => e.sourceTarget?.type === element.targetType);
                const specificNames = Array.from(new Set(
                    filtered.map(e => e.sourceTarget?.name || 'unknown')
                )).sort();
                
                return specificNames.map(name => {
                    const label = element.targetType === 'example' ? `Example: ${name}` : `Bin: ${name}`;
                    return new TargetCategory(label, element.targetType, element.parentCrate, name);
                });
            } else {
                // 如果已经有 specificName，说明已经是具体例子（如 Example: ui/button），则展示其下面的具体 bevy 元素列表
                return this.getFilteredElementsByTarget(element);
            }
        }

        return [];
    }

    private getFilteredElementsByTarget(target: TargetCategory): BevyElement[] {
        const items = this.getFilteredElementsByTypeAndCrate(target.parentCrate.parentCategory.type, target.parentCrate.crateName);
        return items.filter(e => {
            if (!e.sourceTarget) return false;
            if (e.sourceTarget.type !== target.targetType) return false;
            if (target.specificName && e.sourceTarget.name !== target.specificName) return false;
            return true;
        });
    }

    private getFilteredElementsByTypeAndCrate(type: BevyElement['type'], crateName: string): BevyElement[] {
        return this.getFilteredElementsByType(type).filter(e => (e.crateName || 'unknown') === crateName);
    }

    private getFilteredElementsByType(type: BevyElement['type']): BevyElement[] {
        const filtered = this.elements.filter(e => {
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

        // 读取排序配置进行排序
        const config = vscode.workspace.getConfiguration('bevyLens');
        const sortBy = config.get<string>('sortBy', 'alphabetical');

        if (sortBy === 'alphabetical') {
            return filtered.sort((a, b) => a.name.localeCompare(b.name));
        } else {
            // 按行号/文件位置顺序排列
            return filtered.sort((a, b) => {
                if (a.filePath !== b.filePath) {
                    return a.filePath.localeCompare(b.filePath);
                }
                return a.line - b.line;
            });
        }
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

    // 缓存全局文件的诊断结果，避免 TreeItem 每次渲染时发起 IPC 调用 vscode.languages.getDiagnostics
    private diagnosticsCache: Map<string, vscode.Diagnostic[]> = new Map();

    constructor(private readonly context: vscode.ExtensionContext) {}

    public updateData(elements: BevyElement[], workspaceRoot: string) {
        this.elements = elements;
        this.workspaceRoot = workspaceRoot;
        this.nodeMap.clear();
        this.rebuildDiagnosticsCache();
        this.refresh();
    }

    private rebuildDiagnosticsCache() {
        this.diagnosticsCache.clear();
        const files = new Set(this.elements.map(e => e.filePath));
        for (const filePath of files) {
            const uri = vscode.Uri.file(filePath);
            const diags = vscode.languages.getDiagnostics(uri);
            if (diags && diags.length > 0) {
                this.diagnosticsCache.set(filePath, diags);
            }
        }
    }

    public refresh(): void {
        this.rebuildDiagnosticsCache();
        this._onDidChangeTreeData.fire();
    }

    // 根据文件路径找到 Tree 中的 ExplorerNode 节点，以便在编辑器打开时 Reveal
    public findFileNode(filePath: string): ExplorerNode | undefined {
        let node = this.nodeMap.get(filePath);
        if (!node) {
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
        } else if (node.kind === 'file') {
            item.contextValue = 'file';
            item.resourceUri = vscode.Uri.file(node.fsPath);

            // 方案B：将 iconPath 设置为 vscode.ThemeIcon.File，由 VS Code 底层自动依据该节点的 resourceUri
            // 的后缀（.rs, .wgsl, .wesl 等）从用户当前激活的“文件图标主题”中抓取对应图标。
            item.iconPath = vscode.ThemeIcon.File;

            // 使用缓存的诊断结果 O(1) 取值
            const diagnostics = this.diagnosticsCache.get(node.fsPath) || [];
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
                markdown.appendMarkdown(`#### ❌ **Syntax Errors (${errors.length})**:\n`);
                errors.slice(0, 5).forEach(err => {
                    markdown.appendMarkdown(`* [Line ${err.range.start.line + 1}]: \`${err.message.trim()}\`\n`);
                });
                markdown.appendMarkdown(`\n---\n`);
            }
            if (warnings.length > 0) {
                markdown.appendMarkdown(`#### ⚠️ **Warnings (${warnings.length})**:\n`);
                warnings.slice(0, 5).forEach(warn => {
                    markdown.appendMarkdown(`* [Line ${warn.range.start.line + 1}]: \`${warn.message.trim()}\`\n`);
                });
                markdown.appendMarkdown(`\n---\n`);
            }
            markdown.appendMarkdown(`* Path: \`${node.fsPath}\``);
            item.tooltip = markdown;

            // 让文件本身支持点击命令直接打开
            const fileUri = vscode.Uri.file(node.fsPath);
            item.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [fileUri]
            };

        } else if (node.kind === 'element' && node.elementData) {
            const el = node.elementData;
            const fileUri = vscode.Uri.file(el.filePath);
            
            // 使用缓存的诊断结果 O(1) 过滤
            const diagnostics = this.diagnosticsCache.get(el.filePath) || [];
            
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

            // 图标与 tag
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
            let parentNode = this.nodeMap.get(node.fsPath);
            if (!parentNode) {
                parentNode = new ExplorerNode(node.fsPath, path.basename(node.fsPath), 'file', node.fsPath);
                this.nodeMap.set(node.fsPath, parentNode);
            }
            return parentNode;
        } else {
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

        if (node && node.kind === 'element') {
            return [];
        }

        if (node && node.kind === 'file') {
            const fileElements = this.elements.filter(e => e.filePath === currentPath);
            return fileElements.map(el => {
                const key = `${el.filePath}:${el.name}:${el.type}`;
                const elNode = new ExplorerNode(key, el.name, 'element', el.filePath, el);
                this.nodeMap.set(key, elNode);
                return elNode;
            });
        }

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
