import * as vscode from 'vscode';
import { BevyReference } from './bevyParser';

export class ReferenceVisualizerPanel {
    public static currentPanel: ReferenceVisualizerPanel | undefined;
    private static readonly viewType = 'bevyReferenceVisualizer';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    
    private _targetName: string;
    private _targetType: string;
    private _references: BevyReference[] = [];

    public static createOrShow(extensionUri: vscode.Uri, targetName: string, targetType: string, references: BevyReference[]) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ReferenceVisualizerPanel.currentPanel) {
            ReferenceVisualizerPanel.currentPanel._targetName = targetName;
            ReferenceVisualizerPanel.currentPanel._targetType = targetType;
            ReferenceVisualizerPanel.currentPanel._references = references;
            ReferenceVisualizerPanel.currentPanel._panel.reveal(column);
            ReferenceVisualizerPanel.currentPanel._updateHtml();
            ReferenceVisualizerPanel.currentPanel._sendData();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ReferenceVisualizerPanel.viewType,
            `Bevy References: ${targetName}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        ReferenceVisualizerPanel.currentPanel = new ReferenceVisualizerPanel(panel, extensionUri, targetName, targetType, references);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, targetName: string, targetType: string, references: BevyReference[]) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._targetName = targetName;
        this._targetType = targetType;
        this._references = references;

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
                        this._sendData();
                        break;
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidChangeViewState(
            e => {
                if (e.webviewPanel.visible) {
                    this._sendData();
                }
            },
            null,
            this._disposables
        );
    }

    public updateReferences(references: BevyReference[]) {
        this._references = references;
        this._sendData();
    }

    private _sendData() {
        this._panel.webview.postMessage({
            command: 'setData',
            targetName: this._targetName,
            targetType: this._targetType,
            references: this._references
        });
    }

    public dispose() {
        ReferenceVisualizerPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _updateHtml() {
        this._panel.title = `Bevy References: ${this._targetName}`;
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bevy Reference Visualizer</title>
    <!-- vis-network CDN -->
    <script type="text/javascript" src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            margin: 0;
            padding: 0;
            background: linear-gradient(135deg, #0a0d14 0%, #10141f 100%);
            color: #e2e8f0;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            height: 100vh;
        }

        #header {
            padding: 12px 20px;
            background: rgba(16, 20, 31, 0.85);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            display: flex;
            align-items: center;
            justify-content: space-between;
            z-index: 10;
        }

        #title {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
            color: #f8fafc;
        }

        #container {
            display: flex;
            flex: 1;
            position: relative;
            overflow: hidden;
        }

        #mynetwork {
            flex: 1;
            height: 100%;
            background: radial-gradient(circle, rgba(255,255,255,0.015) 1px, transparent 1px);
            background-size: 20px 20px;
        }

        #sidebar {
            width: 320px;
            background: rgba(16, 20, 31, 0.78);
            backdrop-filter: blur(18px);
            -webkit-backdrop-filter: blur(18px);
            border-left: 1px solid rgba(255, 255, 255, 0.08);
            display: flex;
            flex-direction: column;
            overflow-y: auto;
            padding: 16px;
            z-index: 5;
            box-shadow: -4px 0 15px rgba(0, 0, 0, 0.2);
        }

        .list-title {
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: #94a3b8;
            margin-bottom: 12px;
            font-weight: bold;
        }

        .ref-item {
            padding: 12px;
            margin-bottom: 10px;
            background: rgba(255, 255, 255, 0.03);
            border-radius: 8px;
            border-left: 4px solid #3b82f6;
            cursor: pointer;
            transition: all 0.2s ease;
            border-top: 1px solid rgba(255, 255, 255, 0.02);
            border-right: 1px solid rgba(255, 255, 255, 0.02);
            border-bottom: 1px solid rgba(255, 255, 255, 0.02);
        }

        .ref-item:hover {
            background: rgba(255, 255, 255, 0.07);
            transform: translateX(-2px);
        }

        .ref-name {
            font-weight: 600;
            font-size: 13px;
            margin-bottom: 6px;
            color: #f1f5f9;
        }

        .ref-meta {
            font-size: 11px;
            color: #94a3b8;
            display: flex;
            justify-content: space-between;
        }

        .ref-details {
            font-size: 11px;
            color: #cbd5e1;
            margin-top: 8px;
            font-family: 'Consolas', 'Monaco', monospace;
            background: rgba(0, 0, 0, 0.3);
            padding: 6px 8px;
            border-radius: 4px;
            overflow-x: auto;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }

        .relation-Init { border-left-color: #a78bfa; }
        .relation-Create { border-left-color: #34d399; }
        .relation-Read { border-left-color: #60a5fa; }
        .relation-Write { border-left-color: #fb923c; }
        .relation-Define { border-left-color: #fcd34d; }
        .relation-Send { border-left-color: #fb923c; }
        .relation-Receive { border-left-color: #60a5fa; }

        .legend {
            position: absolute;
            bottom: 20px;
            left: 20px;
            background: rgba(16, 20, 31, 0.85);
            backdrop-filter: blur(12px);
            padding: 14px;
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.08);
            display: flex;
            flex-direction: column;
            gap: 8px;
            z-index: 10;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
        }

        .legend-item {
            display: flex;
            align-items: center;
            font-size: 12px;
            gap: 8px;
        }

        .legend-color {
            width: 12px;
            height: 12px;
            border-radius: 3px;
        }
    </style>
</head>
<body>
    <div id="header">
        <h1 id="title">Find Bevy Reference Visualizer</h1>
    </div>
    <div id="container">
        <div id="mynetwork"></div>
        <div id="legendContainer" class="legend"></div>
        <div id="sidebar">
            <div class="list-title">Reference List</div>
            <div id="ref-list-container"></div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let network = null;

        // Initialize request
        vscode.postMessage({ command: 'requestInitData' });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'setData':
                    renderGraph(message.targetName, message.targetType, message.references);
                    break;
            }
        });

        function renderGraph(targetName, targetType, references) {
            const headerTitle = document.getElementById('title');
            headerTitle.textContent = \`Find Bevy Reference: \${targetName} (\${targetType})\`;

            // Clear sidebar
            const sidebar = document.getElementById('ref-list-container');
            sidebar.innerHTML = '';

            if (references.length === 0) {
                sidebar.innerHTML = '<div style="color: #858585; font-size: 12px; font-style: italic;">No references found.</div>';
            }

            const nodes = [];
            const edges = [];

            // Add center target node
            nodes.push({
                id: 'target',
                label: \`\${targetName}\\n(\${targetType})\`,
                color: {
                    background: '#f59e0b',
                    border: '#d97706',
                    highlight: { background: '#fcd34d', border: '#f59e0b' },
                    hover: { background: '#fcd34d', border: '#f59e0b' }
                },
                font: { color: '#ffffff', size: 15, bold: true, face: '-apple-system' },
                shape: 'hexagon',
                size: 28,
                shadow: { enabled: true, color: 'rgba(245, 158, 11, 0.4)', size: 15, x: 0, y: 0 }
            });

            const isEventOrMessage = targetType === 'Event' || targetType === 'Message';

            // Generate Dynamic Legend
            const legendContainer = document.getElementById('legendContainer');
            if (isEventOrMessage) {
                legendContainer.innerHTML = \`
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: #f59e0b;"></div>
                        <span>Target: \${targetType}</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: #fcd34d;"></div>
                        <span>Define (Declaration)</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: #fb923c;"></div>
                        <span>Send (Send/Trigger)</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: #60a5fa;"></div>
                        <span>Receive (Read/Listen)</span>
                    </div>
                \`;
            } else {
                legendContainer.innerHTML = \`
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: #f59e0b;"></div>
                        <span>Target: \${targetType}</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: #fcd34d;"></div>
                        <span>Define (Declaration)</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: #a78bfa;"></div>
                        <span>Init (Initialize)</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: #34d399;"></div>
                        <span>Create (Spawn/Insert)</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: #60a5fa;"></div>
                        <span>Read (Res/Query)</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: #fb923c;"></div>
                        <span>Write (ResMut/Query/Remove)</span>
                    </div>
                \`;
            }

            references.forEach((ref, index) => {
                const relationColorMap = {
                    'Init': '#a78bfa',
                    'Create': '#34d399',
                    'Read': '#60a5fa',
                    'Write': '#fb923c',
                    'Define': '#fcd34d',
                    'Send': '#fb923c',
                    'Receive': '#60a5fa'
                };
                const relationColor = relationColorMap[ref.relationType] || '#94a3b8';

                // Add to sidebar
                const refItem = document.createElement('div');
                refItem.className = \`ref-item relation-\${ref.relationType}\`;
                refItem.innerHTML = \`
                    <div class="ref-name">\${ref.sourceName}</div>
                    <div class="ref-meta">
                        <span>Type: \${ref.sourceType}</span>
                        <span>Relation: \${ref.relationType}</span>
                    </div>
                    \${ref.details ? \`<div class="ref-details">\${escapeHtml(ref.details)}</div>\` : ''}
                \`;
                refItem.addEventListener('click', () => {
                    vscode.postMessage({
                        command: 'jumpTo',
                        data: { filePath: ref.filePath, line: ref.line }
                    });
                });
                sidebar.appendChild(refItem);

                // Add node
                const nodeId = \`ref_\${index}\`;
                
                // Rich Tooltip Content (HTML)
                const tooltipHtml = \`
                    <div style="padding: 8px; font-family: -apple-system, sans-serif; background: rgba(16,20,31,0.95); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; box-shadow: 0 4px 15px rgba(0,0,0,0.5);">
                        <strong style="color: #60a5fa; font-size: 14px;">\${ref.sourceName}</strong>
                        <div style="font-size: 12px; color: #94a3b8; margin-top: 4px;">\${ref.sourceType}</div>
                        <div style="font-size: 12px; color: #cbd5e1; margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.1);">
                            <b>File:</b> \${ref.filePath.split(/[\\\\/]/).pop()} : \${ref.line}<br>
                            <b>Relation:</b> <span style="color: \${relationColor}; font-weight: bold;">\${ref.relationType}</span>
                        </div>
                        \${ref.details ? \`
                        <div style="margin-top: 6px; background: rgba(0,0,0,0.5); padding: 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.05);">
                            <code style="color: #34d399; font-size: 11px;">\${escapeHtml(ref.details)}</code>
                        </div>\` : ''}
                    </div>
                \`;

                const tooltipElement = document.createElement('div');
                tooltipElement.innerHTML = tooltipHtml;

                nodes.push({
                    id: nodeId,
                    label: \`\${ref.sourceName}\\n(\${ref.sourceType})\`,
                    title: tooltipElement, // Rich hover info via DOM element
                    color: {
                        background: '#131824',
                        border: relationColor,
                        highlight: { background: '#1e293b', border: relationColor },
                        hover: { background: '#1e293b', border: relationColor }
                    },
                    font: { color: '#f1f5f9', size: 13, face: '-apple-system' },
                    shape: 'box',
                    borderWidth: 2,
                    margin: 10,
                    shapeProperties: { borderRadius: 6 },
                    filePath: ref.filePath,
                    line: ref.line,
                    shadow: { enabled: true, color: 'rgba(0, 0, 0, 0.3)', size: 8, x: 0, y: 2 }
                });

                // Add edge
                const arrowDirection = (ref.relationType === 'Read') ? 'to' : 'from';

                edges.push({
                    from: ref.relationType === 'Read' ? 'target' : nodeId,
                    to: ref.relationType === 'Read' ? nodeId : 'target',
                    label: ref.relationType,
                    font: { color: relationColor, size: 10, align: 'middle' },
                    color: { color: relationColor, highlight: relationColor },
                    arrows: { to: { enabled: true, scaleFactor: 0.8 } },
                    width: 1.5
                });
            });

            // Create vis-network
            const container = document.getElementById('mynetwork');
            const data = {
                nodes: new vis.DataSet(nodes),
                edges: new vis.DataSet(edges)
            };

            const options = {
                layout: {
                    randomSeed: 42
                },
                nodes: {
                    margin: 10
                },
                edges: {
                    smooth: {
                        type: 'cubicBezier',
                        forceDirection: 'none',
                        roundness: 0.5
                    }
                },
                physics: {
                    barnesHut: {
                        gravitationalConstant: -3000,
                        centralGravity: 0.3,
                        springLength: 120,
                        springConstant: 0.04,
                        damping: 0.09,
                        avoidOverlap: 0.5
                    },
                    stabilization: { iterations: 150 }
                },
                interaction: {
                    hover: true,
                    selectConnectedEdges: false
                }
            };

            if (network) {
                network.setData(data);
                network.setOptions(options);
            } else {
                network = new vis.Network(container, data, options);

                // Double click to jump to code
                network.on('doubleClick', params => {
                    if (params.nodes.length > 0) {
                        const clickedNodeId = params.nodes[0];
                        if (clickedNodeId !== 'target') {
                            const clickedNode = nodes.find(n => n.id === clickedNodeId);
                            if (clickedNode && clickedNode.filePath) {
                                vscode.postMessage({
                                    command: 'jumpTo',
                                    data: { filePath: clickedNode.filePath, line: clickedNode.line }
                                });
                            }
                        }
                    }
                });
            }
        }

        function escapeHtml(str) {
            return str
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }
    </script>
</body>
</html>`;
    }
}
