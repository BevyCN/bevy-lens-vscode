# Changelog

All notable changes to the "bevy-lens" extension will be documented in this file.

## [0.1.26] - 2026-06-21

### Fixed
- **Paren-Matching Parser**: Replaced the regex-based `add_systems` and `add_observer` parsing loops with a robust parenthesis depth matching algorithm, preventing parsing truncation and missing systems when registering tuple-based systems (e.g. `(sys_a, sys_b)`) with internal parentheses (e.g. `.run_if(...)`).
- **Enhanced Render World Systems Recognition**: Expanded sub-app variable pattern matching to support `let Some(render_app)`, `let render_app`, and member prefix syntax. Added fallback checks for rendering-specific schedule phases (`Render`, `ExtractSchedule`, etc.) and system sets (`RenderSet`, `RenderSystems`, etc.) to ensure 100% accurate classification of Render World Systems.

## [0.1.25] - 2026-06-20

### Fixed
- **Render World Systems Resolution**: Upgraded `add_systems` registration parser to utilize statement prefix backtracking, resolving and identifying Render World Systems declared via chain calls like `app.sub_app_mut(RenderApp).add_systems(...)` and `sub_app_mut` methods.

## [0.1.24] - 2026-06-20

### Optimized
- **Registry Category Sorting**: Sorted registry categories alphabetically (A-Z) while consistently placing all categories with a "Test" prefix at the bottom.

## [0.1.23] - 2026-06-20

### Added
- **Render & Main World Systems Separation**: Differentiated systems added to `RenderApp` from standard systems, registering them as "Render World Systems" and "Main World Systems" in tree views.
- **BSN Macro Detection**: Added support for detecting `bsn!` and `bsn_list!` syntax macros and mapping their enclosing Scene functions under the "BSN" category in tree views with a custom symbol icon.
- **App Settings Flow**: Automatically relocated resources marked with `SettingsGroup` (via derive or reflect attributes) from "Resources" to a dedicated "App Settings" registry section.
- **Observer run_if Support**: Integrated `.run_if(...)` condition analysis for Bevy observers, displaying execution guard conditions in observer hover tooltips.

## [0.1.22] - 2026-06-20

### Fixed
- **Explorer Empty Context Menu**: Enabled context menu operations (New File, New File from Template, New Folder, Paste, and Open in Integrated Terminal) when right-clicking on empty spaces in the Bevy Semantic Explorer, resolving workspace actions relative to the root directory path.

## [0.1.21] - 2026-06-17

### Added
- **Bevy Observer Support**: Added syntax parsing for latest Bevy observers featuring `On<Event>` parameter signatures, displaying them under dedicated "Observers" and "Test Observers" categories in registry tree views with distinct eye icons.

### Optimized
- **Observer Tooltip Adaptations**: Updated element hover tooltips to hide schedule phases and stage fields for observer types, presenting Event-driven details instead.

## [0.1.20] - 2026-06-17

### Added
- **TreeView Multi-Select**: Enabled multi-select (`canSelectMany: true`) in `Bevy Semantic Explorer` view to support batch operations.
- **Drag and Drop (DND)**: Added native-like drag and drop capabilities to move files and folders directly inside the tree view, with safety constraints preventing illegal parent-child relocation.
- **Comprehensive Context Menu**:
  - Open to the Side
  - Open With...
  - Open in Integrated Terminal
  - Clipboard Operations: Cut (`Ctrl+X`), Copy (`Ctrl+C`), Paste (`Ctrl+V`) (including duplicate item naming support: `xxx_copy1.rs`).
  - Compare Operations: Select for Compare, Compare with Selected (diff viewer).
  - Copy Path (`Shift+Alt+C`) / Copy Relative Path (`Ctrl+K Ctrl+Shift+C`).
- **Native Keyboard Shortcuts**: Registered default keybindings mapping (`Ctrl+C`, `Ctrl+X`, `Ctrl+V`, `Delete`, `F2`) inside the explorer.
- **Batch Deletion**: Updated the delete command to support bulk file/folder deletion with a safety prompt specifying the item count.

