import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BevyParser } from './bevyParser';
import { BevyGlobalRegistryProvider, BevySemanticExplorerProvider } from './bevyTreeView';

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
            }            // 更新全局注册表数据
            globalRegistryProvider.updateData(elements);

            // 更新 Bevy 语义目录树数据
            const rootPath = workspaceFolders[0].uri.fsPath;
            semanticExplorerProvider.updateData(elements, rootPath);
        });
    };

    // 触发首次解析
    await refreshData();

    // 4. 注册命令
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

    // 5. 监听文件系统变动（自动增量重载）
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{rs,wgsl,wesl}');
    fileWatcher.onDidChange(async () => await refreshData());
    fileWatcher.onDidCreate(async () => await refreshData());
    fileWatcher.onDidDelete(async () => await refreshData());
    context.subscriptions.push(fileWatcher);

    // 6. 监听当前激活编辑器的变化 (双向定位)
    const activeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
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
    });
    context.subscriptions.push(activeEditorListener);

    // 7. 监听诊断信息发生变化（rust-analyzer 报错刷新）
    const diagListener = vscode.languages.onDidChangeDiagnostics((event) => {
        // 诊断信息刷新时，触发 TreeView 重新渲染来实时表现红标/黄标状态
        globalRegistryProvider.refresh();
        semanticExplorerProvider.refresh();
    });
    context.subscriptions.push(diagListener);
}

export function deactivate() {}
