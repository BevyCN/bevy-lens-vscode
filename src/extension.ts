import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BevyParser, BevyElement } from './bevyParser';
import { BevyGlobalRegistryProvider, BevySemanticExplorerProvider, BevySemanticExplorerDragAndDropController, ExplorerNode } from './bevyTreeView';
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
        showCollapseAll: true,
        dragAndDropController: new BevySemanticExplorerDragAndDropController(semanticExplorerProvider),
        canSelectMany: true
    });

    // 2. 注册提供者到全局上下文
    context.subscriptions.push(globalTreeView);
    context.subscriptions.push(explorerTreeView);

    // 数据后处理、读写冲突检测与分发更新逻辑
    const processParsedElements = (elements: BevyElement[]) => {
        cachedElements = elements;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        
        // 清除旧的冲突诊断
        conflictDiagnostics.clear();

        // 读取配置，如果用户启用了并发诊断才执行检测逻辑
        const config = vscode.workspace.getConfiguration('bevyLens');
        const enableConflictDiagnostics = config.get<boolean>('enableConflictDiagnostics', false);

        if (enableConflictDiagnostics && workspaceFolders && workspaceFolders.length > 0) {
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
        if (workspaceFolders && workspaceFolders.length > 0) {
            const rootPath = workspaceFolders[0].uri.fsPath;
            semanticExplorerProvider.updateData(elements, rootPath);
        }

        // 如果可视化面板已打开，则同步更新数据
        if (ScheduleVisualizerPanel.currentPanel) {
            ScheduleVisualizerPanel.currentPanel.updateData(cachedElements);
        }

        // 数据更新重绘树后，防抖 100ms 自动定位并恢复当前打开文件的展开和高亮状态
        setTimeout(() => {
            revealActiveEditor();
        }, 100);
    };

    // 3. 执行首次全量解析并刷新视图
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

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: "Bevy Lens: Analyzing ECS elements..."
        }, async () => {
            const elements = await BevyParser.parseWorkspace(workspaceFolders);
            processParsedElements(elements);
        });
    };

    // 增量变更文件队列与防抖定时器
    const changedUris: Set<string> = new Set();
    let fileChangeTimer: any = undefined;

    const handleFileChange = (uri: vscode.Uri) => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }
        if (!checkIsBevyProject(workspaceFolders)) {
            return;
        }

        changedUris.add(uri.fsPath);
        if (fileChangeTimer) {
            clearTimeout(fileChangeTimer);
        }
        fileChangeTimer = setTimeout(async () => {
            const urisToProcess = Array.from(changedUris).map(p => vscode.Uri.file(p));
            changedUris.clear();

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: "Bevy Lens: Updating ECS elements..."
            }, async () => {
                const elements = await BevyParser.updateIncremental(urisToProcess);
                processParsedElements(elements);
            });
        }, 300); // 300ms 防抖
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

    // 5. 监听文件系统变动（自动防抖增量重载）
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{rs,wgsl,wesl}');
    fileWatcher.onDidChange((uri) => handleFileChange(uri));
    fileWatcher.onDidCreate((uri) => handleFileChange(uri));
    fileWatcher.onDidDelete((uri) => handleFileChange(uri));
    context.subscriptions.push(fileWatcher);

    // 自动高亮并定位当前编辑的文件节点
    const revealActiveEditor = () => {

        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }

        const filePath = editor.document.uri.fsPath;
        const fileNode = semanticExplorerProvider.findFileNode(filePath);
        
        if (fileNode) {
            explorerTreeView.reveal(fileNode, {
                select: true,
                focus: false,
                expand: true
            }).then(
                () => {},
                (err) => console.warn('Reveal file node failed:', err)
            );
        }
    };

    // 6. 监听当前激活编辑器的变化 (双向定位)
    const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(() => {
        revealActiveEditor();
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

    // 维护剪贴板状态
    let clipboard: { uris: vscode.Uri[]; type: 'copy' | 'cut' } | undefined = undefined;
    // 维护对比源文件路径
    let compareSelectedUri: vscode.Uri | undefined = undefined;

    // 复制递归辅助函数
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

    // 删除 (支持多选)
    const deleteCmd = vscode.commands.registerCommand('bevy-lens.explorer.delete', async (node?: any, nodes?: any[]) => {
        const targets = nodes && nodes.length > 0 ? nodes : (node ? [node] : []);
        const fileTargets = targets.filter(t => t.kind === 'file' || t.kind === 'directory');
        if (fileTargets.length === 0) {
            vscode.window.showErrorMessage('No file or folder selected to delete');
            return;
        }

        let confirmMsg = '';
        if (fileTargets.length === 1) {
            confirmMsg = `Are you sure you want to delete '${path.basename(fileTargets[0].fsPath)}'?`;
        } else {
            confirmMsg = `Are you sure you want to delete these ${fileTargets.length} items?`;
        }

        const confirm = await vscode.window.showWarningMessage(
            confirmMsg,
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') return;

        let deletedCount = 0;
        for (const target of fileTargets) {
            try {
                const stat = fs.statSync(target.fsPath);
                if (stat.isDirectory()) {
                    fs.rmSync(target.fsPath, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(target.fsPath);
                }
                deletedCount++;
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to delete '${path.basename(target.fsPath)}': ${err.message}`);
            }
        }

        if (deletedCount > 0) {
            await refreshData();
        }
    });
    context.subscriptions.push(deleteCmd);

    // 定位到资源管理器
    const revealCmd = vscode.commands.registerCommand('bevy-lens.explorer.reveal', async (node?: any) => {
        if (!node || !node.fsPath) return;
        
        const fileUri = vscode.Uri.file(node.fsPath);
        try {
            await vscode.commands.executeCommand('revealInExplorer', fileUri);
        } catch (err) {
            vscode.commands.executeCommand('revealFileInOS', fileUri);
        }
    });
    context.subscriptions.push(revealCmd);

    // 侧边打开
    const openToSideCmd = vscode.commands.registerCommand('bevy-lens.explorer.openToSide', async (node?: any) => {
        if (!node || node.kind !== 'file') return;
        const fileUri = vscode.Uri.file(node.fsPath);
        await vscode.window.showTextDocument(fileUri, {
            viewColumn: vscode.ViewColumn.Beside,
            preview: false
        });
    });
    context.subscriptions.push(openToSideCmd);

    // 打开方式...
    const openWithCmd = vscode.commands.registerCommand('bevy-lens.explorer.openWith', async (node?: any) => {
        if (!node || !node.fsPath) return;
        const fileUri = vscode.Uri.file(node.fsPath);
        await vscode.commands.executeCommand('explorer.openWith', fileUri);
    });
    context.subscriptions.push(openWithCmd);

    // 在集成终端中打开
    const openInTerminalCmd = vscode.commands.registerCommand('bevy-lens.explorer.openInTerminal', async (node?: any) => {
        const targetDir = getTargetDirPath(node);
        if (!targetDir) return;
        const terminal = vscode.window.createTerminal({
            cwd: targetDir
        });
        terminal.show();
    });
    context.subscriptions.push(openInTerminalCmd);

    // 剪切
    const cutCmd = vscode.commands.registerCommand('bevy-lens.explorer.cut', async (node?: any, nodes?: any[]) => {
        const targets = nodes && nodes.length > 0 ? nodes : (node ? [node] : []);
        const fileTargets = targets.filter(t => t.kind === 'file' || t.kind === 'directory');
        if (fileTargets.length === 0) return;

        clipboard = {
            uris: fileTargets.map(t => vscode.Uri.file(t.fsPath)),
            type: 'cut'
        };
        await vscode.commands.executeCommand('setContext', 'bevyLens.clipboardHasData', true);
        vscode.window.showInformationMessage(`Cut ${fileTargets.length} items to clipboard.`);
    });
    context.subscriptions.push(cutCmd);

    // 复制
    const copyCmd = vscode.commands.registerCommand('bevy-lens.explorer.copy', async (node?: any, nodes?: any[]) => {
        const targets = nodes && nodes.length > 0 ? nodes : (node ? [node] : []);
        const fileTargets = targets.filter(t => t.kind === 'file' || t.kind === 'directory');
        if (fileTargets.length === 0) return;

        clipboard = {
            uris: fileTargets.map(t => vscode.Uri.file(t.fsPath)),
            type: 'copy'
        };
        await vscode.commands.executeCommand('setContext', 'bevyLens.clipboardHasData', true);
        vscode.window.showInformationMessage(`Copied ${fileTargets.length} items to clipboard.`);
    });
    context.subscriptions.push(copyCmd);

    // 粘贴
    const pasteCmd = vscode.commands.registerCommand('bevy-lens.explorer.paste', async (node?: any) => {
        if (!clipboard || clipboard.uris.length === 0) {
            vscode.window.showWarningMessage('Clipboard is empty.');
            return;
        }

        const targetDir = getTargetDirPath(node);
        if (!targetDir) return;

        let hasChanged = false;
        const isWindowsPath = process.platform === 'win32';
        const normPath = (p: string) => isWindowsPath ? path.normalize(p).toLowerCase() : path.normalize(p);

        for (const uri of clipboard.uris) {
            const srcPath = uri.fsPath;
            if (!fs.existsSync(srcPath)) {
                vscode.window.showErrorMessage(`Source file does not exist: ${srcPath}`);
                continue;
            }

            let destPath = path.join(targetDir, path.basename(srcPath));

            // 防止把目录移入到自己或自己的子目录中
            const normSrc = normPath(srcPath);
            const normDest = normPath(destPath);
            if (normDest.startsWith(normSrc + path.sep) || normSrc === normDest) {
                if (clipboard.type === 'cut') {
                    vscode.window.showErrorMessage(`Cannot move directory into its own subdirectory`);
                    continue;
                }
            }

            // 如果同目录下粘贴并且是 copy，生成副本名称；如果是不同目录同名，自动处理
            if (fs.existsSync(destPath)) {
                if (clipboard.type === 'copy') {
                    const ext = path.extname(srcPath);
                    const base = path.basename(srcPath, ext);
                    let counter = 1;
                    do {
                        destPath = path.join(targetDir, `${base}_copy${counter}${ext}`);
                        counter++;
                    } while (fs.existsSync(destPath));
                } else {
                    // cut 覆盖确认
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
            }

            try {
                if (clipboard.type === 'copy') {
                    copyRecursiveSync(srcPath, destPath);
                } else {
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
                }
                hasChanged = true;
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to paste '${path.basename(srcPath)}': ${err.message}`);
            }
        }

        if (clipboard.type === 'cut') {
            clipboard = undefined;
            await vscode.commands.executeCommand('setContext', 'bevyLens.clipboardHasData', false);
        }

        if (hasChanged) {
            await refreshData();
        }
    });
    context.subscriptions.push(pasteCmd);

    // 选择进行对比
    const selectForCompareCmd = vscode.commands.registerCommand('bevy-lens.explorer.selectForCompare', async (node?: any) => {
        if (!node || node.kind !== 'file') return;
        compareSelectedUri = vscode.Uri.file(node.fsPath);
        await vscode.commands.executeCommand('setContext', 'bevyLens.compareSourceSelected', true);
        vscode.window.showInformationMessage(`Selected '${path.basename(node.fsPath)}' for compare.`);
    });
    context.subscriptions.push(selectForCompareCmd);

    // 与已选对比
    const compareWithSelectedCmd = vscode.commands.registerCommand('bevy-lens.explorer.compareWithSelected', async (node?: any) => {
        if (!node || node.kind !== 'file' || !compareSelectedUri) return;
        const targetUri = vscode.Uri.file(node.fsPath);
        await vscode.commands.executeCommand(
            'vscode.diff',
            compareSelectedUri,
            targetUri,
            `${path.basename(compareSelectedUri.fsPath)} ↔ ${path.basename(targetUri.fsPath)}`
        );
    });
    context.subscriptions.push(compareWithSelectedCmd);

    // 复制绝对路径
    const copyPathCmd = vscode.commands.registerCommand('bevy-lens.explorer.copyPath', async (node?: any, nodes?: any[]) => {
        const targets = nodes && nodes.length > 0 ? nodes : (node ? [node] : []);
        const fileTargets = targets.filter(t => t.kind === 'file' || t.kind === 'directory');
        if (fileTargets.length === 0) return;

        const paths = fileTargets.map(t => t.fsPath);
        await vscode.env.clipboard.writeText(paths.join('\n'));
    });
    context.subscriptions.push(copyPathCmd);

    // 复制相对路径
    const copyRelativePathCmd = vscode.commands.registerCommand('bevy-lens.explorer.copyRelativePath', async (node?: any, nodes?: any[]) => {
        const targets = nodes && nodes.length > 0 ? nodes : (node ? [node] : []);
        const fileTargets = targets.filter(t => t.kind === 'file' || t.kind === 'directory');
        if (fileTargets.length === 0) return;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const rootPath = workspaceFolders[0].uri.fsPath;
            const relativePaths = fileTargets.map(t => path.relative(rootPath, t.fsPath));
            await vscode.env.clipboard.writeText(relativePaths.join('\n'));
        }
    });
    context.subscriptions.push(copyRelativePathCmd);
}

export function deactivate() {}
