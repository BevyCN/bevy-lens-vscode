import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BevyElement } from './bevyParser';

const isWindows = process.platform === 'win32';

function normalizePath(p: string): string {
    const normalized = path.normalize(p);
    if (isWindows) {
        // 如果是 UNC 路径（例如 \\wsl$ 或 \\wsl.localhost），由于指向的是 Linux 文件系统，它是区分大小写的，绝对不能转为小写！
        if (normalized.startsWith('\\\\') || normalized.startsWith('//')) {
            return normalized;
        }
        return normalized.toLowerCase();
    }
    return normalized;
}

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

    // System 与 Observer 调度与访问分析展示
    if ((element.type === 'System' || element.type === 'TestSystem' || element.type === 'MainSystem' || element.type === 'TestMainSystem' || element.type === 'RenderSystem' || element.type === 'TestRenderSystem' || element.type === 'Observer' || element.type === 'TestObserver') && element.systemMetadata) {
        const meta = element.systemMetadata;
        markdown.appendMarkdown(`---\n\n`);
        
        if (element.type === 'Observer' || element.type === 'TestObserver') {
            markdown.appendMarkdown(`#### 🔔 **Observer Trigger**\n`);
            markdown.appendMarkdown(`* **Trigger Type**: Event-driven Observer\n`);
            if (meta.runConditions.length > 0) {
                markdown.appendMarkdown(`* **Run Conditions**: \`${meta.runConditions.join(' && ')}\`\n`);
            }
        } else {
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

export class ShaderBindingNode {
    constructor(
        public readonly binding: number,
        public readonly type: 'uniform' | 'texture' | 'sampler',
        public readonly name: string,
        public readonly parentShader: BevyElement
    ) {}
}

export class ShaderEntryPointNode {
    constructor(
        public readonly name: string,
        public readonly type: 'vertex' | 'fragment' | 'compute',
        public readonly workgroupSize: string | undefined,
        public readonly parentShader: BevyElement
    ) {}
}

export type RegistryNode = RegistryCategory | CrateCategory | TargetCategory | BevyElement | ShaderBindingNode | ShaderEntryPointNode;

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
        const files = new Set(this.elements.map(e => normalizePath(e.filePath)));
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

    private refreshTimeout: any = undefined;

    public updateDiagnostics(uris: readonly vscode.Uri[]): void {
        let changed = false;
        const filePaths = new Set(this.elements.map(e => normalizePath(e.filePath)));
        for (const uri of uris) {
            const filePath = normalizePath(uri.fsPath);
            if (filePaths.has(filePath)) {
                const diags = vscode.languages.getDiagnostics(uri);
                if (diags && diags.length > 0) {
                    this.diagnosticsCache.set(filePath, diags);
                } else {
                    this.diagnosticsCache.delete(filePath);
                }
                changed = true;
            }
        }
        // 移除了全局 fire() 以避免在用户打字时频繁触发蓝色的加载进度条。
        // 缓存已经静默更新，下一次树刷新时会包含最新的错误标签。
    }

    public refresh(): void {
        if (this.refreshTimeout) {
            clearTimeout(this.refreshTimeout);
        }
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
            item.id = `category:${element.type}`;
            return item;
        } else if (element instanceof CrateCategory) {
            const items = this.getFilteredElementsByTypeAndCrate(element.parentCategory.type, element.crateName);
            const item = new vscode.TreeItem(
                `${element.crateName} (${items.length})`,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            item.contextValue = 'crateCategory';
            item.iconPath = new vscode.ThemeIcon('package', new vscode.ThemeColor('charts.purple'));
            item.id = `crate:${element.parentCategory.type}:${element.crateName}`;
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
            item.id = `target:${element.parentCrate.parentCategory.type}:${element.parentCrate.crateName}:${element.targetType}:${element.specificName || ''}`;
            return item;
        } else if (element instanceof ShaderBindingNode) {
            const item = new vscode.TreeItem(`@binding(${element.binding}) ${element.name}`, vscode.TreeItemCollapsibleState.None);
            item.description = element.type;
            item.iconPath = new vscode.ThemeIcon('symbol-field', new vscode.ThemeColor('charts.blue'));
            item.contextValue = 'shaderBinding';
            item.id = `binding:${element.parentShader.filePath}:${element.binding}:${element.name}`;
            
            const fileUri = vscode.Uri.file(element.parentShader.filePath);
            item.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [
                    fileUri,
                    {
                        selection: new vscode.Range(
                            new vscode.Position(element.parentShader.line - 1, 0),
                            new vscode.Position(element.parentShader.line - 1, 0)
                        )
                    }
                ]
            };
            return item;
        } else if (element instanceof ShaderEntryPointNode) {
            const wg = element.workgroupSize ? ` (${element.workgroupSize})` : '';
            const item = new vscode.TreeItem(`fn ${element.name}()${wg}`, vscode.TreeItemCollapsibleState.None);
            item.description = `@${element.type}`;
            item.iconPath = new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.orange'));
            item.contextValue = 'shaderEntryPoint';
            item.id = `entrypoint:${element.parentShader.filePath}:${element.name}`;
            
            const fileUri = vscode.Uri.file(element.parentShader.filePath);
            item.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [
                    fileUri,
                    {
                        selection: new vscode.Range(
                            new vscode.Position(element.parentShader.line - 1, 0),
                            new vscode.Position(element.parentShader.line - 1, 0)
                        )
                    }
                ]
            };
            return item;
        } else {
            // 使用缓存的诊断结果进行 O(1) 过滤，极速渲染
            const diagnostics = this.diagnosticsCache.get(normalizePath(element.filePath)) || [];
            
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

            const hasChildren = element.type === 'Shader' && 
                element.shaderMetadata && 
                (element.shaderMetadata.bindings.length > 0 || element.shaderMetadata.entryPoints.length > 0);

            const item = new vscode.TreeItem(
                element.name + errorTag, 
                hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
            );
            item.description = element.description;
            item.id = `element:${element.filePath}:${element.name}:${element.type}`;
            
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
            const categories = [
                new RegistryCategory('Components', 'Component', 'symbol-structure'),
                new RegistryCategory('Bundles', 'Bundle', 'library'),
                new RegistryCategory('Resources', 'Resource', 'database'),
                new RegistryCategory('App Settings', 'AppSettings', 'settings'),
                new RegistryCategory('Events', 'Event', 'zap'),
                new RegistryCategory('States', 'State', 'symbol-enum'),
                new RegistryCategory('System Params', 'SystemParam', 'list-unordered'),
                new RegistryCategory('System Sets', 'SystemSet', 'symbol-namespace'),
                new RegistryCategory('Messages', 'Message', 'mail'),
                new RegistryCategory('Plugins', 'Plugin', 'plug'),
                new RegistryCategory('Shaders', 'Shader', 'paintcan'),
                new RegistryCategory('Assets', 'Asset', 'package'),
                new RegistryCategory('Main World Systems', 'MainSystem', 'gear'),
                new RegistryCategory('Render World Systems', 'RenderSystem', 'server-process'),
                new RegistryCategory('Observers', 'Observer', 'eye'),
                new RegistryCategory('BSN', 'BSN', 'symbol-interface'),
                new RegistryCategory('BSN List', 'BSNList', 'symbol-method'),
                // 新增测试分类
                new RegistryCategory('Test Main World Systems', 'TestMainSystem', 'beaker'),
                new RegistryCategory('Test Render World Systems', 'TestRenderSystem', 'server-process'),
                new RegistryCategory('Test Observers', 'TestObserver', 'eye'),
                new RegistryCategory('Test BSN', 'TestBSN', 'symbol-interface'),
                new RegistryCategory('Test BSN List', 'TestBSNList', 'symbol-method'),
                new RegistryCategory('Test App Settings', 'TestAppSettings', 'settings'),
                new RegistryCategory('Test ECS Types', 'TestComponent', 'package'),
                new RegistryCategory('Test Logic & Bounds', 'TestEvent', 'pulse'),
                new RegistryCategory('Systems', 'System', 'gear'),
                new RegistryCategory('Test Systems', 'TestSystem', 'beaker')
            ];
            categories.sort((a, b) => {
                const aIsTest = a.label.startsWith('Test');
                const bIsTest = b.label.startsWith('Test');
                if (aIsTest && !bIsTest) return 1;
                if (!aIsTest && bIsTest) return -1;
                return a.label.localeCompare(b.label);
            });
            return categories;
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

        // 处理 BevyElement 的子节点（只有 Shader 类型有子节点）
        if (element instanceof ShaderBindingNode || element instanceof ShaderEntryPointNode) {
            return [];
        }
        if (element && element.type === 'Shader' && element.shaderMetadata) {
            const nodes: RegistryNode[] = [];
            for (const b of element.shaderMetadata.bindings) {
                nodes.push(new ShaderBindingNode(b.binding, b.type, b.name, element));
            }
            for (const ep of element.shaderMetadata.entryPoints) {
                nodes.push(new ShaderEntryPointNode(ep.name, ep.type, ep.workgroupSize, element));
            }
            return nodes;
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
            case 'AppSettings': return new vscode.ThemeIcon('settings', new vscode.ThemeColor('charts.purple'));
            case 'TestAppSettings': return new vscode.ThemeIcon('settings', new vscode.ThemeColor('charts.yellow'));
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
            case 'MainSystem': return new vscode.ThemeIcon('gear', new vscode.ThemeColor('debugIcon.startForeground'));
            case 'TestMainSystem': return new vscode.ThemeIcon('beaker', new vscode.ThemeColor('charts.purple'));
            case 'RenderSystem': return new vscode.ThemeIcon('server-process', new vscode.ThemeColor('charts.red'));
            case 'TestRenderSystem': return new vscode.ThemeIcon('server-process', new vscode.ThemeColor('charts.yellow'));
            case 'BSN': return new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('charts.green'));
            case 'TestBSN': return new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('charts.yellow'));
            case 'BSNList': return new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.green'));
            case 'TestBSNList': return new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.yellow'));
            case 'Observer': return new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.blue'));
            case 'TestObserver': return new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.yellow'));
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
        public readonly kind: 'directory' | 'file' | 'element' | 'shaderBinding' | 'shaderEntryPoint',
        public readonly fsPath: string,
        public readonly elementData?: BevyElement,
        public readonly bindingData?: { binding: number; type: 'uniform' | 'texture' | 'sampler'; name: string },
        public readonly entryPointData?: { name: string; type: 'vertex' | 'fragment' | 'compute'; workgroupSize?: string }
    ) {}
}

