import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BevyParser, BevyElement } from './bevyParser';
import { BevyGlobalRegistryProvider, BevySemanticExplorerProvider } from './bevyTreeView';
import { ScheduleVisualizerPanel } from './scheduleVisualizer';

function checkIsBevyProject(workspaceFolders: readonly vscode.WorkspaceFolder[]): boolean {
    for (const folder of workspaceFolders) {
        const cargoPath = path.join(folder.uri.fsPath, 'Cargo.toml');
        if (fs.existsSync(cargoPath)) {
            try {
                const content = fs.readFileSync(cargoPath, 'utf8');
                if (content.includes('bevy') || content.includes('bevy_')) {
                    return true;
                }
            } catch (err) {
                console.error('Failed to read Cargo.toml:', err);
            }
        }
    }
    return false;
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('Bevy Lens extension is now active!');
    let cachedElements: BevyElement[] = [];

    // 创建诊断集合，用于标记 System 并发读写冲突的黄色波浪线警告
    const conflictDiagnostics = vscode.languages.createDiagnosticCollection('bevy-lens');
    context.subscriptions.push(conflictDiagnostics);

    // 1. 初始化 TreeDataProviders (传入 context 以获取插件本地打包的资源路径)
    const globalRegistryProvider = new BevyGlobalRegistryProvider(context);
    const globalTreeView = vscode.window.createTreeView('bevyGlobalRegistry', {
        treeDataProvider: globalRegistryProvider,
        showCollapseAll: true
    });

    const semanticExplorerProvider = new BevySemanticExplorerProvider(context);
    const explorerTreeView = vscode.window.createTreeView('bevySemanticExplorer', {
        treeDataProvider: semanticExplorerProvider,
        showCollapseAll: true
    });

    // 2. 注册提供者到全局上下文
    context.subscriptions.push(globalTreeView);
    context.subscriptions.push(explorerTreeView);

    // 3. 执行首次解析并刷新视图
    const refreshData = async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        // 判断是否为 Bevy 项目，如果不是，清空数据并静默返回
        if (!checkIsBevyProject(workspaceFolders)) {
            globalRegistryProvider.updateData([]);
            const rootPath = workspaceFolders[0].uri.fsPath;
            semanticExplorerProvider.updateData([], rootPath);
            conflictDiagnostics.clear();
            return;
        }

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: "Bevy Lens: Analyzing ECS elements..."
        }, async () => {
            const elements = await BevyParser.parseWorkspace(workspaceFolders);
            cachedElements = elements;
            
            // 清除旧的冲突诊断
            conflictDiagnostics.clear();

            // 读取配置，如果用户启用了并发诊断才执行检测逻辑
            const config = vscode.workspace.getConfiguration('bevyLens');
            const enableConflictDiagnostics = config.get<boolean>('enableConflictDiagnostics', false);

            if (enableConflictDiagnostics) {
                // 检测系统并发读写冲突（一帧延迟问题）
                const systems = elements.filter(e => e.type === 'System' && e.systemMetadata && e.systemMetadata.schedulePhase);
                const diagnosticsMap = new Map<string, vscode.Diagnostic[]>();

                // 将 systems 按照 schedulePhase 分组以减少比对数量
                const phaseGroups = new Map<string, typeof systems>();
                for (const sys of systems) {
                    const phase = sys.systemMetadata!.schedulePhase!;
                    if (!phaseGroups.has(phase)) {
                        phaseGroups.set(phase, []);
                    }
                    phaseGroups.get(phase)!.push(sys);
                }

                for (const [phase, groupSystems] of phaseGroups.entries()) {
                    for (let i = 0; i < groupSystems.length; i++) {
                        const sysA = groupSystems[i];
                        const metaA = sysA.systemMetadata!;

                        for (let j = i + 1; j < groupSystems.length; j++) {
                            const sysB = groupSystems[j];
                            const metaB = sysB.systemMetadata!;

                            let conflictItem = '';
                            let isConflict = false;

                            // 1. 资源冲突
                            for (const res of metaA.mutableResources) {
                                if (metaB.mutableResources.includes(res) || metaB.readableResources.includes(res)) {
                                    conflictItem = `resource '${res}'`;
                                    isConflict = true;
                                    break;
                                }
                            }
                            if (!isConflict) {
                                for (const res of metaB.mutableResources) {
                                    if (metaA.readableResources.includes(res)) {
                                        conflictItem = `resource '${res}'`;
                                        isConflict = true;
                                        break;
                                    }
                                }
                            }

                            // 2. 组件冲突
                            if (!isConflict) {
                                for (const comp of metaA.mutableComponents) {
                                    if (metaB.mutableComponents.includes(comp) || metaB.readableComponents.includes(comp)) {
                                        conflictItem = `component '${comp}'`;
                                        isConflict = true;
                                        break;
                                    }
                                }
                            }
                            if (!isConflict) {
                                for (const comp of metaB.mutableComponents) {
                                    if (metaA.readableComponents.includes(comp)) {
                                        conflictItem = `component '${comp}'`;
                                        isConflict = true;
                                        break;
                                    }
                                }
                            }

                            if (isConflict) {
                                // 检测是否显式声明了先后执行顺序
                                const isOrdered = 
                                    metaA.runsAfter.includes(sysB.name) || 
                                    metaA.runsBefore.includes(sysB.name) ||
                                    metaB.runsAfter.includes(sysA.name) || 
                                    metaB.runsBefore.includes(sysA.name) ||
                                    metaA.runsAfter.some(set => metaB.belongsToSets.includes(set)) ||
                                    metaA.runsBefore.some(set => metaB.belongsToSets.includes(set)) ||
                                    metaB.runsAfter.some(set => metaA.belongsToSets.includes(set)) ||
                                    metaB.runsBefore.some(set => metaA.belongsToSets.includes(set));

                                if (!isOrdered) {
                                    const message = `Potential System Conflict: '${sysA.name}' and '${sysB.name}' both access ${conflictItem} (at least one is mutable) in the '${metaA.schedulePhase}' schedule, but have no defined execution order. This can cause one-frame latency or race conditions.`;
                                    
                                    const diagRangeA = new vscode.Range(new vscode.Position(sysA.line - 1, 0), new vscode.Position(sysA.line - 1, 80));
                                    const diagA = new vscode.Diagnostic(diagRangeA, message, vscode.DiagnosticSeverity.Warning);
                                    diagA.source = 'Bevy Lens';
                                    if (!diagnosticsMap.has(sysA.filePath)) diagnosticsMap.set(sysA.filePath, []);
                                    diagnosticsMap.get(sysA.filePath)!.push(diagA);

                                    const diagRangeB = new vscode.Range(new vscode.Position(sysB.line - 1, 0), new vscode.Position(sysB.line - 1, 80));
                                    const diagB = new vscode.Diagnostic(diagRangeB, message, vscode.DiagnosticSeverity.Warning);
                                    diagB.source = 'Bevy Lens';
                                    if (!diagnosticsMap.has(sysB.filePath)) diagnosticsMap.set(sysB.filePath, []);
                                    diagnosticsMap.get(sysB.filePath)!.push(diagB);
                                }
                            }
                        }
                    }
                }

                // 应用诊断到 VS Code
                for (const [filePath, diags] of diagnosticsMap.entries()) {
                    conflictDiagnostics.set(vscode.Uri.file(filePath), diags);
                }
            }

            // 更新全局注册表数据
            globalRegistryProvider.updateData(elements);

            // 更新 Bevy 语义目录树数据
            const rootPath = workspaceFolders[0].uri.fsPath;
            semanticExplorerProvider.updateData(elements, rootPath);

            // 如果可视化面板已打开，则同步更新数据
            if (ScheduleVisualizerPanel.currentPanel) {
                ScheduleVisualizerPanel.currentPanel.updateData(cachedElements);
            }
        });
    };

    // 触发首次解析
    await refreshData();

    // 4. 注册命令
    // 注册 ECS 调度可视化命令
    const openVisualizerCmd = vscode.commands.registerCommand('bevy-lens.openScheduleVisualizer', () => {
        ScheduleVisualizerPanel.createOrShow(context.extensionUri, cachedElements);
    });
    context.subscriptions.push(openVisualizerCmd);

    // 刷新命令
    const refreshCmd = vscode.commands.registerCommand('bevy-lens.refresh', async () => {
        await refreshData();
        vscode.window.showInformationMessage('Bevy Lens: Elements refreshed successfully');
    });
    context.subscriptions.push(refreshCmd);

    // 模糊匹配搜索命令
    const searchCmd = vscode.commands.registerCommand('bevy-lens.search', async () => {
        const filter = await vscode.window.showInputBox({
            prompt: 'Enter name to filter Bevy elements',
            placeHolder: 'e.g., Player, Movement, Collision'
        });
        
        if (filter !== undefined) {
            globalRegistryProvider.setSearchFilter(filter);
        }
    });
    context.subscriptions.push(searchCmd);

    // 重置搜索过滤条件命令
    const resetSearchCmd = vscode.commands.registerCommand('bevy-lens.resetSearch', () => {
        globalRegistryProvider.setSearchFilter('');
    });
    context.subscriptions.push(resetSearchCmd);

    // 切换排序方式命令
    const changeSortOrderCmd = vscode.commands.registerCommand('bevy-lens.changeSortOrder', async () => {
        const options = [
            { label: 'Alphabetical', description: 'Sort elements alphabetically by name (A-Z)', value: 'alphabetical' },
            { label: 'File Position', description: 'Sort elements by their line position in the source file', value: 'position' }
        ];

        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: 'Select registry elements sort order'
        });

        if (selected) {
            const config = vscode.workspace.getConfiguration('bevyLens');
            await config.update('sortBy', selected.value, vscode.ConfigurationTarget.Global);
            // 刷新 TreeViews 以应用新的排序方式
            globalRegistryProvider.refresh();
            semanticExplorerProvider.refresh();
            vscode.window.showInformationMessage(`Bevy Lens: Sorted by ${selected.label.toLowerCase()}`);
        }
    });
    context.subscriptions.push(changeSortOrderCmd);

    // 5. 监听文件系统变动（自动增量重载）
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{rs,wgsl,wesl}');
    fileWatcher.onDidChange(async () => await refreshData());
    fileWatcher.onDidCreate(async () => await refreshData());
    fileWatcher.onDidDelete(async () => await refreshData());
    context.subscriptions.push(fileWatcher);

    // 6. 监听当前激活编辑器的变化 (双向定位)
    const activeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) { return; }
        
        // 只有当 Bevy 语义视图当前被用户激活且可见时，才执行 reveal。
        // 如果 visible 为 false 证明用户没有在看这个插件视图，绝对不进行 reveal 破坏用户当前排版
        if (!explorerTreeView.visible) {
            return;
        }

        const filePath = editor.document.uri.fsPath;
        const fileNode = semanticExplorerProvider.findFileNode(filePath);
        
        if (fileNode) {
            // 通过 select: true 会高亮选择该节点（使用编辑器主题自带的灰色背景），
            // focus: false 能够确保键盘焦点仍然稳定留在编辑器中不被抢占。
            explorerTreeView.reveal(fileNode, {
                select: true,
                focus: false,
                expand: true
            }).then(
                () => {},
                (err) => console.warn('Reveal file node failed:', err)
            );
        }
    });
    context.subscriptions.push(activeEditorListener);

    // 7. 监听诊断信息发生变化（rust-analyzer 报错刷新）
    const diagListener = vscode.languages.onDidChangeDiagnostics((event) => {
        // 诊断信息刷新时，只针对发生变化的 URI 进行增量更新，避免全局扫描卡顿
        globalRegistryProvider.updateDiagnostics(event.uris);
        semanticExplorerProvider.updateDiagnostics(event.uris);
    });
    context.subscriptions.push(diagListener);

    // 8. 注册资源管理器模拟命令
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const getTargetDirPath = (node: any): string => {
        if (!node || !node.fsPath) {
            return (workspaceFolders && workspaceFolders.length > 0) ? workspaceFolders[0].uri.fsPath : '';
        }
        if (node.kind === 'directory') {
            return node.fsPath;
        }
        return path.dirname(node.fsPath);
    };

    // 新建文件
    const newFileCmd = vscode.commands.registerCommand('bevy-lens.explorer.newFile', async (node?: any) => {
        const targetDir = getTargetDirPath(node);
        if (!targetDir) return;
        const fileName = await vscode.window.showInputBox({
            prompt: 'Enter the name of the new file',
            placeHolder: 'e.g. plugin.rs, shader.wgsl'
        });
        if (!fileName) return;

        const filePath = path.join(targetDir, fileName);
        if (fs.existsSync(filePath)) {
            vscode.window.showErrorMessage(`File already exists: ${fileName}`);
            return;
        }

        try {
            fs.writeFileSync(filePath, '', 'utf8');
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(doc);
            await refreshData();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to create file: ${err.message}`);
        }
    });
    context.subscriptions.push(newFileCmd);

    // 新建模板文件
    const newFileFromTemplateCmd = vscode.commands.registerCommand('bevy-lens.explorer.newFileFromTemplate', async (node?: any) => {
        const targetDir = getTargetDirPath(node);
        if (!targetDir) return;

        // 1. Choose template
        const templates = [
            { label: 'Bevy Plugin', description: 'Module entry point implementing Plugin trait', ext: '.rs' },
            { label: 'Bevy System', description: 'Function system parameter signature skeleton', ext: '.rs' },
            { label: 'Bevy ECS Types', description: 'Boilerplate for Component, Resource, and Event', ext: '.rs' },
            { label: 'WGSL Custom Shader', description: 'Fragment shader material template', ext: '.wgsl' }
        ];

        const selectedTemplate = await vscode.window.showQuickPick(templates, {
            placeHolder: 'Select a Bevy template'
        });
        if (!selectedTemplate) return;

        // 2. Enter filename/name
        const nameInput = await vscode.window.showInputBox({
            prompt: `Enter the name of the new ${selectedTemplate.label.toLowerCase()}`,
            placeHolder: selectedTemplate.ext === '.wgsl' ? 'custom_material' : 'player_movement'
        });
        if (!nameInput) return;

        // Clean names for replacement
        // CamelCase Name e.g. "player_movement" -> "PlayerMovement"
        const pascalCase = nameInput
            .replace(/(?:^\w|[A-Z]|\b\w)/g, (word) => word.toUpperCase())
            .replace(/\s+|_|-/g, '');
        
        // snake_case Name
        const snakeCase = nameInput
            .replace(/\s+|-/g, '_')
            .toLowerCase();

        // Target file name
        const fileName = snakeCase.endsWith(selectedTemplate.ext) 
            ? snakeCase 
            : `${snakeCase}${selectedTemplate.ext}`;

        const filePath = path.join(targetDir, fileName);
        if (fs.existsSync(filePath)) {
            vscode.window.showErrorMessage(`File already exists: ${fileName}`);
            return;
        }

        // 3. Template code resolution
        let fileContent = '';
        if (selectedTemplate.label === 'Bevy Plugin') {
            fileContent = `use bevy::prelude::*;\n\npub struct ${pascalCase}Plugin;\n\nimpl Plugin for ${pascalCase}Plugin {\n    fn build(&self, app: &mut App) {\n        // app.add_systems(Update, my_system);\n    }\n}\n`;
        } else if (selectedTemplate.label === 'Bevy System') {
            fileContent = `use bevy::prelude::*;\n\npub fn ${snakeCase}_system(\n    mut commands: Commands,\n    time: Res<Time>,\n) {\n    // system logic\n}\n`;
        } else if (selectedTemplate.label === 'Bevy ECS Types') {
            fileContent = `use bevy::prelude::*;\n\n#[derive(Component, Debug, Default, Reflect)]\n#[reflect(Component)]\npub struct ${pascalCase}Component {\n    // fields\n}\n\n#[derive(Resource, Debug, Default, Reflect)]\n#[reflect(Resource)]\npub struct ${pascalCase}Resource {\n    // fields\n}\n\n#[derive(Event, Debug)]\npub struct ${pascalCase}Event {\n    // fields\n}\n`;
        } else if (selectedTemplate.label === 'WGSL Custom Shader') {
            fileContent = `#import bevy_pbr::mesh_view_bindings::globals\n#import bevy_pbr::forward_io::VertexOutput\n\n@group(2) @binding(0) var<uniform> base_color: vec4<f32>;\n\n@fragment\nfn fragment(in: VertexOutput) -> @location(0) vec4<f32> {\n    return base_color;\n}\n`;
        }

        try {
            fs.writeFileSync(filePath, fileContent, 'utf8');
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(doc);
            await refreshData();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to create file: ${err.message}`);
        }
    });
    context.subscriptions.push(newFileFromTemplateCmd);

    // 新建文件夹
    const newFolderCmd = vscode.commands.registerCommand('bevy-lens.explorer.newFolder', async (node?: any) => {
        const targetDir = getTargetDirPath(node);
        if (!targetDir) return;
        const folderName = await vscode.window.showInputBox({
            prompt: 'Enter the name of the new folder',
            placeHolder: 'e.g. components, systems'
        });
        if (!folderName) return;

        const folderPath = path.join(targetDir, folderName);
        if (fs.existsSync(folderPath)) {
            vscode.window.showErrorMessage(`Folder already exists: ${folderName}`);
            return;
        }

        try {
            fs.mkdirSync(folderPath, { recursive: true });
            await refreshData();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to create folder: ${err.message}`);
        }
    });
    context.subscriptions.push(newFolderCmd);

    // 重命名
    const renameCmd = vscode.commands.registerCommand('bevy-lens.explorer.rename', async (node?: any) => {
        if (!node || !node.fsPath) {
            vscode.window.showErrorMessage('No file or folder selected to rename');
            return;
        }
        const oldPath = node.fsPath;
        const oldName = path.basename(oldPath);
        const newName = await vscode.window.showInputBox({
            prompt: `Rename '${oldName}'`,
            value: oldName
        });
        if (!newName || newName === oldName) return;

        const newPath = path.join(path.dirname(oldPath), newName);
        if (fs.existsSync(newPath)) {
            vscode.window.showErrorMessage(`A file or folder already exists at destination: ${newName}`);
            return;
        }

        try {
            fs.renameSync(oldPath, newPath);
            await refreshData();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to rename: ${err.message}`);
        }
    });
    context.subscriptions.push(renameCmd);

    // 删除
    const deleteCmd = vscode.commands.registerCommand('bevy-lens.explorer.delete', async (node?: any) => {
        if (!node || !node.fsPath) {
            vscode.window.showErrorMessage('No file or folder selected to delete');
            return;
        }
        const targetPath = node.fsPath;
        const targetName = path.basename(targetPath);
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete '${targetName}'?`,
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') return;

        try {
            const stat = fs.statSync(targetPath);
            if (stat.isDirectory()) {
                fs.rmSync(targetPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(targetPath);
            }
            await refreshData();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to delete: ${err.message}`);
        }
    });
    context.subscriptions.push(deleteCmd);

    // 定位到资源管理器
    const revealCmd = vscode.commands.registerCommand('bevy-lens.explorer.reveal', async (node?: any) => {
        if (!node || !node.fsPath) return;
        
        const fileUri = vscode.Uri.file(node.fsPath);
        try {
            // 使用 VS Code 平台内置的 revealInExplorer 命令，能完美兼容本地、WSL 及远程开发环境，
            // 自动在左侧原生 File Explorer 中展开定位当前文件/文件夹。
            await vscode.commands.executeCommand('revealInExplorer', fileUri);
        } catch (err) {
            // 回退到 revealFileInOS (在系统外壳管理器中打开)
            vscode.commands.executeCommand('revealFileInOS', fileUri);
        }
    });
    context.subscriptions.push(revealCmd);
}

export function deactivate() {}
