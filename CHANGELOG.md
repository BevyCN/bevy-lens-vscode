# Changelog

All notable changes to the "bevy-lens" extension will be documented in this file.

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
