import * as path from 'path';
import * as vscode from 'vscode';
import { BevyElement } from './bevyParser';
import { buildElementTooltip } from './bevyTreeView';

type SemanticNodeKind = 'crate' | 'file' | 'element' | 'shaderBinding' | 'shaderEntryPoint';

function normalizePath(value: string): string {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function elementKey(element: BevyElement): string {
    return `${normalizePath(element.filePath)}:${element.line}:${element.type}:${element.name}`;
}

export class SemanticNode {
    public readonly children: SemanticNode[] = [];

    constructor(
        public readonly id: string,
        public readonly kind: SemanticNodeKind,
        public readonly label: string,
        public readonly parent?: SemanticNode,
        public readonly element?: BevyElement,
        public readonly filePath?: string,
        public readonly shaderBinding?: { binding: number; type: 'uniform' | 'texture' | 'sampler'; name: string },
        public readonly shaderEntryPoint?: { name: string; type: 'vertex' | 'fragment' | 'compute'; workgroupSize?: string }
    ) {}
}

export class BevySemanticViewProvider implements vscode.TreeDataProvider<SemanticNode> {
    private readonly changeEmitter = new vscode.EventEmitter<SemanticNode | SemanticNode[] | undefined>();
    public readonly onDidChangeTreeData = this.changeEmitter.event;

    private roots: SemanticNode[] = [];
    private readonly nodes = new Map<string, SemanticNode>();
    private readonly fileNodes = new Map<string, SemanticNode>();
    private readonly diagnostics = new Map<string, readonly vscode.Diagnostic[]>();
    private diagnosticsTimer: NodeJS.Timeout | undefined;

    public updateData(input: readonly BevyElement[]): void {
        const unique = new Map<string, BevyElement>();
        for (const element of input) {
            unique.set(elementKey(element), element);
        }

        this.nodes.clear();
        this.fileNodes.clear();

        const crateGroups = new Map<string, BevyElement[]>();
        for (const element of unique.values()) {
            const crateId = `${normalizePath(element.crateRoot || '')}:${element.crateName || 'workspace'}`;
            const group = crateGroups.get(crateId) || [];
            group.push(element);
            crateGroups.set(crateId, group);
        }

        this.roots = Array.from(crateGroups.entries()).map(([crateId, elements]) => {
            const crateName = elements[0].crateName || 'workspace';
            const crateNode = new SemanticNode(`crate:${crateId}`, 'crate', crateName);
            this.nodes.set(crateNode.id, crateNode);

            const files = new Map<string, BevyElement[]>();
            for (const element of elements) {
                const key = normalizePath(element.filePath);
                const fileElements = files.get(key) || [];
                fileElements.push(element);
                files.set(key, fileElements);
            }

            for (const [fileKey, fileElements] of files) {
                const sample = fileElements[0];
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(sample.filePath));
                const base = sample.crateRoot || workspaceFolder?.uri.fsPath || path.dirname(sample.filePath);
                const relativePath = path.relative(base, sample.filePath) || path.basename(sample.filePath);
                const fileNode = new SemanticNode(`file:${fileKey}`, 'file', relativePath, crateNode, undefined, sample.filePath);
                crateNode.children.push(fileNode);
                this.nodes.set(fileNode.id, fileNode);
                this.fileNodes.set(fileKey, fileNode);

                const sortBy = vscode.workspace.getConfiguration('bevyLens').get<string>('sortBy', 'alphabetical');
                fileElements.sort(sortBy === 'position'
                    ? (a, b) => a.line - b.line || a.name.localeCompare(b.name)
                    : (a, b) => a.name.localeCompare(b.name) || a.line - b.line);

                for (const element of fileElements) {
                    const node = new SemanticNode(`element:${elementKey(element)}`, 'element', element.name, fileNode, element, element.filePath);
                    fileNode.children.push(node);
                    this.nodes.set(node.id, node);
                    this.addShaderChildren(node, element);
                }
            }

            crateNode.children.sort((a, b) => a.label.localeCompare(b.label));
            return crateNode;
        }).sort((a, b) => a.label.localeCompare(b.label));

        this.rebuildDiagnostics();
        this.changeEmitter.fire(undefined);
    }

    public refresh(): void {
        this.rebuildDiagnostics();
        this.changeEmitter.fire(undefined);
    }

    public updateDiagnostics(uris: readonly vscode.Uri[]): void {
        const changed: SemanticNode[] = [];
        for (const uri of uris) {
            const key = normalizePath(uri.fsPath);
            const fileNode = this.fileNodes.get(key);
            if (!fileNode) {
                continue;
            }
            const fileDiagnostics = vscode.languages.getDiagnostics(uri);
            if (fileDiagnostics.length > 0) {
                this.diagnostics.set(key, fileDiagnostics);
            } else {
                this.diagnostics.delete(key);
            }
            changed.push(fileNode, ...fileNode.children);
        }

        if (changed.length === 0) {
            return;
        }
        if (this.diagnosticsTimer) {
            clearTimeout(this.diagnosticsTimer);
        }
        this.diagnosticsTimer = setTimeout(() => this.changeEmitter.fire(changed), 100);
    }

    public findFileNode(filePath: string): SemanticNode | undefined {
        return this.fileNodes.get(normalizePath(filePath));
    }

    public getParent(node: SemanticNode): SemanticNode | undefined {
        return node.parent;
    }

    public getChildren(node?: SemanticNode): SemanticNode[] {
        return node ? node.children : this.roots;
    }

    public getTreeItem(node: SemanticNode): vscode.TreeItem {
        const collapsible = node.children.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem(node.label, collapsible);
        item.id = node.id;

        if (node.kind === 'crate') {
            item.contextValue = 'bevyCrate';
            item.iconPath = new vscode.ThemeIcon('package');
            item.description = `${node.children.length} files`;
            return item;
        }

        if (node.kind === 'file' && node.filePath) {
            const uri = vscode.Uri.file(node.filePath);
            item.contextValue = 'bevyFile';
            item.resourceUri = uri;
            item.iconPath = vscode.ThemeIcon.File;
            const diagnostics = this.diagnostics.get(normalizePath(node.filePath)) || [];
            const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
            const warnings = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;
            item.description = this.fileDescription(node.children.length, errors, warnings);
            item.tooltip = this.fileTooltip(node, diagnostics);
            item.command = { command: 'vscode.open', title: 'Open File', arguments: [uri] };
            return item;
        }

        if (node.kind === 'element' && node.element) {
            const element = node.element;
            const line = Math.max(0, element.line - 1);
            const diagnostics = (this.diagnostics.get(normalizePath(element.filePath)) || [])
                .filter(diagnostic => diagnostic.range.start.line <= line && line <= diagnostic.range.end.line);
            item.contextValue = 'bevyElement';
            item.iconPath = this.elementIcon(element.type);
            item.description = element.description;
            item.tooltip = buildElementTooltip(element, diagnostics);
            item.command = this.openAt(element.filePath, line);
            return item;
        }

        if (node.kind === 'shaderBinding' && node.shaderBinding && node.filePath) {
            item.contextValue = 'shaderBinding';
            item.description = node.shaderBinding.type;
            item.iconPath = new vscode.ThemeIcon('symbol-field', new vscode.ThemeColor('charts.blue'));
            item.tooltip = this.shaderBindingTooltip(node);
            item.command = this.openAt(node.filePath, Math.max(0, (node.element?.line || 1) - 1));
            return item;
        }

        if (node.kind === 'shaderEntryPoint' && node.shaderEntryPoint && node.filePath) {
            const entry = node.shaderEntryPoint;
            item.contextValue = 'shaderEntryPoint';
            item.label = `fn ${entry.name}()${entry.workgroupSize ? ` (${entry.workgroupSize})` : ''}`;
            item.description = `@${entry.type}`;
            item.iconPath = new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.orange'));
            item.tooltip = this.shaderEntryPointTooltip(node);
            item.command = this.openAt(node.filePath, Math.max(0, (node.element?.line || 1) - 1));
        }

        return item;
    }

    private addShaderChildren(parent: SemanticNode, element: BevyElement): void {
        if (element.type !== 'Shader' || !element.shaderMetadata) {
            return;
        }
        for (const binding of element.shaderMetadata.bindings) {
            const child = new SemanticNode(
                `${parent.id}:binding:${binding.binding}:${binding.name}`,
                'shaderBinding',
                `@binding(${binding.binding}) ${binding.name}`,
                parent,
                element,
                element.filePath,
                binding
            );
            parent.children.push(child);
            this.nodes.set(child.id, child);
        }
        for (const entryPoint of element.shaderMetadata.entryPoints) {
            const child = new SemanticNode(
                `${parent.id}:entry:${entryPoint.type}:${entryPoint.name}`,
                'shaderEntryPoint',
                entryPoint.name,
                parent,
                element,
                element.filePath,
                undefined,
                entryPoint
            );
            parent.children.push(child);
            this.nodes.set(child.id, child);
        }
    }

    private rebuildDiagnostics(): void {
        this.diagnostics.clear();
        for (const [filePath] of this.fileNodes) {
            const values = vscode.languages.getDiagnostics(vscode.Uri.file(filePath));
            if (values.length > 0) {
                this.diagnostics.set(filePath, values);
            }
        }
    }

    private fileDescription(elements: number, errors: number, warnings: number): string {
        const parts = [`${elements} elements`];
        if (errors > 0) parts.push(`${errors} errors`);
        if (warnings > 0) parts.push(`${warnings} warnings`);
        return parts.join(' • ');
    }

    private openAt(filePath: string, line: number): vscode.Command {
        const position = new vscode.Position(line, 0);
        return {
            command: 'vscode.open',
            title: 'Open Definition',
            arguments: [vscode.Uri.file(filePath), { selection: new vscode.Range(position, position) }]
        };
    }

    private fileTooltip(node: SemanticNode, diagnostics: readonly vscode.Diagnostic[]): vscode.MarkdownString {
        const tooltip = new vscode.MarkdownString(undefined, true);
        const elements = node.children.map(child => child.element).filter((element): element is BevyElement => !!element);
        const crateName = elements[0]?.crateName || 'workspace';
        const errors = diagnostics.filter(diagnostic => diagnostic.severity === vscode.DiagnosticSeverity.Error);
        const warnings = diagnostics.filter(diagnostic => diagnostic.severity === vscode.DiagnosticSeverity.Warning);

        tooltip.appendMarkdown(`### **${path.basename(node.filePath || node.label)}**\n\n`);
        tooltip.appendMarkdown(`* **Crate**: \`${crateName}\`\n`);
        tooltip.appendMarkdown(`* **Bevy Elements**: ${elements.length}\n`);
        tooltip.appendMarkdown(`* **Diagnostics**: ${errors.length} errors, ${warnings.length} warnings\n\n`);

        if (elements.length > 0) {
            tooltip.appendMarkdown(`---\n\n#### **Indexed Elements**\n`);
            for (const element of elements.slice(0, 20)) {
                tooltip.appendMarkdown(`* \`[${element.type}]\` **${element.name}** — line ${element.line}`);
                if (element.description) tooltip.appendMarkdown(` — ${element.description}`);
                tooltip.appendMarkdown('\n');
            }
            if (elements.length > 20) {
                tooltip.appendMarkdown(`* …and ${elements.length - 20} more\n`);
            }
            tooltip.appendMarkdown('\n');
        }

        if (diagnostics.length > 0) {
            tooltip.appendMarkdown(`---\n\n#### **Diagnostics**\n`);
            for (const diagnostic of diagnostics.slice(0, 8)) {
                const severity = diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
                tooltip.appendMarkdown(`* **${severity}** at line ${diagnostic.range.start.line + 1}: ${diagnostic.message.trim()}\n`);
            }
            if (diagnostics.length > 8) {
                tooltip.appendMarkdown(`* …and ${diagnostics.length - 8} more\n`);
            }
            tooltip.appendMarkdown('\n');
        }

        tooltip.appendMarkdown(`---\n\n\`${node.filePath || node.label}\``);
        return tooltip;
    }

    private shaderBindingTooltip(node: SemanticNode): vscode.MarkdownString {
        const binding = node.shaderBinding!;
        const tooltip = new vscode.MarkdownString(undefined, true);
        tooltip.appendMarkdown(`### **${binding.name}** \`[Shader Binding]\`\n\n`);
        tooltip.appendMarkdown(`* **Binding**: \`@binding(${binding.binding})\`\n`);
        tooltip.appendMarkdown(`* **Resource Type**: \`${binding.type}\`\n`);
        tooltip.appendMarkdown(`* **Shader**: \`${node.element?.name || path.basename(node.filePath || '')}\`\n\n`);
        tooltip.appendMarkdown(`---\n\n\`${node.filePath}\``);
        return tooltip;
    }

    private shaderEntryPointTooltip(node: SemanticNode): vscode.MarkdownString {
        const entry = node.shaderEntryPoint!;
        const tooltip = new vscode.MarkdownString(undefined, true);
        tooltip.appendMarkdown(`### **${entry.name}** \`[Shader Entry Point]\`\n\n`);
        tooltip.appendMarkdown(`* **Stage**: \`@${entry.type}\`\n`);
        if (entry.workgroupSize) {
            tooltip.appendMarkdown(`* **Workgroup Size**: \`${entry.workgroupSize}\`\n`);
        }
        tooltip.appendMarkdown(`* **Shader**: \`${node.element?.name || path.basename(node.filePath || '')}\`\n\n`);
        tooltip.appendMarkdown(`---\n\n\`${node.filePath}\``);
        return tooltip;
    }

    private elementIcon(type: BevyElement['type']): vscode.ThemeIcon {
        const test = type.startsWith('Test');
        const color = new vscode.ThemeColor(test ? 'charts.yellow' : 'charts.foreground');
        if (type.includes('Component')) return new vscode.ThemeIcon('symbol-structure', color);
        if (type.includes('Resource') || type.includes('AppSettings')) return new vscode.ThemeIcon('database', color);
        if (type.includes('SystemSet')) return new vscode.ThemeIcon('symbol-namespace', color);
        if (type.includes('SystemParam')) return new vscode.ThemeIcon('list-unordered', color);
        if (type.includes('System') || type.includes('RenderGraph')) return new vscode.ThemeIcon('gear', color);
        if (type.includes('Observer')) return new vscode.ThemeIcon('eye', color);
        if (type.includes('Event')) return new vscode.ThemeIcon('zap', color);
        if (type === 'Message') return new vscode.ThemeIcon('mail', color);
        if (type === 'Plugin') return new vscode.ThemeIcon('plug', color);
        if (type === 'Shader') return new vscode.ThemeIcon('paintcan', color);
        if (type === 'Asset') return new vscode.ThemeIcon('package', color);
        if (type === 'State') return new vscode.ThemeIcon('symbol-enum', color);
        if (type.includes('BSN')) return new vscode.ThemeIcon('symbol-interface', color);
        if (type.includes('Bundle')) return new vscode.ThemeIcon('library', color);
        return new vscode.ThemeIcon('symbol-misc', color);
    }
}