export class BevySemanticExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<ExplorerNode | ExplorerNode[] | undefined | null | void> = new vscode.EventEmitter<ExplorerNode | ExplorerNode[] | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ExplorerNode | ExplorerNode[] | undefined | null | void> = this._onDidChangeTreeData.event;

    private elements: BevyElement[] = [];
    private workspaceRoot: string = '';
    private nodeMap: Map<string, ExplorerNode> = new Map(); // 用于实现 getParent

    // 缓存全局文件的诊断结果，避免 TreeItem 每次渲染时发起 IPC 调用 vscode.languages.getDiagnostics
    private diagnosticsCache: Map<string, vscode.Diagnostic[]> = new Map();

    constructor(private readonly context: vscode.ExtensionContext) {}

    private getMapKey(key: string): string {
        const firstColonIndex = key.indexOf(':');
        if (firstColonIndex > 1) {
            const filePath = key.substring(0, firstColonIndex);
            const rest = key.substring(firstColonIndex);
            return normalizePath(filePath) + rest;
        } else if (firstColonIndex === 1) {
            const secondColonIndex = key.indexOf(':', 2);
            if (secondColonIndex !== -1) {
                const filePath = key.substring(0, secondColonIndex);
                const rest = key.substring(secondColonIndex);
                return normalizePath(filePath) + rest;
            }
        }
        return normalizePath(key);
    }

    public updateData(elements: BevyElement[], workspaceRoot: string) {
        this.elements = elements;
        this.workspaceRoot = normalizePath(workspaceRoot);
        this.nodeMap.clear();
        this.rebuildDiagnosticsCache();
        this.refresh();
    }

    public getWorkspaceRoot(): string {
        return this.workspaceRoot;
    }

    private rebuildDiagnosticsCache() {
        this.diagnosticsCache.clear();
        const files = new Set(this.elements.map(e => normalizePath(e.filePath)));
        for (const filePath of files) {
            const uri = vscode.Uri.file(filePath);
            const diags = vscode.languages.getDiagnostics(uri);
            if (diags && diags.length > 0) {
                this.diagnosticsCache.set(filePath, diags);
            }
        }
    }

    private refreshTimeout: any = undefined;

    public updateDiagnostics(uris: readonly vscode.Uri[]): void {
        let changedNodes: ExplorerNode[] = [];
        const filePaths = new Set(this.elements.map(e => normalizePath(e.filePath)));
        for (const uri of uris) {
            const filePath = normalizePath(uri.fsPath);
            if (filePaths.has(filePath)) {
                const diags = vscode.languages.getDiagnostics(uri);
                if (diags && diags.length > 0) {
                    this.diagnosticsCache.set(filePath, diags);
                } else {
                    this.diagnosticsCache.delete(filePath);
                }
                const fileNode = this.findFileNode(uri.fsPath);
                if (fileNode) {
                    changedNodes.push(fileNode);
                }
            }
        }
        if (changedNodes.length > 0) {
            if (this.refreshTimeout) {
                clearTimeout(this.refreshTimeout);
            }
            this.refreshTimeout = setTimeout(() => {
                this._onDidChangeTreeData.fire(changedNodes.length === 1 ? changedNodes[0] : changedNodes);
            }, 150);
        }
    }

    public refresh(): void {
        if (this.refreshTimeout) {
            clearTimeout(this.refreshTimeout);
        }
        this.rebuildDiagnosticsCache();
        this._onDidChangeTreeData.fire();
    }

    // 根据文件路径找到 Tree 中的 ExplorerNode 节点，以便在编辑器打开时 Reveal
    public findFileNode(filePath: string): ExplorerNode | undefined {
        const normKey = this.getMapKey(filePath);
        let node = this.nodeMap.get(normKey);
        if (!node) {
            const ext = path.extname(filePath);
            if (ext === '.rs' || ext === '.wgsl' || ext === '.wesl') {
                node = new ExplorerNode(filePath, path.basename(filePath), 'file', filePath);
                this.nodeMap.set(normKey, node);
            }
        }
        return node;
    }

    getTreeItem(node: ExplorerNode): vscode.TreeItem {
        const ext = path.extname(node.fsPath);
        const isBevyFile = ext === '.rs' || ext === '.wgsl' || ext === '.wesl';

        let collapsibleState = vscode.TreeItemCollapsibleState.None;
        if (node.kind === 'directory') {
            collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        } else if (node.kind === 'file') {
            // 只有当该文件是 Bevy 支持的格式，且文件内部确实解析到了 Bevy 元素时，才设置为 Collapsed。
            // 否则（如普通文件或空 Rust 文件）设为 None。VS Code 遇到同级混合节点时会自动留空对齐。
            const normFsPath = normalizePath(node.fsPath);
            const fileElements = isBevyFile ? this.elements.filter(e => normalizePath(e.filePath) === normFsPath) : [];
            collapsibleState = fileElements.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
        } else if (node.kind === 'element' && node.elementData?.type === 'Shader') {
            const hasChildren = node.elementData.shaderMetadata &&
                (node.elementData.shaderMetadata.bindings.length > 0 || node.elementData.shaderMetadata.entryPoints.length > 0);
            collapsibleState = hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
        }

        const item = new vscode.TreeItem(node.label, collapsibleState);
        item.id = node.key;

        if (node.kind === 'directory') {
            item.contextValue = 'directory';
            item.resourceUri = vscode.Uri.file(node.fsPath);
            item.iconPath = vscode.ThemeIcon.Folder;
        } else if (node.kind === 'file') {
            item.contextValue = 'file';
            item.resourceUri = vscode.Uri.file(node.fsPath);

            // 方案B：将 iconPath 设置为 vscode.ThemeIcon.File，由 VS Code 底层自动依据该节点的 resourceUri
            // 的后缀（.rs, .wgsl, .wesl 等）从用户当前激活 of“文件图标主题”中抓取对应图标。
            item.iconPath = vscode.ThemeIcon.File;

            const normFsPath = normalizePath(node.fsPath);
            // 使用缓存的诊断结果 O(1) 取值
            const diagnostics = this.diagnosticsCache.get(normFsPath) || [];
            const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
            const warnings = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);

            let statusTag = '';
            if (errors.length > 0) {
                statusTag = ` 🔴 ${errors.length} Errors`;
            } else if (warnings.length > 0) {
                statusTag = ` 🟡 ${warnings.length} Warnings`;
            }

            const fileElements = this.elements.filter(e => normalizePath(e.filePath) === normFsPath);
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

            item.label = `${node.label}${statusTag}`;
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
        } else if (node.kind === 'shaderBinding' && node.bindingData && node.elementData) {
            const b = node.bindingData;
            item.label = node.label;
            item.description = b.type;
            item.iconPath = new vscode.ThemeIcon('symbol-field', new vscode.ThemeColor('charts.blue'));
            item.contextValue = 'shaderBinding';

            const fileUri = vscode.Uri.file(node.fsPath);
            item.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [
                    fileUri,
                    {
                        selection: new vscode.Range(
                            new vscode.Position(node.elementData.line - 1, 0),
                            new vscode.Position(node.elementData.line - 1, 0)
                        )
                    }
                ]
            };
        } else if (node.kind === 'shaderEntryPoint' && node.entryPointData && node.elementData) {
            const ep = node.entryPointData;
            const wg = ep.workgroupSize ? ` (${ep.workgroupSize})` : '';
            item.label = `fn ${ep.name}()${wg}`;
            item.description = `@${ep.type}`;
            item.iconPath = new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.orange'));
            item.contextValue = 'shaderEntryPoint';

            const fileUri = vscode.Uri.file(node.fsPath);
            item.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [
                    fileUri,
                    {
                        selection: new vscode.Range(
                            new vscode.Position(node.elementData.line - 1, 0),
                            new vscode.Position(node.elementData.line - 1, 0)
                        )
                    }
                ]
            };
        }

        return item;
    }

    getParent(node: ExplorerNode): vscode.ProviderResult<ExplorerNode> {
        if (node.kind === 'element') {
            const parentKey = this.getMapKey(node.fsPath);
            let parentNode = this.nodeMap.get(parentKey);
            if (!parentNode) {
                parentNode = new ExplorerNode(node.fsPath, path.basename(node.fsPath), 'file', node.fsPath);
                this.nodeMap.set(parentKey, parentNode);
            }
            return parentNode;
        } else {
            const parentDir = path.normalize(path.dirname(node.fsPath));
            const parentDirKey = normalizePath(parentDir);
            if (parentDirKey.startsWith(this.workspaceRoot) && parentDirKey !== this.workspaceRoot) {
                let parentNode = this.nodeMap.get(parentDirKey);
                if (!parentNode) {
                    parentNode = new ExplorerNode(parentDir, path.basename(parentDir), 'directory', parentDir);
                    this.nodeMap.set(parentDirKey, parentNode);
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

        if (node && (node.kind === 'shaderBinding' || node.kind === 'shaderEntryPoint')) {
            return [];
        }

        if (node && node.kind === 'element') {
            const el = node.elementData;
            if (el?.type === 'Shader' && el.shaderMetadata) {
                const nodes: ExplorerNode[] = [];
                const meta = el.shaderMetadata;
                
                for (const b of meta.bindings) {
                    const key = `${el.filePath}:binding:${b.binding}:${b.name}`;
                    nodes.push(new ExplorerNode(key, `@binding(${b.binding}) ${b.name}`, 'shaderBinding', el.filePath, el, b, undefined));
                }
                
                for (const ep of meta.entryPoints) {
                    const key = `${el.filePath}:entry:${ep.name}`;
                    nodes.push(new ExplorerNode(key, ep.name, 'shaderEntryPoint', el.filePath, el, undefined, ep));
                }
                
                return nodes;
            }
            return [];
        }

        if (node && node.kind === 'file') {
            const targetPath = normalizePath(currentPath);
            const fileElements = this.elements.filter(e => normalizePath(e.filePath) === targetPath);
            return fileElements.map(el => {
                const key = `${el.filePath}:${el.name}:${el.type}`;
                const elNode = new ExplorerNode(key, el.name, 'element', el.filePath, el);
                this.nodeMap.set(this.getMapKey(key), elNode);
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
                this.nodeMap.set(this.getMapKey(fullPath), dirNode);
                dirs.push(dirNode);
            } else if (stat.isFile()) {
                const fileNode = new ExplorerNode(fullPath, item, 'file', fullPath);
                this.nodeMap.set(this.getMapKey(fullPath), fileNode);
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
            case 'AppSettings': return new vscode.ThemeIcon('settings', new vscode.ThemeColor('charts.purple'));
            case 'TestAppSettings': return new vscode.ThemeIcon('settings', new vscode.ThemeColor('charts.yellow'));
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
            case 'MainSystem': return new vscode.ThemeIcon('gear', new vscode.ThemeColor('debugIcon.startForeground'));
            case 'TestMainSystem': return new vscode.ThemeIcon('beaker', new vscode.ThemeColor('charts.purple'));
            case 'RenderSystem': return new vscode.ThemeIcon('server-process', new vscode.ThemeColor('charts.red'));
            case 'TestRenderSystem': return new vscode.ThemeIcon('server-process', new vscode.ThemeColor('charts.yellow'));
            case 'BSN': return new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('charts.green'));
            case 'TestBSN': return new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('charts.yellow'));
            case 'BSNList': return new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.green'));
            case 'TestBSNList': return new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.yellow'));
            case 'Observer': return new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.blue'));
            case 'TestObserver': return new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.yellow'));
            default: return new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.foreground'));
        }
    }
}

function copyRecursiveSync(src: string, dest: string) {
    const exists = fs.existsSync(src);
    if (!exists) {
        return;
    }
    const stats = fs.statSync(src);
    const isDirectory = stats.isDirectory();
    if (isDirectory) {
        fs.mkdirSync(dest, { recursive: true });
        fs.readdirSync(src).forEach((childItemName) => {
            copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
        });
    } else {
        fs.copyFileSync(src, dest);
    }
}

export class BevySemanticExplorerDragAndDropController implements vscode.TreeDragAndDropController<ExplorerNode> {
    readonly dragMimeTypes = ['text/uri-list'];
    readonly dropMimeTypes = ['text/uri-list'];

    constructor(private readonly provider: BevySemanticExplorerProvider) {}

    public handleDrag(source: readonly ExplorerNode[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void {
        const uris = source
            .filter(node => node.kind === 'file' || node.kind === 'directory')
            .map(node => vscode.Uri.file(node.fsPath));
        
        if (uris.length > 0) {
            dataTransfer.set('text/uri-list', new vscode.DataTransferItem(uris.map(u => u.toString()).join('\r\n')));
        }
    }

    public async handleDrop(target: ExplorerNode | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        const transferItem = dataTransfer.get('text/uri-list');
        if (!transferItem) {
            return;
        }

        const value = await transferItem.asString();
        if (!value) {
            return;
        }

        const uris = value.split(/\r?\n/).filter(Boolean).map(u => vscode.Uri.parse(u));
        if (uris.length === 0) {
            return;
        }

        // 确定目标目录
        let targetDir: string;
        if (!target) {
            targetDir = this.provider.getWorkspaceRoot();
        } else if (target.kind === 'directory') {
            targetDir = target.fsPath;
        } else {
            targetDir = path.dirname(target.fsPath);
        }

        if (!targetDir) {
            return;
        }

        let hasMoved = false;
        for (const uri of uris) {
            const srcPath = uri.fsPath;
            const destPath = path.join(targetDir, path.basename(srcPath));

            // 如果拖动到同目录，或者拖动到了它自身或其子目录下，需要跳过
            if (normalizePath(srcPath) === normalizePath(destPath)) {
                continue;
            }
            if (normalizePath(targetDir).startsWith(normalizePath(srcPath) + path.sep)) {
                vscode.window.showErrorMessage(`Cannot move directory into its own subdirectory`);
                continue;
            }

            try {
                if (fs.existsSync(destPath)) {
                    const confirm = await vscode.window.showWarningMessage(
                        `A file or folder named '${path.basename(srcPath)}' already exists in the target directory. Do you want to overwrite it?`,
                        { modal: true },
                        'Overwrite'
                    );
                    if (confirm !== 'Overwrite') {
                        continue;
                    }
                    fs.rmSync(destPath, { recursive: true, force: true });
                }

                // 执行移动操作
                try {
                    fs.renameSync(srcPath, destPath);
                } catch (err: any) {
                    if (err.code === 'EXDEV') {
                        copyRecursiveSync(srcPath, destPath);
                        fs.rmSync(srcPath, { recursive: true, force: true });
                    } else {
                        throw err;
                    }
                }
                hasMoved = true;
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to move '${path.basename(srcPath)}': ${err.message}`);
            }
        }

        if (hasMoved) {
            await vscode.commands.executeCommand('bevy-lens.refresh');
        }
    }
}

