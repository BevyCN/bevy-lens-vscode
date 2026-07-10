import * as vscode from 'vscode';
import * as fs from 'fs';
import { BevyParser, BevyElement } from './bevyParser';
import { BevyGlobalRegistryProvider } from './bevyTreeView';
import { BevySemanticViewProvider } from './bevySemanticView';
import { ScheduleVisualizerPanel } from './scheduleVisualizer';
import { ReferenceVisualizerPanel } from './referenceVisualizer';

async function checkIsBevyProject(): Promise<boolean> {
    const configuredExcludes = vscode.workspace.getConfiguration('bevyLens').get<string[]>('excludePaths', []);
    const excludeGlob = configuredExcludes.length > 1
        ? `{${configuredExcludes.join(',')}}`
        : configuredExcludes[0];
    const manifests = await vscode.workspace.findFiles('**/Cargo.toml', excludeGlob, 500);
    const contents = await Promise.all(manifests.map(async manifest => {
        try {
            return await fs.promises.readFile(manifest.fsPath, 'utf8');
        } catch {
            return '';
        }
    }));
    return contents.some(content => /^\s*bevy(?:_[A-Za-z0-9_-]+)?\s*=\s*/m.test(content));
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

    const semanticExplorerProvider = new BevySemanticViewProvider();
    const explorerTreeView = vscode.window.createTreeView('bevySemanticExplorer', {
        treeDataProvider: semanticExplorerProvider,
        showCollapseAll: true
    });

    // 2. 注册提供者到全局上下文
    context.subscriptions.push(globalTreeView);
    context.subscriptions.push(explorerTreeView);

    let lastSemanticUri: vscode.Uri | undefined;
    let revealTimer: NodeJS.Timeout | undefined;
    const isSemanticFile = (uri: vscode.Uri): boolean =>
        uri.scheme === 'file' && /\.(?:rs|wgsl|wesl)$/i.test(uri.fsPath);

    const revealSemanticFile = async (uri: vscode.Uri, focus: boolean): Promise<boolean> => {
        if (!isSemanticFile(uri)) {
            return false;
        }
        lastSemanticUri = uri;
        const node = semanticExplorerProvider.findFileNode(uri.fsPath);
        if (!node) {
            return false;
        }
        try {
            await explorerTreeView.reveal(node, { select: true, focus, expand: true });
            return true;
        } catch (error) {
            console.warn('Unable to reveal file in Bevy Semantics:', error);
            return false;
        }
    };

    const scheduleSemanticReveal = (uri?: vscode.Uri): void => {
        const target = uri || lastSemanticUri || vscode.window.activeTextEditor?.document.uri;
        if (!target || !isSemanticFile(target)) {
            return;
        }
        lastSemanticUri = target;
        if (!explorerTreeView.visible) {
            return;
        }
        if (revealTimer) {
            clearTimeout(revealTimer);
        }
        revealTimer = setTimeout(() => void revealSemanticFile(target, false), 80);
    };

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

            // Crates and Cargo targets are independent applications; never compare their schedules.
            const phaseGroups = new Map<string, typeof systems>();
            for (const sys of systems) {
                const phase = sys.systemMetadata!.schedulePhase!;
                const target = `${sys.sourceTarget?.type || 'lib'}:${sys.sourceTarget?.name || ''}`;
                const groupKey = `${sys.crateRoot || sys.crateName || 'workspace'}:${target}:${phase}`;
                if (!phaseGroups.has(groupKey)) {
                    phaseGroups.set(groupKey, []);
                }
                phaseGroups.get(groupKey)!.push(sys);
            }

            for (const groupSystems of phaseGroups.values()) {
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
        semanticExplorerProvider.updateData(elements);
        scheduleSemanticReveal();

        // 如果可视化面板已打开，则同步更新数据
        if (ScheduleVisualizerPanel.currentPanel) {
            ScheduleVisualizerPanel.currentPanel.updateData(cachedElements);
        }

        // 数据更新重绘树后，防抖 100ms 自动定位并恢复当前打开文件的展开和高亮状态
    };

    // 3. 执行首次全量解析并刷新视图
    const refreshData = async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        // 判断是否为 Bevy 项目，如果不是，清空数据并静默返回
        if (!await checkIsBevyProject()) {
            globalRegistryProvider.updateData([]);
            semanticExplorerProvider.updateData([]);
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

    context.subscriptions.push(vscode.commands.registerCommand('bevy-lens.revealInSemanticExplorer', async (uri: vscode.Uri) => {
        if (!uri && vscode.window.activeTextEditor) {
            uri = vscode.window.activeTextEditor.document.uri;
        }
        if (!uri) return;
        lastSemanticUri = uri;

        // 强行展开插件面板
        await vscode.commands.executeCommand('bevySemanticExplorer.focus');

        // 延迟触发 reveal，解决 VSCode 树视图初始化阶段展开失效的并发竞态问题
        setTimeout(() => {
            // 使用 findFileNode 创建或获取节点
            const node = semanticExplorerProvider.findFileNode(uri.fsPath);
            if (node) {
                explorerTreeView.reveal(node, { select: true, focus: true, expand: true }).then(
                    () => {},
                    (err) => console.warn('Reveal command failed:', err)
                );
            } else {
                vscode.window.showInformationMessage("This file is not in the current workspace or not indexed.");
            }
        }, 300);
    }));

    // Register Find Bevy References command
    const findReferencesCmd = vscode.commands.registerCommand('bevy-lens.findReferences', async (item?: any) => {
        let targetName = '';
        let targetType = 'Component';
        let targetUri: vscode.Uri | undefined;
        let targetPosition: vscode.Position | undefined;

        if (item) {
            if (item.element) {
                // From the Explorer-hosted semantic view.
                targetName = item.element.name;
                targetType = item.element.type;
            } else if (item.name && item.type) {
                // From Global Registry (BevyElement)
                targetName = item.name;
                targetType = item.type;
            }

            if (targetName) {
                const matchedElement = cachedElements.find(el => el.name === targetName);
                if (matchedElement && matchedElement.filePath && matchedElement.line) {
                    targetUri = vscode.Uri.file(matchedElement.filePath);
                    try {
                        const content = require('fs').readFileSync(matchedElement.filePath, 'utf8');
                        const lines = content.split(/\r?\n/);
                        const lineText = lines[matchedElement.line - 1];
                        const col = lineText.indexOf(targetName);
                        targetPosition = new vscode.Position(matchedElement.line - 1, col >= 0 ? col : 0);
                    } catch (e) {
                        targetPosition = new vscode.Position(matchedElement.line - 1, 0);
                    }
                }
            }
        }
        
        // If targetUri is not set, fallback to Editor Context
        if (!targetUri || !targetPosition) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const document = editor.document;
                const selection = editor.selection;
                targetUri = document.uri;
                targetPosition = selection.active;

                if (selection && !selection.isEmpty) {
                    targetName = document.getText(selection).trim();
                } else {
                    const range = document.getWordRangeAtPosition(targetPosition);
                    if (range) {
                        targetName = document.getText(range).trim();
                    } else {
                        const lineText = document.lineAt(targetPosition.line).text;
                        const charIdx = targetPosition.character;
                        const wordRegex = /[a-zA-Z0-9_]+/g;
                        let match;
                        while ((match = wordRegex.exec(lineText)) !== null) {
                            if (charIdx >= match.index && charIdx <= match.index + match[0].length) {
                                targetName = match[0];
                                break;
                            }
                        }
                    }
                }

                if (targetName) {
                    const matchedElement = cachedElements.find(el => el.name === targetName);
                    if (matchedElement) {
                        targetType = matchedElement.type;
                    }
                }
            }
        }

        if (!targetName) {
            vscode.window.showWarningMessage('No Bevy element selected to find references.');
            return;
        }

        const references = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Bevy Lens: Finding references for '${targetName}'...`,
            cancellable: false
        }, async () => {
            if (targetUri && targetPosition) {
                try {
                    const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                        'vscode.executeReferenceProvider',
                        targetUri,
                        targetPosition
                    );
                    if (locations && locations.length > 0) {
                        return await BevyParser.findReferencesNative(targetName, targetType, locations);
                    }
                } catch (err) {
                    console.error("Native reference provider failed, falling back to regex scanner", err);
                }
            }
            // Fallback
            return await BevyParser.findReferences(targetName, targetType);
        });

        ReferenceVisualizerPanel.createOrShow(context.extensionUri, targetName, targetType, references);
    });
    context.subscriptions.push(findReferencesCmd);

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
            semanticExplorerProvider.updateData(cachedElements);
            vscode.window.showInformationMessage(`Bevy Lens: Sorted by ${selected.label.toLowerCase()}`);
        }
    });
    context.subscriptions.push(changeSortOrderCmd);

    // 注册专门处理从 Bevy 注册表面板点击定位打开文件的命令
    const registryOpenFileCmd = vscode.commands.registerCommand('bevy-lens.registry.openFile', async (uri: vscode.Uri, options?: vscode.TextDocumentShowOptions) => {
        // 先通过内置命令打开对应的文档
        await vscode.commands.executeCommand('vscode.open', uri, options);
        // 然后强制联动定位，无视其当前的 visible 状态
    });
    context.subscriptions.push(registryOpenFileCmd);

    // 5. 监听文件系统变动（自动防抖增量重载）
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{rs,wgsl,wesl}');
    fileWatcher.onDidChange((uri) => handleFileChange(uri));
    fileWatcher.onDidCreate((uri) => handleFileChange(uri));
    fileWatcher.onDidDelete((uri) => handleFileChange(uri));
    context.subscriptions.push(fileWatcher);

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            scheduleSemanticReveal(editor.document.uri);
        }
    }));
    context.subscriptions.push(explorerTreeView.onDidChangeVisibility(event => {
        if (event.visible) {
            scheduleSemanticReveal();
        }
    }));

    // Cargo metadata changes can alter crate names and boundaries.
    const cargoWatcher = vscode.workspace.createFileSystemWatcher('**/Cargo.toml');
    cargoWatcher.onDidChange(() => refreshData());
    cargoWatcher.onDidCreate(() => refreshData());
    cargoWatcher.onDidDelete(() => refreshData());
    context.subscriptions.push(cargoWatcher);

    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => refreshData()));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('bevyLens.excludePaths')
            || event.affectsConfiguration('bevyLens.customRenderGraphSchedules')
            || event.affectsConfiguration('bevyLens.enableConflictDiagnostics')) {
            void refreshData();
        } else if (event.affectsConfiguration('bevyLens.sortBy')) {
            globalRegistryProvider.refresh();
            semanticExplorerProvider.updateData(cachedElements);
        }
    }));

    // 7. 监听诊断信息发生变化（rust-analyzer 报错刷新）
    const diagListener = vscode.languages.onDidChangeDiagnostics((event) => {
        // 诊断信息刷新时，只针对发生变化的 URI 进行增量更新，避免全局扫描卡顿
        globalRegistryProvider.updateDiagnostics(event.uris);
        semanticExplorerProvider.updateDiagnostics(event.uris);
    });
    context.subscriptions.push(diagListener);

}

export function deactivate() {}
