import * as vscode from 'vscode';
import * as path from 'path';
import { BevyElement } from './bevyParser';

export class ScheduleVisualizerPanel {
    public static currentPanel: ScheduleVisualizerPanel | undefined;
    private static readonly viewType = 'bevyScheduleVisualizer';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _systems: any[] = [];

    public static createOrShow(extensionUri: vscode.Uri, elements: BevyElement[]) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ScheduleVisualizerPanel.currentPanel) {
            ScheduleVisualizerPanel.currentPanel._panel.reveal(vscode.ViewColumn.Two);
            ScheduleVisualizerPanel.currentPanel.updateData(elements);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ScheduleVisualizerPanel.viewType,
            'ECS Schedule Visualizer',
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        ScheduleVisualizerPanel.currentPanel = new ScheduleVisualizerPanel(panel, extensionUri, elements);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, elements: BevyElement[]) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._systems = this._getSystems(elements);

        this._updateHtml();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'jumpTo':
                        const { filePath, line } = message.data;
                        if (filePath && line) {
                            vscode.workspace.openTextDocument(filePath).then(doc => {
                                vscode.window.showTextDocument(doc, {
                                    viewColumn: vscode.ViewColumn.One,
                                    preview: false,
                                    selection: new vscode.Range(new vscode.Position(line - 1, 0), new vscode.Position(line - 1, 0))
                                });
                            });
                        }
                        break;
                    case 'requestInitData':
                        this._sendInitData();
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public updateData(elements: BevyElement[]) {
        this._systems = this._getSystems(elements);
        this._panel.webview.postMessage({
            command: 'update',
            data: this._systems
        });
    }

    private _sendInitData() {
        this._panel.webview.postMessage({
            command: 'init',
            data: this._systems
        });
    }

    private _getSystems(elements: BevyElement[]) {
        return elements.filter(e => 
            e.type === 'System' || e.type === 'TestSystem' ||
            e.type === 'MainSystem' || e.type === 'TestMainSystem' ||
            e.type === 'RenderSystem' || e.type === 'TestRenderSystem' ||
            e.type === 'RenderGraph' || e.type === 'TestRenderGraph'
        ).map(e => ({
            name: e.name,
            filePath: e.filePath,
            line: e.line,
            crateName: e.crateName || 'unknown',
            sourceTarget: e.sourceTarget || { type: 'lib' },
            description: e.description,
            systemMetadata: e.systemMetadata || {
                mutableResources: [],
                readableResources: [],
                mutableComponents: [],
                readableComponents: [],
                schedulePhase: 'Update',
                belongsToSets: [],
                runConditions: [],
                runsAfter: [],
                runsBefore: []
            }
        }));
    }

    public dispose() {
        ScheduleVisualizerPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _updateHtml() {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ECS Schedule Visualizer</title>
    <script type="text/javascript" src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
    <style>
        body {
            margin: 0;
            padding: 0;
            overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background: linear-gradient(135deg, #0a0d14 0%, #10141f 100%);
            color: #e2e8f0;
            user-select: none;
        }

        #mynetwork {
            width: 100vw;
            height: 100vh;
            position: absolute;
            top: 0;
            left: 0;
            background: radial-gradient(circle, rgba(255,255,255,0.012) 1px, transparent 1px);
            background-size: 20px 20px;
        }

        .glass-panel {
            background: rgba(16, 20, 31, 0.78);
            backdrop-filter: blur(18px);
            -webkit-backdrop-filter: blur(18px);
            border: 1px solid rgba(255, 255, 255, 0.06);
            border-radius: 12px;
            box-shadow: 0 10px 36px 0 rgba(0, 0, 0, 0.45);
        }

        .control-panel {
            position: absolute;
            top: 20px;
            left: 20px;
            z-index: 10;
            padding: 16px;
            width: 310px;
        }

        .panel-title {
            font-size: 15px;
            font-weight: 700;
            margin-bottom: 16px;
            color: #f8fafc;
            display: flex;
            align-items: center;
            gap: 8px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            padding-bottom: 8px;
        }

        .control-group {
            margin-bottom: 12px;
        }

        .control-group label {
            display: block;
            font-size: 11px;
            font-weight: 600;
            margin-bottom: 6px;
            color: #94a3b8;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        .control-select, .control-input {
            width: 100%;
            background: rgba(9, 12, 20, 0.7);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 6px;
            padding: 8px 10px;
            color: #f1f5f9;
            box-sizing: border-box;
            outline: none;
            transition: all 0.2s;
            font-size: 12px;
        }

        .control-select:focus, .control-input:focus {
            border-color: #3b82f6;
            box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
        }

        .toggle-group {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-top: 12px;
        }

        .toggle-label {
            font-size: 12.5px;
            color: #cbd5e1;
        }

        .switch {
            position: relative;
            display: inline-block;
            width: 40px;
            height: 20px;
        }

        .switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: #334155;
            transition: .25s;
            border-radius: 20px;
        }

        .slider:before {
            position: absolute;
            content: "";
            height: 14px;
            width: 14px;
            left: 3px;
            bottom: 3px;
            background-color: white;
            transition: .25s;
            border-radius: 50%;
        }

        input:checked + .slider {
            background-color: #3b82f6;
        }

        input:checked + .slider:before {
            transform: translateX(20px);
        }

        .details-panel {
            position: absolute;
            top: 20px;
            right: 20px;
            z-index: 10;
            padding: 20px;
            width: 330px;
            max-height: 80vh;
            overflow-y: auto;
            display: none;
        }

        .details-title {
            font-size: 15px;
            font-weight: 700;
            margin-bottom: 10px;
            color: #3b82f6;
            word-break: break-all;
        }

        .details-desc {
            font-size: 12px;
            color: #94a3b8;
            margin-bottom: 16px;
            font-style: italic;
            word-break: break-all;
        }

        .details-section {
            margin-bottom: 12px;
        }

        .section-header {
            font-size: 10.5px;
            font-weight: 600;
            color: #64748b;
            text-transform: uppercase;
            margin-bottom: 6px;
            letter-spacing: 0.05em;
        }

        .badge-list {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }

        .badge {
            font-size: 10.5px;
            padding: 2.5px 7px;
            border-radius: 4px;
            font-family: monospace;
        }

        .badge-mut {
            background: rgba(239, 68, 68, 0.12);
            color: #fca5a5;
            border: 1px solid rgba(239, 68, 68, 0.18);
        }

        .badge-read {
            background: rgba(59, 130, 246, 0.12);
            color: #93c5fd;
            border: 1px solid rgba(59, 130, 246, 0.18);
        }

        .badge-set {
            background: rgba(245, 158, 11, 0.12);
            color: #fde047;
            border: 1px solid rgba(245, 158, 11, 0.18);
        }

        .badge-cond {
            background: rgba(16, 185, 129, 0.12);
            color: #6ee7b7;
            border: 1px solid rgba(16, 185, 129, 0.18);
        }

        .jump-btn {
            background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
            color: white;
            border: none;
            border-radius: 6px;
            padding: 8px 16px;
            font-weight: 600;
            cursor: pointer;
            width: 100%;
            margin-top: 12px;
            box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
            transition: all 0.2s ease;
            outline: none;
            font-size: 12.5px;
        }

        .jump-btn:hover {
            background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
            box-shadow: 0 6px 16px rgba(59, 130, 246, 0.4);
            transform: translateY(-1px);
        }

        .conflict-list {
            margin-top: 8px;
            padding: 10px;
            background: rgba(239, 68, 68, 0.06);
            border: 1px solid rgba(239, 68, 68, 0.12);
            border-radius: 6px;
        }

        .conflict-item {
            font-size: 11.5px;
            color: #fca5a5;
            margin-bottom: 6px;
            word-break: break-all;
        }

        .conflict-item:last-child {
            margin-bottom: 0;
        }

        ::-webkit-scrollbar {
            width: 4px;
        }
        ::-webkit-scrollbar-track {
            background: transparent;
        }
        ::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.12);
            border-radius: 2px;
        }
    </style>
