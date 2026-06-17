# Bevy Lens

**Bevy Lens** is a lightweight, high-performance VS Code extension designed specifically for the **Bevy Game Engine**. By statically analyzing your Rust codebase, WGSL/WESL shaders, Bevy Lens maps your ECS universe into a dedicated sidebar—drastically reducing cognitive load and helping you keep track of your game's systems, components, resources, states, and more.

Official Website: [BevyCN](https://bevycn.com/)

Download: [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=bevycn.bevy-lens) | [Open VSX](https://open-vsx.org/extension/BevyCN/bevy-lens)

---

## 🌟 Key Features

### 1. 🔍 Bevy Global Registry
Get a centralized, organized view of all Bevy types defined in your project:
*   **Structured Categories**: Automatically categorizes **Components**, **Resources**, **Events**, **States**, **Messages**, **Plugins**, **Shaders**, **Assets**, and **Systems**.
*   **Multi-crate & Workspace Hierarchies**: Groups your ECS registry by Cargo crates, mapping structures directly under their respective packages.
*   **Examples & Bins Sub-categorization**: Automatically isolates systems and types inside `examples/` and `src/bin/` into dedicated nested folders (e.g., `Example: ui/button`), ensuring that game logic and examples never clutter the core library tree.
*   **Test Code Separation**: Scours `mod tests` and `#[cfg(test)]` modules to isolate and group test components, test resources, and test systems (under dedicated "Test ECS Types", "Test Systems", etc.) to keep production environments clean.
*   **Fuzzy Search & Filtering**: Quickly filter down massive registries using positive (`Player`) and negative (`!Collision`) query selectors.
*   **Code Navigation**: Click any item in the tree view to instantly jump directly to its definition in the editor.

<p align="center">
  <img src="https://raw.githubusercontent.com/BevyCN/bevy-lens-vscode/master/images/globalregistry.jpg" alt="Bevy Global Registry" width="600px">
</p>

### 2. 📁 Semantic Workspace Explorer
An enhanced physical file explorer that reveals Bevy structures inline:
*   **Inline File AST**: Expand `.rs`, `.wgsl`, and `.wesl` files to see what Bevy concepts are defined inside them.
*   **Dynamic Synchronization**: Automatically reveals and focuses the active file in the sidebar explorer as you type or switch between tabs in your editor.
*   **Custom Brand Icons**: Instantly differentiate between components, systems, and assets using dedicated VS Code codicons matching your active icon theme.

<p align="center">
  <img src="https://raw.githubusercontent.com/BevyCN/bevy-lens-vscode/master/images/explore.jpg" alt="Semantic Workspace Explorer" width="600px">
</p>

### 3. 📝 Rich Previews, Shader Binding Bridge & Concurrency Diagnostics
*   **Instant Documentation**: Displays the first line of your Rust triple-slash (`///`) docstrings beside registry items. Hovering over any item reveals the full Markdown documentation.
*   **Shader Bridge & Entry Points**: Extracts `@binding` layouts (uniforms, textures, samplers) and registers entry points (`@vertex`, `@fragment`, `@compute`) including compute workgroup sizes (`@workgroup_size`), allowing seamless shader pipeline inspection.
*   **Parallel Query Write-Conflict Linter**: Statically checks systems registered in the same schedule phase. If two systems read/write to the same component/resource mutably without declared ordering (`.after()`, `.before()`, `.in_set()`), Bevy Lens flags it with a status indicator (🔴 / 🟡) and warns you of potential race conditions.

<p align="center">
  <img src="https://raw.githubusercontent.com/BevyCN/bevy-lens-vscode/master/images/popup.jpg" alt="Diagnostics and Rich Previews" width="600px">
</p>

### 4. 📊 ECS Schedule & Dataflow Visualizer (Schedule Visualizer)
A static analysis tool that displays scheduling logic and data flow interactively:
*   **Interactive DAG Layout**: Renders systems in a directed acyclic graph (DAG) using a beautiful force-directed layout, supporting smooth zooming, dragging, and physics animations.
*   **Build Target Isolation**: Supports a target filter to isolate different `bin`, `example`, and `lib` systems to avoid false-positive warnings between independent executables.
*   **Serial Chain Constraint Parser**: Parses Bevy system `.chain()` constraints, correctly chaining execution dependencies.
*   **Data Race Ambiguity Warning**: Automatically highlights systems running concurrently (without order) that have read/write overlaps (Write-Write or Read-Write) on components/resources, styled in red and toggled with control switches.
*   **Editor Sync Navigation**: Double-click any system node to instantly open the source file on the left editor column and scroll directly to its line number.

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

Please refer to [CHANGELOG.md](CHANGELOG.md) for detailed release notes.

---

## 📄 License

This extension is licensed under the [MIT License](LICENSE).
