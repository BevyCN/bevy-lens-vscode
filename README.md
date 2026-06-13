# Bevy Lens - VS Code Extension

**Bevy Lens** 是一款专为 Bevy 游戏引擎设计的 VS Code 语义化资源管理器与全局元素注册表插件。它通过静态分析您的 Rust 代码与 WGSL 着色器，极大地降低大型 Bevy 项目的 ECS 心智负担。

---

## 🌟 核心功能

1. **BEVY GLOBAL REGISTRY (全局资源管理器)**
   - 按类别对项目中的 Bevy 概念进行归类展示，包括：**Components (组件)**、**Resources (资源)**、**Events (事件)**、**Messages (消息)**、**Plugins (插件)**、**Shaders (着色器)**、**Assets (资产)**、**Systems (系统)**。
   - **文档注释预览**：直接在侧边栏显示元素定义上的 `///` 第一行注释。将鼠标悬停在列表项上，能展示富文本 Markdown 格式的完整文档注释。
   - **全局模糊匹配**：支持通过快捷命令快速过滤匹配特定名称的 Bevy 元素。
   - **点击精准定位**：点击任意元素，直接在编辑器中定位并跳转到代码定义行。

2. **BEVY SEMANTIC EXPLORER (语义目录树)**
   - 基于物理项目结构的增强版文件资源管理器。
   - 支持 `.rs` 和 `.wgsl` 文件节点的展开，将文件内定义的 Bevy 元素以子树节点列出，并使用专属图标和 tag 进行区分。
   - **双向定位联动**：在编辑器中切换打开的文件时，语义目录树会**自动展开并定位**到该文件的树节点；在目录树中点击元素同样会跳转到编辑器对应的代码行。

---

## 🚀 快速开始与调试

1. **安装依赖**
   在当前目录运行以下命令安装必要的 VS Code 扩展开发依赖：
   ```bash
   npm install
   ```

2. **启动调试环境**
   - 在 VS Code 中打开本插件文件夹。
   - 按下 `F5` 键，或者进入调试面板选择 **"Run Extension"** 启动。
   - 这会弹出一个全新的 **[扩展开发宿主]** VS Code 窗口。

3. **测试解析效果**
   - 在新弹出的调试 VS Code 窗口中，**再次打开当前文件夹 (`bevydevplugin`)**。
   - 点击侧边栏的 **Bevy Lens** 图标（机器人图标 `hubot`）。
   - 您将直接在两个树形视图中看到我们为您准备的样例代码：
     - `src/example.rs`：包含了自定义 Component、Resource、Event、Message、Plugin 以及 Systems 的解析。
     - `src/custom_shader.wgsl`：包含了 WGSL Shader 的解析。
   - 您可以尝试在 `src/example.rs` 中新建组件或修改注释，保存文件，观察侧边栏的树形图是如何自动实时热更新的！

---

## 📂 项目结构

```
.
├── .vscode/
│   ├── launch.json    # 调试启动配置
│   └── tasks.json     # 自动编译任务 (tsc -watch)
├── src/
│   ├── bevyParser.ts  # Bevy 语义及注释解析器 (核心 AST 分析逻辑)
│   ├── bevyTreeView.ts# VS Code TreeView 提供者 (全局注册表 & 目录树)
│   ├── extension.ts   # 插件生命周期与双向同步监听入口
│   ├── example.rs     # 样例 Rust 源码文件
│   └── custom_shader.wgsl # 样例 WGSL 着色器文件
├── package.json       # 插件贡献点与元数据
└── tsconfig.json      # TypeScript 编译选项配置
```