</head>
<body>
    <div id="mynetwork"></div>

    <div class="control-panel glass-panel">
        <div class="panel-title">
            <svg style="width:18px;height:18px" viewBox="0 0 24 24">
                <path fill="currentColor" d="M19,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3M19,19H5V5H19V19M16,17H8V15H16V17M16,13H8V11H16V13M16,9H8V7H16V9Z" />
            </svg>
            Schedule Visualizer
        </div>

        <div class="control-group">
            <label for="targetSelect">Build Target</label>
            <select id="targetSelect" class="control-select"></select>
        </div>

        <div class="control-group">
            <label for="searchBox">Search System</label>
            <input type="text" id="searchBox" class="control-input" placeholder="Type system name...">
        </div>

        <div class="toggle-group">
            <span class="toggle-label">Highlight Race Risks</span>
            <label class="switch">
                <input type="checkbox" id="toggleConflict" checked>
                <span class="slider"></span>
            </label>
        </div>

        <div class="toggle-group">
            <span class="toggle-label">Hide Bevy Internal Systems</span>
            <label class="switch">
                <input type="checkbox" id="toggleInternal" checked>
                <span class="slider"></span>
            </label>
        </div>
    </div>

    <div id="detailsPanel" class="details-panel glass-panel">
        <div id="detailsTitle" class="details-title">SystemName</div>
        <div id="detailsDesc" class="details-desc">File path and line</div>
        
        <div class="details-section">
            <div class="section-header">Target / Crate</div>
            <div id="detailsTarget" style="font-size:11.5px; color:#cbd5e1;">example: movement</div>
        </div>

        <div class="details-section">
            <div class="section-header">Mutable Resources (Write)</div>
            <div id="mutResources" class="badge-list"></div>
        </div>

        <div class="details-section">
            <div class="section-header">Readable Resources (Read)</div>
            <div id="readResources" class="badge-list"></div>
        </div>

        <div class="details-section">
            <div class="section-header">Mutable Components (Write)</div>
            <div id="mutComponents" class="badge-list"></div>
        </div>

        <div class="details-section">
            <div class="section-header">Readable Components (Read)</div>
            <div id="readComponents" class="badge-list"></div>
        </div>

        <div class="details-section">
            <div class="section-header">System Sets</div>
            <div id="detailsSets" class="badge-list"></div>
        </div>

        <div class="details-section">
            <div class="section-header">Run Conditions</div>
            <div id="detailsConds" class="badge-list"></div>
        </div>

        <div id="conflictSection" class="details-section" style="display:none;">
            <div class="section-header" style="color:#f87171;">⚠️ Race Ambiguity Warnings</div>
            <div id="conflictList" class="conflict-list"></div>
        </div>

        <button id="jumpBtn" class="jump-btn">Open in Editor</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let allSystems = [];
        let network = null;
        let selectedNodeId = null;

        // Bevy 默认的 Main World 阶段流
        const mainPhases = ['First', 'PreUpdate', 'StateTransition', 'RunFixedUpdateLoop', 'Update', 'PostUpdate', 'Last'];
        
        // Bevy 默认的 Render World 渲染步骤流
        const renderSteps = [
            'ExtractCommands', 'PrepareAssets', 'PrepareMeshes', 'ManageViews', 'Queue', 
            'QueueMeshes', 'QueueSweep', 'PhaseSort', 'Prepare', 'PrepareResources', 
            'PrepareResourcesCollectPhaseBuffers', 'PrepareResourcesFlush', 'PrepareBindGroups', 
            'Render', 'Cleanup', 'PostCleanup'
        ];

        vscode.postMessage({ command: 'requestInitData' });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'init':
                case 'update':
                    allSystems = message.data;
                    rebuildFilters();
                    drawGraph();
                    break;
            }
        });

        const targetSelect = document.getElementById('targetSelect');
        const searchBox = document.getElementById('searchBox');
        const toggleConflict = document.getElementById('toggleConflict');
        const toggleInternal = document.getElementById('toggleInternal');
        const detailsPanel = document.getElementById('detailsPanel');
        const jumpBtn = document.getElementById('jumpBtn');

        targetSelect.addEventListener('change', () => { drawGraph(); hideDetails(); });
        searchBox.addEventListener('input', () => { highlightSearchedNode(); });
        toggleConflict.addEventListener('change', () => drawGraph());
        toggleInternal.addEventListener('change', () => { rebuildFilters(); drawGraph(); });

        function hideDetails() {
            detailsPanel.style.display = 'none';
            selectedNodeId = null;
        }

        function rebuildFilters() {
            const currentTarget = targetSelect.value;
            const targetSet = new Set();
            const hideInternal = toggleInternal.checked;
            
            allSystems.forEach(s => {
                if (hideInternal) {
                    const c = (s.crateName || '').toLowerCase();
                    if (s.sourceTarget.type === 'lib' && (c.startsWith('bevy') || c === 'winit' || c === 'wgpu' || c === 'std')) {
                        return;
                    }
                }
                const type = s.sourceTarget.type;
                const name = s.sourceTarget.name;
                if (type === 'lib') {
                    targetSet.add('lib');
                } else {
                    targetSet.add(type + ':' + (name || 'unknown'));
                }
            });

            targetSelect.innerHTML = '';
            const targets = Array.from(targetSet).sort();
            targets.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t;
                if (t === 'lib') {
                    opt.textContent = 'Shared Library (Lib)';
                } else {
                    opt.textContent = t.startsWith('example:') ? 'Example: ' + t.substring(8) : 'Binary: ' + t.substring(4);
                }
                targetSelect.appendChild(opt);
            });

            if (currentTarget && targetSet.has(currentTarget)) {
                targetSelect.value = currentTarget;
            } else if (targets.length > 0) {
                const nonLib = targets.find(t => t !== 'lib');
                targetSelect.value = nonLib || targets[0];
            }
        }

        // 判断系统属于 Main World 还是 Render World
        function getWorld(s) {
            const phase = s.systemMetadata.schedulePhase || '';
            const sets = s.systemMetadata.belongsToSets || [];
            
            const isRenderPhase = /render|extract|cleanup/i.test(phase);
            const isRenderSet = sets.some(set => /rendersystems|render|extract|queue/i.test(set));
            
            if (isRenderPhase || isRenderSet) {
                return 'render';
            }
            return 'main';
        }

        // 获取 Render 系统在 Render World 内部的子步骤
        function getRenderStep(s) {
            const phase = s.systemMetadata.schedulePhase || '';
            const sets = s.systemMetadata.belongsToSets || [];
            
            for (const step of renderSteps) {
                if (sets.some(set => set.includes(step))) {
                    return step;
                }
            }
            
            if (phase.includes('ExtractSchedule') || phase.includes('ExtractCommands')) {
                return 'ExtractCommands';
            }
            
            return 'Render';
        }

        function highlightSearchedNode() {
            if (!network) return;
            const query = searchBox.value.trim().toLowerCase();
            if (!query) {
                drawGraph();
                return;
            }

            const nodesUpdate = [];
            visNodesCache.forEach(vn => {
                // 不针对虚拟 entry 进行搜索高亮
                if (vn.id.startsWith('__entrance_') || vn.id.startsWith('__exit_')) return;
                
                const matched = vn.id.toLowerCase().includes(query);
                nodesUpdate.push({
                    id: vn.id,
                    borderWidth: matched ? 4 : 1,
                    borderWidthSelected: matched ? 5 : 2,
                    shadow: matched ? {
                        enabled: true,
                        color: '#3b82f6',
                        size: 15,
                        x: 0,
                        y: 0
                    } : { enabled: false }
                });
            });
            network.body.data.nodes.update(nodesUpdate);
        }

        function detectConflicts(filteredSystems) {
            const conflicts = [];
            const isPathMap = buildPathMap(filteredSystems);

            for (let i = 0; i < filteredSystems.length; i++) {
                const sysA = filteredSystems[i];
                const metaA = sysA.systemMetadata;
                const worldA = getWorld(sysA);

                for (let j = i + 1; j < filteredSystems.length; j++) {
                    const sysB = filteredSystems[j];
                    const metaB = sysB.systemMetadata;
                    const worldB = getWorld(sysB);

                    // 如果不在同一个 World，或者在不同的 Phase/Step 下运行，则不存在并发竞争
                    if (worldA !== worldB) continue;
                    
                    const groupA = worldA === 'main' ? (metaA.schedulePhase || 'Update').split('::').pop() : getRenderStep(sysA);
                    const groupB = worldB === 'main' ? (metaB.schedulePhase || 'Update').split('::').pop() : getRenderStep(sysB);
                    if (groupA !== groupB) continue;

                    // 如果 A 和 B 之间存在有向图前后依赖路径，则必定是有序串行的
                    if (isPathMap[sysA.name]?.[sysB.name] || isPathMap[sysB.name]?.[sysA.name]) {
                        continue;
                    }

                    const conflictItems = [];
                    // 组件冲突检测
                    metaA.mutableComponents.forEach(c => {
                        if (metaB.mutableComponents.includes(c) || metaB.readableComponents.includes(c)) {
                            conflictItems.push('Component: ' + c);
                        }
                    });
                    metaB.mutableComponents.forEach(c => {
                        if (metaA.readableComponents.includes(c)) {
                            conflictItems.push('Component: ' + c);
                        }
                    });

                    // 资源冲突检测
                    metaA.mutableResources.forEach(r => {
                        if (metaB.mutableResources.includes(r) || metaB.readableResources.includes(r)) {
                            conflictItems.push('Resource: ' + r);
                        }
                    });
                    metaB.mutableResources.forEach(r => {
                        if (metaA.readableResources.includes(r)) {
                            conflictItems.push('Resource: ' + r);
                        }
                    });

                    if (conflictItems.length > 0) {
                        conflicts.push({
                            sysA: sysA.name,
                            sysB: sysB.name,
                            items: Array.from(new Set(conflictItems))
                        });
                    }
                }
            }
            return conflicts;
        }

        function buildPathMap(systems) {
            const adj = {};
            systems.forEach(s => { adj[s.name] = []; });

            systems.forEach(sys => {
                const meta = sys.systemMetadata;
                const world = getWorld(sys);
                const groupKey = world === 'main' ? (meta.schedulePhase || 'Update').split('::').pop() : getRenderStep(sys);

                meta.runsAfter.forEach(afterName => {
                    const cleanName = afterName.split('::').pop();
                    if (adj[cleanName]) {
                        adj[cleanName].push(sys.name);
                    }
                });

                meta.runsBefore.forEach(beforeName => {
                    const cleanName = beforeName.split('::').pop();
                    if (adj[sys.name]) {
                        adj[sys.name].push(cleanName);
                    }
                });

                meta.belongsToSets.forEach(setName => {
                    systems.forEach(otherSys => {
                        const otherMeta = otherSys.systemMetadata;
                        const otherWorld = getWorld(otherSys);
                        const otherGroupKey = otherWorld === 'main' ? (otherMeta.schedulePhase || 'Update').split('::').pop() : getRenderStep(otherSys);
                        
                        if (otherWorld === world && otherGroupKey === groupKey) {
                            if (otherMeta.runsAfter.includes(setName) && adj[sys.name]) {
                                adj[sys.name].push(otherSys.name);
                            }
                            if (otherMeta.runsBefore.includes(setName) && adj[otherSys.name]) {
                                adj[otherSys.name].push(sys.name);
                            }
                        }
                    });
                });
            });

            const isPath = {};
            systems.forEach(s => { isPath[s.name] = {}; });

            function dfs(startNode, currentNode, visited) {
                visited.add(currentNode);
                if (startNode !== currentNode) {
                    isPath[startNode][currentNode] = true;
                }
                const neighbors = adj[currentNode] || [];
                neighbors.forEach(nbr => {
                    if (!visited.has(nbr)) {
                        dfs(startNode, nbr, visited);
                    }
                });
            }

            systems.forEach(s => {
                dfs(s.name, s.name, new Set());
            });

            return isPath;
        }

        let visNodesCache = [];

        function drawGraph() {
            const selectedTarget = targetSelect.value;
            if (!selectedTarget) return;

            let filtered = [];
            if (selectedTarget === 'lib') {
                filtered = allSystems.filter(s => s.sourceTarget.type === 'lib');
            } else {
                const [targetType, targetName] = selectedTarget.split(':');
                filtered = allSystems.filter(s => 
                    s.sourceTarget.type === 'lib' || 
                    (s.sourceTarget.type === targetType && s.sourceTarget.name === targetName)
                );
            }

            const hideInternal = toggleInternal.checked;
            if (hideInternal) {
                filtered = filtered.filter(s => {
                    if (s.sourceTarget.type !== 'lib') {
                        return true;
                    }
                    const c = (s.crateName || '').toLowerCase();
                    return !c.startsWith('bevy') && c !== 'winit' && c !== 'wgpu' && c !== 'std';
                });
            }

            // Deduplicate by system name to prevent vis.js DataSet duplicate ID errors
            const seenNames = new Set();
            filtered = filtered.filter(s => {
                if (seenNames.has(s.name)) {
                    return false;
                }
                seenNames.add(s.name);
                return true;
            });

            if (filtered.length === 0) {
                if (network) {
                    network.destroy();
                    network = null;
                }
                document.getElementById('mynetwork').innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100%;color:#64748b;font-size:13px;">No system data available for selected target</div>';
                return;
            }

            document.getElementById('mynetwork').innerHTML = '';

            const visNodes = [];
            const visEdges = [];
            const edgeSet = new Set();

            // 1. 无论是否有系统，Main World 7 个阶段都放置 Entrance / Exit 固定节点，并连接框架
            mainPhases.forEach((p, idx) => {
                const entranceId = '__entrance_main_' + p;
                const exitId = '__exit_main_' + p;
                const cx = idx * 1100;
                const cy = -700;
                const w = 820;
                const minX = cx - w/2;
                const maxX = cx + w/2;

                // Entrance 节点
                visNodes.push({
                    id: entranceId,
                    label: p + ' In',
                    shape: 'box',
                    color: {
                        background: 'rgba(29, 78, 216, 0.3)',
                        border: '#2563eb',
                        highlight: { background: '#2563eb', border: '#60a5fa' }
                    },
                    font: { color: '#ffffff', size: 11, face: 'sans-serif' },
                    margin: 4
                });

                // Exit 节点
                visNodes.push({
                    id: exitId,
                    label: p + ' Out',
                    shape: 'box',
                    color: {
                        background: 'rgba(30, 58, 138, 0.3)',
                        border: '#1d4ed8',
                        highlight: { background: '#1d4ed8', border: '#3b82f6' }
                    },
                    font: { color: '#ffffff', size: 11, face: 'sans-serif' },
                    margin: 4
                });

                // 阶段内直通虚线（作为主干背景线）
                visEdges.push({
                    from: entranceId,
                    to: exitId,
                    arrows: 'to',
                    width: 2,
                    color: { color: 'rgba(37, 99, 235, 0.15)', highlight: 'rgba(37, 99, 235, 0.3)' },
                    physics: false
                });

                // 相邻阶段的 Exit -> Entrance 连线
                if (idx < mainPhases.length - 1) {
                    const nextEntranceId = '__entrance_main_' + mainPhases[idx + 1];
                    visEdges.push({
                        from: exitId,
                        to: nextEntranceId,
                        arrows: 'to',
                        width: 4,
                        color: { color: 'rgba(37, 99, 235, 0.65)', highlight: '#3b82f6' },
                        physics: false
                    });
                }
            });

            // 2. 无论是否有系统，Render World 16 个步骤都放置 Entrance / Exit 固定节点，并连接框架
            renderSteps.forEach((step, idx) => {
                const entranceId = '__entrance_render_' + step;
                const exitId = '__exit_render_' + step;
                const cx = idx * 800;
                const cy = 700;
                const w = 650;
                const minX = cx - w/2;
                const maxX = cx + w/2;

                // Entrance 节点
                visNodes.push({
                    id: entranceId,
                    label: step + ' In',
                    shape: 'box',
                    color: {
                        background: 'rgba(4, 120, 87, 0.3)',
                        border: '#059669',
                        highlight: { background: '#059669', border: '#34d399' }
                    },
                    font: { color: '#ffffff', size: 11, face: 'sans-serif' },
                    margin: 4
                });

                // Exit 节点
                visNodes.push({
                    id: exitId,
                    label: step + ' Out',
                    shape: 'box',
                    color: {
                        background: 'rgba(6, 78, 59, 0.3)',
                        border: '#047857',
                        highlight: { background: '#047857', border: '#10b981' }
                    },
                    font: { color: '#ffffff', size: 11, face: 'sans-serif' },
                    margin: 4
                });

                // 阶段内直通虚线
                visEdges.push({
                    from: entranceId,
                    to: exitId,
                    arrows: 'to',
                    width: 2,
                    color: { color: 'rgba(5, 150, 105, 0.15)', highlight: 'rgba(5, 150, 105, 0.3)' },
                    physics: false
                });

                // 相邻步骤连线
                if (idx < renderSteps.length - 1) {
                    const nextEntranceId = '__entrance_render_' + renderSteps[idx + 1];
                    visEdges.push({
                        from: exitId,
                        to: nextEntranceId,
                        arrows: 'to',
                        width: 4,
                        color: { color: 'rgba(5, 150, 105, 0.65)', highlight: '#10b981' },
                        physics: false
                    });
                }
            });

            // 3. 放置系统节点
            filtered.forEach(s => {
                const world = getWorld(s);
                s.computedWorld = world;

                let groupKey = '';
                if (world === 'main') {
                    const phase = s.systemMetadata.schedulePhase || 'Update';
                    groupKey = phase.split('::').pop() || phase;
                } else {
                    groupKey = getRenderStep(s);
                }

                s.computedGroup = groupKey;

                visNodes.push({
                    id: s.name,
                    label: s.name,
                    shape: 'box',
                    margin: 8,
                    shapeProperties: { borderRadius: 6 },
                    color: {
                        background: '#131824',
                        border: world === 'main' ? '#2563eb' : '#059669', // Main 蓝色，Render 绿色
                        highlight: {
                            background: '#1c2336',
                            border: world === 'main' ? '#60a5fa' : '#34d399'
                        }
                    },
                    font: { color: '#f8fafc', size: 12, face: 'monospace' }
                });
            });

            // 4. 解析块内部有向连线（Entrance -> System -> Exit，以及系统间直连）
            filtered.forEach(sys => {
                const world = sys.computedWorld;
                const groupKey = sys.computedGroup;
                const meta = sys.systemMetadata;

                const entranceId = world === 'main' ? '__entrance_main_' + groupKey : '__entrance_render_' + groupKey;
                const exitId = world === 'main' ? '__exit_main_' + groupKey : '__exit_render_' + groupKey;

                let hasPredecessor = false;
                let hasSuccessor = false;

                // 检查 filtered 中是否有其他节点声明了 runsAfter 包含 sys.name
                const hasAfterMe = filtered.some(other => 
                    other.computedWorld === world && 
                    other.computedGroup === groupKey && 
                    other.systemMetadata.runsAfter.some(a => a.split('::').pop() === sys.name)
                );
                
                // 检查 filtered 中是否有其他节点声明了 runsBefore 被 sys.name 依赖
                const runsBeforeMe = filtered.some(other => 
                    other.computedWorld === world && 
                    other.computedGroup === groupKey && 
                    other.systemMetadata.runsBefore.some(b => b.split('::').pop() === sys.name)
                );

                // 自身 runsAfter 声明
                const hasRunsAfter = meta.runsAfter.some(afterName => {
                    const cleanName = afterName.split('::').pop();
                    return filtered.some(s => s.name === cleanName && s.computedWorld === world && s.computedGroup === groupKey);
                });

                // 自身 runsBefore 声明
                const hasRunsBefore = meta.runsBefore.some(beforeName => {
                    const cleanName = beforeName.split('::').pop();
                    return filtered.some(s => s.name === cleanName && s.computedWorld === world && s.computedGroup === groupKey);
                });

                if (hasRunsAfter || runsBeforeMe) {
                    hasPredecessor = true;
                }
                if (hasRunsBefore || hasAfterMe) {
                    hasSuccessor = true;
                }

                // 绘制 execution constraints 实线 (默认绘制)
                // A. runsAfter -> 直连
                meta.runsAfter.forEach(afterName => {
                    const cleanName = afterName.split('::').pop();
                    const exists = filtered.some(s => s.name === cleanName && s.computedWorld === world && s.computedGroup === groupKey);
                    if (exists) {
                        const edgeKey = cleanName + '->' + sys.name;
                        if (!edgeSet.has(edgeKey)) {
                            edgeSet.add(edgeKey);
                            visEdges.push({
                                from: cleanName,
                                to: sys.name,
                                arrows: 'to',
                                width: 2,
                                color: { color: '#94a3b8', highlight: '#3b82f6' }
                            });
                        }
                    }
                });

                // B. runsBefore -> 直连
                meta.runsBefore.forEach(beforeName => {
                    const cleanName = beforeName.split('::').pop();
                    const exists = filtered.some(s => s.name === cleanName && s.computedWorld === world && s.computedGroup === groupKey);
                    if (exists) {
                        const edgeKey = sys.name + '->' + cleanName;
                        if (!edgeSet.has(edgeKey)) {
                            edgeSet.add(edgeKey);
                            visEdges.push({
                                from: sys.name,
                                to: cleanName,
                                arrows: 'to',
                                width: 2,
                                color: { color: '#94a3b8', highlight: '#3b82f6' }
                            });
                        }
                    }
                });

                // C. 并行入口虚线 (Entrance -> System)
                if (!hasPredecessor) {
                    const edgeKey = entranceId + '->' + sys.name;
                    if (!edgeSet.has(edgeKey)) {
                        edgeSet.add(edgeKey);
                        visEdges.push({
                            from: entranceId,
                            to: sys.name,
                            arrows: 'to',
                            width: 1.2,
                            color: {
                                color: world === 'main' ? 'rgba(59, 130, 246, 0.45)' : 'rgba(16, 185, 129, 0.45)',
                                highlight: world === 'main' ? '#3b82f6' : '#10b981'
                            },
                            dashes: [3, 3]
                        });
                    }
                }

                // D. 并行出口虚线 (System -> Exit)
                if (!hasSuccessor) {
                    const edgeKey = sys.name + '->' + exitId;
                    if (!edgeSet.has(edgeKey)) {
                        edgeSet.add(edgeKey);
                        visEdges.push({
                            from: sys.name,
                            to: exitId,
                            arrows: 'to',
                            width: 1.2,
                            color: {
                                color: world === 'main' ? 'rgba(59, 130, 246, 0.45)' : 'rgba(16, 185, 129, 0.45)',
                                highlight: world === 'main' ? '#3b82f6' : '#10b981'
                            },
                            dashes: [3, 3]
                        });
                    }
                }
            });

            // 5. 冲突计算及高亮警告
            const conflicts = detectConflicts(filtered);
            const conflictNodes = new Set();
            conflicts.forEach(c => {
                conflictNodes.add(c.sysA);
                conflictNodes.add(c.sysB);
            });

            if (toggleConflict.checked) {
                conflicts.forEach(c => {
                    visEdges.push({
                        from: c.sysA,
                        to: c.sysB,
                        arrows: 'none',
                        dashes: [4, 4],
                        color: { color: 'rgba(239, 68, 68, 0.65)', highlight: '#ef4444' },
                        width: 2,
                        title: 'Race Risk: ' + c.items.join(', '),
                        physics: false
                    });
                });

                visNodes.forEach(vn => {
                    if (conflictNodes.has(vn.id)) {
                        vn.color = {
                            background: '#7f1d1d',
                            border: '#f87171',
                            highlight: { background: '#991b1b', border: '#fca5a5' }
                        };
                        vn.shadow = {
                            enabled: true,
                            color: 'rgba(239, 68, 68, 0.45)',
                            size: 14,
                            x: 0,
                            y: 0
                        };
                    }
                });
            }

            visNodesCache = visNodes;

            // 6. 配置及渲染 Vis.js Network
            const container = document.getElementById('mynetwork');
            const graphData = {
                nodes: new vis.DataSet(visNodes),
                edges: new vis.DataSet(visEdges)
            };

            const options = {
                layout: {
                    hierarchical: {
                        enabled: true,
                        direction: 'LR',
                        sortMethod: 'directed',
                        nodeSpacing: 50,
                        levelSeparation: 220,
                        treeSpacing: 300
                    }
                },
                physics: {
                    enabled: true,
                    solver: 'hierarchicalRepulsion',
                    hierarchicalRepulsion: {
                        centralGravity: 0.0,
                        springLength: 100,
                        springConstant: 0.01,
                        nodeDistance: 120,
                        damping: 0.09
                    }
                },
                interaction: {
                    hover: true,
                    tooltipDelay: 150,
                    selectable: true
                }
            };

            network = new vis.Network(container, graphData, options);

            network.on("stabilizationIterationsDone", function () {
                network.setOptions({ physics: false });
            });

            // 7. 绘制 Canvas 背景大框
            network.on("beforeDraw", (ctx) => {
                // A. 绘制中线分隔标记（区分 Main World 和 Render World）
                ctx.save();
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
                ctx.lineWidth = 1;
                ctx.setLineDash([5, 10]);
                ctx.beginPath();
                ctx.moveTo(-10000, 0);
                ctx.lineTo(10000, 0);
                ctx.stroke();
                
                // 绘制中线说明
                ctx.setLineDash([]);
                ctx.fillStyle = 'rgba(148, 163, 184, 0.12)';
                ctx.font = 'bold 22px "Segoe UI", sans-serif';
                ctx.fillText('MAIN WORLD (Logic & Simulation)', -350, -100);
                ctx.fillStyle = 'rgba(148, 163, 184, 0.12)';
                ctx.fillText('RENDER WORLD (GPU Pipe Execution)', -350, 100);
                ctx.restore();

                // B. 动态绘制 Phase 阶段框
                const positions = network.getPositions();

                const drawPhaseBox = (groupName, world, titleColor, boxColor, borderColor, stepsArray) => {
                    const nodeIdsInGroup = [];
                    const inId = world === 'main' ? '__entrance_main_' + groupName : '__entrance_render_' + groupName;
                    const outId = world === 'main' ? '__exit_main_' + groupName : '__exit_render_' + groupName;
                    
                    if (positions[inId]) nodeIdsInGroup.push(inId);
                    if (positions[outId]) nodeIdsInGroup.push(outId);

                    filtered.forEach(s => {
                        if (s.computedWorld === world && s.computedGroup === groupName && positions[s.name]) {
                            nodeIdsInGroup.push(s.name);
                        }
                    });

                    if (nodeIdsInGroup.length === 0) return;

                    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                    nodeIdsInGroup.forEach(id => {
                        const p = positions[id];
                        if (p.x < minX) minX = p.x;
                        if (p.x > maxX) maxX = p.x;
                        if (p.y < minY) minY = p.y;
                        if (p.y > maxY) maxY = p.y;
                    });

                    // 给边界增加 Padding
                    const padX = 45;
                    const padYTop = 50; 
                    const padYBottom = 40;
                    
                    // 如果组内没有真实的系统（只有 In 和 Out 节点），强行给一个固定高度
                    if (nodeIdsInGroup.length <= 2) {
                        minY -= 100;
                        maxY += 100;
                    }

                    minX -= padX;
                    maxX += padX;
                    minY -= padYTop;
                    maxY += padYBottom;

                    const w = maxX - minX;
                    const h = maxY - minY;

                    ctx.save();
                    ctx.fillStyle = boxColor;
                    ctx.strokeStyle = borderColor;
                    ctx.shadowColor = borderColor.substring(0, borderColor.lastIndexOf(',')) + ', 0.1)';
                    ctx.lineWidth = 1.8;
                    ctx.shadowBlur = 10;

                    const radius = 12;
                    ctx.beginPath();
                    ctx.moveTo(minX + radius, minY);
                    ctx.lineTo(maxX - radius, minY);
                    ctx.quadraticCurveTo(maxX, minY, maxX, minY + radius);
                    ctx.lineTo(maxX, maxY - radius);
                    ctx.quadraticCurveTo(maxX, maxY, maxX - radius, maxY);
                    ctx.lineTo(minX + radius, maxY);
                    ctx.quadraticCurveTo(minX, maxY, minX, maxY - radius);
                    ctx.lineTo(minX, minY + radius);
                    ctx.quadraticCurveTo(minX, minY, minX + radius, minY);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();

                    // 画大背景盒的 Phase 标题
                    ctx.shadowBlur = 0;
                    ctx.fillStyle = titleColor;
                    ctx.font = 'bold 15px "Segoe UI", sans-serif';
                    ctx.fillText(groupName, minX + 18, minY + 26);
                    ctx.restore();
                };

                mainPhases.forEach(p => {
                    drawPhaseBox(p, 'main', '#93c5fd', 'rgba(19, 24, 36, 0.42)', 'rgba(37, 99, 235, 0.35)', mainPhases);
                });

                renderSteps.forEach(step => {
                    drawPhaseBox(step, 'render', '#6ee7b7', 'rgba(16, 20, 31, 0.42)', 'rgba(5, 150, 105, 0.35)', renderSteps);
                });
            });

            network.on("click", params => {
                if (params.nodes.length > 0) {
                    const nodeId = params.nodes[0];
                    if (nodeId.startsWith('__entrance_') || nodeId.startsWith('__exit_')) {
                        hideDetails();
                        return;
                    }
                    showSystemDetails(nodeId, filtered, conflicts);
                } else {
                    hideDetails();
                }
            });

            network.on("doubleClick", params => {
                if (params.nodes.length > 0) {
                    const nodeId = params.nodes[0];
                    if (nodeId.startsWith('__entrance_') || nodeId.startsWith('__exit_')) return;
                    const sys = filtered.find(s => s.name === nodeId);
                    if (sys) {
                        vscode.postMessage({
                            command: 'jumpTo',
                            data: { filePath: sys.filePath, line: sys.line }
                        });
                    }
                }
            });
        }

        function showSystemDetails(nodeId, filteredSystems, conflicts) {
            const sys = filteredSystems.find(s => s.name === nodeId);
            if (!sys) return;

            selectedNodeId = nodeId;
            detailsPanel.style.display = 'block';

            document.getElementById('detailsTitle').textContent = sys.name;
            document.getElementById('detailsDesc').textContent = sys.filePath.split(/[\\\\/]/).pop() + ' : Line ' + sys.line;
            
            const world = getWorld(sys);
            const targetText = world === 'main' ? 'Main World (Logic)' : 'Render World (GPU)';
            document.getElementById('detailsTarget').textContent = targetText + ' - ' + sys.crateName;

            const renderBadges = (elementId, items, badgeClass) => {
                const container = document.getElementById(elementId);
                container.innerHTML = '';
                if (items.length === 0) {
                    container.innerHTML = '<span style="color:#64748b; font-size:10.5px;">none</span>';
                } else {
                    items.sort().forEach(item => {
                        const span = document.createElement('span');
                        span.className = 'badge ' + badgeClass;
                        span.textContent = item;
                        container.appendChild(span);
                    });
                }
            };

            const meta = sys.systemMetadata;
            renderBadges('mutResources', meta.mutableResources, 'badge-mut');
            renderBadges('readResources', meta.readableResources, 'badge-read');
            renderBadges('mutComponents', meta.mutableComponents, 'badge-mut');
            renderBadges('readComponents', meta.readableComponents, 'badge-read');
            renderBadges('detailsSets', meta.belongsToSets, 'badge-set');
            renderBadges('detailsConds', meta.runConditions, 'badge-cond');

            const relevantConflicts = conflicts.filter(c => c.sysA === nodeId || c.sysB === nodeId);
            const conflictSection = document.getElementById('conflictSection');
            const conflictList = document.getElementById('conflictList');

            if (toggleConflict.checked && relevantConflicts.length > 0) {
                conflictSection.style.display = 'block';
                conflictList.innerHTML = '';
                relevantConflicts.forEach(c => {
                    const opponent = c.sysA === nodeId ? c.sysB : c.sysA;
                    const div = document.createElement('div');
                    div.className = 'conflict-item';
                    div.innerHTML = '<strong>⚡️ vs ' + opponent + '</strong><br>' +
                                    '<span style="font-size:11px;color:#fca5a5;">Data Conflicted: ' + c.items.join(', ') + '</span>';
                    conflictList.appendChild(div);
                });
            } else {
                conflictSection.style.display = 'none';
            }

            jumpBtn.onclick = () => {
                vscode.postMessage({
                    command: 'jumpTo',
                    data: { filePath: sys.filePath, line: sys.line }
                });
            };
        }
    </script>
</body>
</html>`;
    }
}