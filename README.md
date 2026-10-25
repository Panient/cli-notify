# AI CLI Notify

Windows 上的 AI 编程 CLI 任务完成提醒。任务完成或中断时，桌面右下角出现一个阿尼亚和简洁气泡，不显示提示词、代码或回复内容，也不抢占键盘焦点。

支持 **code CLI、Claude Code、Gemini CLI、Grok Build、OpenCode、Pi**。

## 特点

- 六个平台共用一个 Anya，多任务合并计数，不弹出多个窗口。
- 任务完成时仍在当前终端，暂不提醒；离开终端后显示，返回后清除该终端的提醒。
- 支持拖动、固定尺寸、完成/中断动画；数字角标位于气泡右上角。
- 每个平台独立安装，只包含自己的适配器和必要运行文件。
- 事件先写入本地队列，Electron 暂不可用时不会直接丢失提醒。

## 安装

要求 **Windows、PowerShell 5.1+、Node.js 22.19+**，并先安装对应 CLI。

> 当前 npm 包尚未发布。请私下获取并解压本项目，在项目根目录运行下面的本地安装命令；不要将 `npx` 命令当作已可用的安装方式。

```powershell
# code CLI
node .\packages\codex\cli.cjs --local

# Claude Code
node .\packages\claude\cli.cjs --local

# Gemini CLI
node .\packages\gemini\cli.cjs --local

# Grok Build
node .\packages\grok\cli.cjs --local

# Pi
node .\packages\pi\cli.cjs --local
```

安装后重启对应 CLI，并按 CLI 的原生提示审查、信任插件。OpenCode 的公开 npm 安装入口为 `ai-cli-notify-opencode`，需发布对应包后使用；本地插件源码位于 `adapters/opencode/`。

## 使用

正常启动支持的 CLI 即可，无需额外打开提醒程序。

- 离开正在运行的终端，任务完成后会收到提醒。
- 返回或关闭来源终端，只清除该终端的任务。
- 无法识别终端时会立即提醒，并在 30 分钟后自动清理。
- 拖动位置保存在 `%LOCALAPPDATA%\AI CLI Notify\anya-position.json`。

暂停提醒：将 `%LOCALAPPDATA%\AI CLI Notify\anya-config.json` 中的 `useAnya` 设为 `false`；恢复时改为 `true`。暂停期间不创建新事件。

排查问题时设置 `$env:AI_CLI_NOTIFY_LOG = "1"`，日志位于 `%LOCALAPPDATA%\AI CLI Notify\notify.log`。

## 卸载

在项目中运行对应命令，例如：

```powershell
node .\packages\codex\cli.cjs uninstall --local
node .\packages\claude\cli.cjs uninstall --local
node .\packages\gemini\cli.cjs uninstall --local
node .\packages\grok\cli.cjs uninstall --local
node .\packages\pi\cli.cjs uninstall --local
```

OpenCode 请从全局 `opencode.json` 的 `plugin` 数组移除 `ai-cli-notify-opencode`，再重启 OpenCode。可选清理共享缓存：

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\ai-cli-notify"
```

## 开发与验证

`runtime/` 和 `anya-notifier/` 是共享源码，`adapters/` 与 `packages/` 是同步、构建生成的分发内容。

```powershell
.\sync-runtime.ps1
npm run build
npm test
npm run test:visual
```

发布前请审查 hooks。插件以当前 Windows 用户权限运行；首次运行会下载共享 Electron 和角色图片。私有 GitHub 仓库不会自动提供 npm 下载，公开 npm 包则意味着包内代码可被公开获取。