### Optimized
- **Incremental Parsing**: Introduced in-memory file parsing cache (`parsedFilesCache` and `addSystemsCache`). File edits and saves only parse changed files, dropping re-parse overhead for unchanged files to 0ms.
- **0-I/O Global Linkage**: Regrouped `.add_systems` rules on the fly during file parsing, completely removing the heavy disk re-reading step when resolving schedule bounds.
- **Debounced Refresh**: Implemented a 300ms debounce buffer on file watcher events to prevent high-frequency compile-diagnostics overhead during code editing.

### Fixed
- **View Selection & State Recovery**: Fixed a bug where the tree view lost its active selection highlight and collapsed expanded folders after data reload or edit saves. The tree now seamlessly restores the focus and expands the active file node using a debounced reveal mechanism.

## [0.1.19]
- Minor stability fixes and syntax parsing updates.

## [0.1.17]
- Fixed a bug where the tree view could fail to show or render correctly by normalizing file paths to lowercase keys inside the diagnostics cache, resolving path casing mismatches in workspace diagnostic lookup.

## [0.1.16]
- Fixed path mismatch issues in Semantic Explorer by normalizing file paths to lowercase keys, resolving tree node synchronization bugs on Windows/WSL case-insensitive file systems.
- Assigned unique IDs to TreeView nodes to ensure VS Code correctly preserves node expansion state and selection highlighting across registry refreshes.

## [0.1.15]
- Updated the project repository address to `https://github.com/BevyCN/bevy-lens-vscode`.
- Updated README.md image sources to use raw GitHub absolute paths.
- Optimized tree view rendering on compilation diagnostic updates by implementing incremental URI updates and debounced refresh, preventing UI lag.

## [0.1.14]
- Fixed TreeView item indentation alignment. Files containing no Bevy elements will correctly align their icons with other files in the Semantic Explorer.

## [0.1.13]
- Added **ECS Schedule Visualizer** (`bevy-lens.openScheduleVisualizer` command and sidebar view button), allowing interactive DAG inspection of systems with drag-and-drop force-directed layouts.
- Implemented **Build Target Separation** to isolate system graphs and conflicts between different binaries, examples, and libraries.
- Added support for parsing Bevy system `.chain()` constraints, correctly serializing execution orders in the scheduler.
- Implemented **Static Data Race Warning & Highlighting** for concurrent read/write resource/component access in the graph view.
- Added switches to toggle potential race warnings, execution constraints, and select the active schedule phase/target.
- Double-clicking nodes in the webview now directly opens and highlights the system in the editor.
- Fixed WGSL `@binding` layout and entry points parser to support multi-line declarations.

## [0.1.12]
- Added **Change Sort Order...** command to the Global Registry title bar, allowing sorting Bevy elements alphabetically (A-Z) or by their file position.
- Introduced `bevyLens.sortBy` configuration.

## [0.1.11]
- Fixed active editor synchronization highlight to correctly render the native focus selection background in Bevy Semantic Explorer.

## [0.1.10]
- Added **New File from Template...** command with 4 built-in Bevy templates (Plugin, System, ECS Types, WGSL Shader).
- Optimized file tree nodes to utilize VS Code's active **File Icon Theme** natively.
- Fixed a WSL/remote development bug where `Reveal in Explorer View` context menu command failed.
- Significantly optimized workspace file traversal and TreeView diagnostics caching performance.

## [0.1.2]
- Support for cargo multi-crate workspaces.
- Intelligent nested grouping for examples (`examples/`) and binaries (`src/bin/`), resolving down to individual files and folders.
- Full support for compute shader (`@compute`) entry point extraction and workgroup size parsing.
- Isolate test-scoped derived Bevy items and systems inside `mod tests` or `#[cfg(test)]` modules.

## [0.1.1]
- Support for `.wesl` (WebGPU Extended Shading Language) shader files.
- Static write-conflict warnings and order checkers for parallel systems.
- Expanded registry metadata, including schedule phases, system-sets, and data access signatures.

## [0.1.0]
- Initial release of Bevy Lens.
- Support for Components, Resources, Events, States, Messages, Plugins, Shaders, Assets, and Systems.
- LSP diagnostic synchronization.
- Workspace bidirectional location tracking.
