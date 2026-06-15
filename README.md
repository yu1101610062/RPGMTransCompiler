# RPGMTransCompiler

本项目是一款面向桌面版 RPG / 视觉小说游戏的本地运行时翻译工具。它通过注入运行时插件拦截游戏窗口绘制文本，配合本地翻译应用进行异步翻译、缓存写入和窗口刷新。工具不把模型 API 密钥写入游戏插件，已翻译文本以便携缓存文件保存在游戏目录中，复制游戏目录后可直接复用已生成的译文。

RPGMTransCompiler is a local runtime translation tool for desktop RPG and visual novel games. It injects a runtime plugin that observes text rendered by game windows, while the local application translates asynchronously, writes a portable cache, and asks the game UI to refresh. Model API keys are never embedded in the game plugin; translated text is stored as a portable cache inside the game directory and can be reused when the game is moved to another machine.

## 功能 / Features

- 中文桌面启动器：支持拖入 `Game.exe`、`RPG_RT.exe` 或 `nw.exe` 后扫描、注入、监听、预翻译和启动游戏。
- 运行时翻译：首次遇到未翻译文本时显示原文并记录请求，翻译完成后写入缓存，游戏插件热加载缓存并刷新窗口。
- 预翻译缓存：扫描高置信引擎数据和脚本文本，提前写入 `RPGMTransRuntime/cache/translations.rtc`，运行时继续补漏。
- 原目录注入和还原：当前版本直接在选定游戏目录注入插件，并在修改前备份原始文件；可通过启动器或 CLI 执行还原。
- 便携缓存协议：缓存文件为纯文本协议，运行时插件无需数据库或外部运行库即可读取译文。
- 密钥隔离：API key 只由本地翻译应用读取，游戏插件不访问外部模型服务。

- Chinese desktop launcher: drag in `Game.exe`, `RPG_RT.exe`, or `nw.exe` to scan, inject, watch, pretranslate, and launch the game.
- Runtime translation: untranslated text is shown once, logged as a request, translated by the local app, cached, and reloaded by the game plugin.
- Pretranslation cache: high-confidence engine data and script text can be translated ahead of time into `RPGMTransRuntime/cache/translations.rtc`; runtime hooks still cover missed dynamic text.
- In-place injection and restore: the current version injects into the selected game directory and backs up modified files before patching.
- Portable text cache protocol: the runtime plugin reads a plain text cache without SQLite or platform-specific libraries.
- Key isolation: API keys are read only by the local translation app; game plugins never call model providers directly.

## 支持范围 / Supported Engines

| 引擎 / Engine | 状态 / Status | 说明 / Notes |
| --- | --- | --- |
| RPG Maker MV | 支持 / Supported | 桌面 NW.js 版本 / Desktop NW.js builds |
| RPG Maker MZ | 支持 / Supported | 桌面 NW.js 版本 / Desktop NW.js builds |
| RPG Maker XP | 支持 / Supported | RGSS 运行时 / RGSS runtime |
| RPG Maker VX | 支持 / Supported | RGSS2 运行时 / RGSS2 runtime |
| RPG Maker VX Ace | 支持 / Supported | RGSS3 运行时 / RGSS3 runtime |
| Ren'Py | 支持 / Supported | 桌面版，含 `.rpyc` 预翻译候选抽取 / Desktop builds, including `.rpyc` pretranslation candidate extraction |
| TyranoScript / TyranoBuilder | 支持 / Supported | 桌面版，优先 `[loadjs]` 注入 / Desktop builds, `[loadjs]` injection preferred |

不支持浏览器导出版和 RPG Maker 2000/2003。运行时补漏只能覆盖游戏实际显示过的文本；未触发过的文本会继续显示原文，直到被插件记录并由本地应用翻译。

Browser exports, mobile packages, and RPG Maker 2000/2003 are not supported. Runtime fallback only covers text that has actually been rendered by the game; unseen text remains original until it is logged and translated by the local application.

## 安装 / Installation

要求 / Requirements:

