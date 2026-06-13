import * as vscode from 'vscode';
import { BevyParser } from './bevyParser';
import { BevyGlobalRegistryProvider, BevySemanticExplorerProvider } from './bevyTreeView';

export async function activate(context: vscode.ExtensionContext) {
    console.log('Bevy Lens extension is now active!');

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

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: "Bevy Lens: Analyzing ECS elements..."
        }, async () => {
            const elements = await BevyParser.parseWorkspace(workspaceFolders);
            
            // 更新全局注册表数据
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
        vscode.window.showInformationMessage('Bevy Lens: 元素刷新完成');
    });
    context.subscriptions.push(refreshCmd);

    // 模糊匹配搜索命令
    const searchCmd = vscode.commands.registerCommand('bevy-lens.search', async () => {
        const filter = await vscode.window.showInputBox({
            prompt: '请输入组件、资源、事件、消息或系统的名称进行检索匹配',
            placeHolder: '例如: Player, Movement, Collision'
        });
        
        if (filter !== undefined) {
            globalRegistryProvider.setSearchFilter(filter);
        }
    });
    context.subscriptions.push(searchCmd);

    // 5. 监听文件系统变动（自动增量重载）
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{rs,wgsl}');
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
