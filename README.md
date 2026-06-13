# Bevy Lens

**Bevy Lens** is a lightweight, high-performance VS Code extension designed specifically for the **Bevy Game Engine**. By statically analyzing your Rust codebase and WGSL shaders, Bevy Lens maps your ECS universe into a dedicated sidebar—drastically reducing cognitive load and helping you keep track of your game's systems, components, resources, states, and more.

---

## 🌟 Key Features

### 1. 🔍 Bevy Global Registry
Get a centralized, organized view of all Bevy types defined in your project:
*   **Structured Categories**: Automatically categorizes **Components**, **Resources**, **Events**, **States** (types deriving `States`), **Messages**, **Plugins**, **Shaders**, **Assets**, and **Systems**.
*   **Fuzzy Search**: Quickly filter down massive registries to find the exact entity or system you need using a built-in search tool.
*   **Code Navigation**: Click any item in the tree view to instantly jump directly to its definition in the editor.

### 2. 📁 Semantic Workspace Explorer
An enhanced physical file explorer that reveals Bevy structures inline:
*   **Inline File AST**: Expand `.rs` and `.wgsl` files to see what Bevy concepts are defined inside them.
*   **Dynamic Synchronization**: Automatically reveals and focuses the active file in the sidebar explorer as you type or switch between tabs in your editor.
*   **Custom Brand Icons**: Instantly differentiate between components, systems, and assets using dedicated VS Code codicons.

### 3. 📝 Rich Markdown Previews & LSP Diagnostics
*   **Instant Documentation**: Displays the first line of your Rust triple-slash (`///`) docstrings directly beside registry items. Hovering over any item reveals the full Markdown documentation.
*   **Live Error Markers**: Real-time integration with VS Code diagnostics (like `rust-analyzer`). If a component or system has compiler errors or warnings, Bevy Lens flags it with a status indicator (🔴 / 🟡) and displays LSP diagnostic messages directly inside the hover tooltip.

---

## ⚡ Requirements & Recommendations

*   **Rust & Bevy**: Projects built using Rust and the Bevy game engine.
*   **Rust Analyzer (Recommended)**: For live compilation error/warning badges in the tree views, it is highly recommended to install the official [Rust Analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) extension.

---

## ⚙️ Extension Settings

This extension contributes the following settings:

*   `bevyLens.excludePaths`: An array of glob patterns to exclude from scanning (defaults to `["**/target/**", "**/.git/**"]`).
*   `bevyLens.enableConflictDiagnostics`: A boolean setting to enable static query read/write conflict warnings for parallel systems (defaults to `false`).

---

## 📅 Release Notes

### 0.1.0
*   Initial release of Bevy Lens.
*   Support for Components, Resources, Events, States, Messages, Plugins, Shaders, Assets, and Systems.
*   LSP diagnostic synchronization.
*   Workspace bidirectional location tracking.

---

## 📄 License

This extension is licensed under the [MIT License](LICENSE).