- Node.js 22.5 或更高版本 / Node.js 22.5 or newer
- Windows + .NET SDK 8，用于桌面启动器 / Windows with .NET SDK 8 for the desktop launcher
- Ruby，用于 XP/VX/VX Ace Marshal 数据桥接 / Ruby for XP/VX/VX Ace Marshal bridge
- Python，用于 Ren'Py `.rpyc` 只读文本抽取 / Python for read-only Ren'Py `.rpyc` text extraction

```powershell
npm install
npm run build
npm test
```

构建桌面启动器 / Build the desktop launcher:

```powershell
npm run desktop:publish
```

发布后的启动器位于 / Published launcher:

```text
desktop/RPGMTransLauncher/bin/Release/net8.0-windows/win-x64/publish/RPGMTransLauncher.exe
```

## 使用 / Usage

桌面启动器是主要入口。启动后拖入游戏 exe，点击“扫描”“注入插件”“启动监听”“扫描并预翻译缓存”或“一键注入并启动”。

The desktop launcher is the primary entry point. Start it, drag in the game executable, then use Scan, Install Runtime, Start Watcher, Pretranslate Cache, or One-click Inject and Launch.

CLI 示例 / CLI examples:

```powershell
node dist/cli.js scan "D:/Games/MyGame" --db "work/sample/project.sqlite" --out "D:/Games/MyGame" --target zh-Hans
node dist/cli.js install-runtime "work/sample/project.sqlite"
node dist/cli.js watch "work/sample/project.sqlite" --provider mock --batch-size 20 --concurrency 100
node dist/cli.js pretranslate "work/sample/project.sqlite" --provider mock --mode safe --batch-size 20 --concurrency 100 --progress
node dist/cli.js restore-runtime "work/sample/project.sqlite"
```

当前版本要求 `--out` 与源游戏目录一致，因为工具采用原目录注入并备份还原的流程。

The current version requires `--out` to match the source game directory because injection is performed in place with backup and restore support.

## Provider 配置 / Provider Configuration

支持 `mock`、`deepseek` 和 OpenAI-compatible provider。真实 provider 的 API key 通过启动器输入、本机环境变量或 `.env.local` 读取。不要提交 `.env.local` 或任何包含密钥的文件。

The tool supports `mock`, `deepseek`, and OpenAI-compatible providers. Real provider API keys are read from the launcher UI, local environment variables, or `.env.local`. Do not commit `.env.local` or any file containing secrets.

DeepSeek:

```powershell
$env:DEEPSEEK_BASE_URL="https://api.deepseek.com"
$env:DEEPSEEK_MODEL="<model-name>"
$env:DEEPSEEK_API_KEY="<your-api-key>"
```

OpenAI-compatible:

```powershell
$env:OPENAI_BASE_URL="https://api.openai.com/v1"
$env:OPENAI_MODEL="<model-name>"
$env:OPENAI_API_KEY="<your-api-key>"
```

## 数据和隐私 / Data and Privacy

仓库不应包含以下内容 / The repository must not contain:

- 游戏本体、封包、存档或解包后的数据文件 / Game binaries, archives, saves, or extracted data files
- `RPGMTransRuntime/`、请求日志、翻译缓存、报告和 SQLite 项目库 / Runtime folders, request logs, translation caches, reports, and SQLite project databases
- `.env`、`.env.local`、API key、访问令牌或个人本机路径 / `.env`, `.env.local`, API keys, access tokens, or personal local paths
- `node_modules/`、`dist/`、桌面启动器 `bin/obj` 等构建产物 / Build outputs such as `node_modules/`, `dist/`, and desktop launcher `bin/obj`

## 开发 / Development

```powershell
npm run build
npm test
npm run desktop:build
```

主要目录 / Main directories:

- `src/`: TypeScript CLI、运行时协议、扫描、监听、预翻译和 provider 实现
- `scripts/`: RGSS Ruby bridge 和运行时脚本模板
- `desktop/RPGMTransLauncher/`: Windows Forms 本地启动器
- `tests/`: 单元测试和运行时协议测试

## 许可证 / License

MIT License. See `LICENSE`.
