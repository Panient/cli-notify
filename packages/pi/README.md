# AI CLI Notify

一个面向 Windows 的 AI 编程 CLI 任务完成提醒插件。你在终端运行任务后，可以切去处理其他事情；任务完成或中断时，桌面右下角会出现阿尼亚提醒。不会显示提示词、代码或回复内容，也不会抢占键盘焦点。

支持 **code CLI、Claude Code、Gemini CLI、Grok Build、OpenCode、Pi**。每个平台使用独立的插件包，只安装所选平台对应的适配器。

## 安装（每个平台一条命令）

将下面的命令复制到 **Windows PowerShell**。这些命令使用 npm 下载对应的小型插件包，准备一次共享 Electron，再调用对应 CLI 的原生插件安装器。没有 npm 生命周期脚本，不会修改其他 CLI 的配置。

code CLI、Claude Code、Gemini CLI、Grok Build 的引导器会将所选平台包复制到 `%LOCALAPPDATA%\ai-cli-notify\plugins\<平台>-<版本>`，再使用原生注册/更新命令，因此不会依赖会被清理的 `npx` 临时目录。OpenCode 和 Pi 使用原生 npm 包管理，不需要这份固定副本。Gemini 首次安装可能显示原生的目录信任确认，请审查来源后自行确认；重复执行命令会更新同名插件。

```powershell
# code CLI
npx --yes ai-cli-notify-codex

# Claude Code
npx --yes ai-cli-notify-claude

# Gemini CLI
npx --yes ai-cli-notify-gemini

# Grok Build
npx --yes ai-cli-notify-grok

# OpenCode
npx --yes ai-cli-notify-opencode

# Pi
npx --yes ai-cli-notify-pi
```

安装后重新启动对应 CLI。code CLI 和 Grok 可能要求审查并信任插件 hooks；请确认脚本来源后再允许执行。

也可以先查看将执行的原生命令，而不安装：

```powershell
npx --yes ai-cli-notify-codex --dry-run
```

> 发布前，上述 npm 包需要先由仓库维护者发布；发布步骤见 [发布与维护](#发布与维护)。尚未发布时请使用下面的 GitHub 安装方式。

## 从 GitHub 直接安装

将 `OWNER/REPO` 替换为实际 GitHub 仓库。这里同样只安装对应平台的插件目录，不需要将所有平台插件启用到一个 CLI 中。

GitHub 原生安装后，请在插件所在目录运行一次 `node .\anya-notifier\scripts\ensure-electron.js`，或在仓库根目录运行同一命令准备共享 Electron。它只准备运行时，不自动注册插件；首次下载期间完成的事件会排队，不会改弹旧浮标。

### code CLI

```powershell
codex plugin marketplace add OWNER/REPO
codex plugin add ai-cli-notify@ai-cli-notify
```

### Claude Code

```powershell
claude plugin marketplace add OWNER/REPO
claude plugin install ai-cli-notify@ai-cli-notify
```

### Gemini CLI

```powershell
gemini extensions install https://github.com/OWNER/REPO
```

### Grok Build

```powershell
grok plugin install OWNER/REPO#adapters/grok --trust
```

### OpenCode

```powershell
opencode plugin ai-cli-notify-opencode --global
```

OpenCode 原生 npm 插件机制需要已发布的 `ai-cli-notify-opencode` 包。尚未发布 npm 包时，可克隆仓库并复制 `adapters/opencode/` 到 `~/.config/opencode/plugins/`；复制内容包括 `ai-cli-notify.js`、两个带前缀的 PowerShell 文件和 `anya-notifier/`。

### Pi

```powershell
pi install git:github.com/OWNER/REPO
```

也可只使用 Pi 对应的独立 npm 包：

```powershell
pi install npm:ai-cli-notify-pi
```

## 多个终端和多个平台如何提醒

所有平台共用一个本地事件队列和**一个桌面 Anya 实例**，不会弹出多个互相重叠的 Anya 窗口。

| 场景 | 提醒表现 |
| --- | --- |
| 一个平台、一个任务完成 | 紧凑气泡显示该平台名称和完成状态；单任务不显示多余汇总行。 |
| 同一平台多个终端都完成 | 一个 Anya，角标显示待查看任务总数；来源行显示 `code CLI N` 这类分组计数。 |
| 不同平台多个终端都完成 | 同一个 Anya 中显示最新完成平台，并在来源行列出所有待查看平台及各自数量。 |
| 完成和中断混合发生 | 所有待处理事件都保留计数和来源；顶部状态显示最新待处理事件。 |
| 返回某个已完成的终端 | 只清除该终端对应的提醒；其他终端/平台的提醒继续保留。 |
| 关闭某个终端 | 清除该终端对应提醒，不影响其他提醒。 |

示例：两个 code CLI 终端、一个 Claude Code 终端、一个 Pi 终端均完成时，你只会看到一个 Anya；角标为 `4`，来源汇总包含 `code CLI 2`、`Claude Code` 和 `Pi`。

## 提醒外观与生命周期

- 单个任务的气泡按平台名称和文字自适应宽度；`code CLI`、`Claude Code`、`Gemini CLI` 等平台有合适的内边距，不再使用固定的大方框。
- 多任务时才显示来源汇总，窗口按需扩展，不影响普通单任务布局。
- 只显示一个大号 Anya；没有经典长方形浮标或第二套提醒界面。
- Anya 可拖动，位置自动保存；鼠标悬停和拖动都不会放大，窗口尺寸固定。
- 多任务数字角标紧贴气泡右上角；支持庆祝/中断动画、透明 PNG 和内置 Canvas 降级形象。
- 不显示在任务栏，不创建系统托盘图标，不主动获取焦点。
- 返回来源终端或终端关闭后提醒消失；无法识别终端时，30 分钟后自动清理。
- 如果任务结束时你仍在该终端，Anya 会等你离开终端再显示；返回该终端则清除对应提醒。无法识别终端时仍会立即提醒，避免漏报。
- 诊断日志默认关闭；需要排查时可设置 `$env:AI_CLI_NOTIFY_LOG = "1"`，日志位于 `%LOCALAPPDATA%\AI CLI Notify\notify.log`，Electron 输出写入同目录的 `electron-*.log`。

## 单一 Anya 与 Electron

只保留 Electron 大号 Anya，旧 PowerShell 浮标及其回退入口已删除。所有事件先进入磁盘队列，再由一个 Electron 实例消费；单实例锁防止重复窗口。

显式安装命令会先准备共享 Electron。尚未准备好时任务事件仍保留，Electron 就绪后自动启动 Anya 并消费，不会用旧浮标代替。Electron 不重复打包到每个 CLI 插件中，下载一次后共享：

```text
%LOCALAPPDATA%\ai-cli-notify\electron\electron.exe
```

下载有进程锁、ZIP 路径检查和官方 SHA-256 校验。可通过 `ANYA_NOTIFY_ELECTRON_MIRROR`、`ANYA_NOTIFY_ELECTRON_VERSION` 配置镜像和版本，或通过 `ANYA_NOTIFY_ELECTRON_PATH` 使用已有运行时。

首次 Electron 下载需要 Node.js；已下载后不再依赖 Node.js。没有 Node.js 时请安装 Node.js 22.19 或更新版本后重试安装命令，队列中的事件不会因此静默删除。

### 可选配置

`%LOCALAPPDATA%\AI CLI Notify\anya-config.json`：

```json
{
  "useAnya": true,
  "electronPath": "C:\\Users\\you\\AppData\\Local\\ai-cli-notify\\electron\\electron.exe",
  "appDir": "C:\\path\\to\\anya-notifier",
  "expandedWidth": 420,
  "expandedHeight": 430,
  "maxExpandedWidth": 560
}
```

- `useAnya: false` 暂停提醒和 Electron 下载；事件仍保留，恢复为 `true` 后重试。
- 可选 `AI_CLI_NOTIFY_INSTALL_ROOT` 可改变四个本地路径型插件的固定安装根目录；Electron 缓存位置不随它改变。
- `expandedWidth` / `expandedHeight` 控制普通 Anya 窗口大小。
- `maxExpandedWidth` 仅限制多平台汇总时的扩展宽度。

普通提醒中的阿尼亚图片可完整显示；实际角色图片从首次启动后缓存于 `%LOCALAPPDATA%\AI CLI Notify\artwork\anya.png`，不在插件仓库内重复分发。
- 拖动位置保存于 `%LOCALAPPDATA%\AI CLI Notify\anya-position.json`。

### 自定义动画

把拥有使用许可、支持透明通道的 WebM 放入所用插件包的：

```text
anya-notifier/assets/animations/celebrate.webm
anya-notifier/assets/animations/idle.webm
```

缺失时依次回退到用户缓存的透明 PNG、内置 Canvas 角色。`anya-notifier/scripts/make-animation.ps1` 可用 ffmpeg 生成 VP9 + alpha 动画。

## 卸载

```powershell
npx --yes ai-cli-notify-codex uninstall
npx --yes ai-cli-notify-claude uninstall
npx --yes ai-cli-notify-gemini uninstall
npx --yes ai-cli-notify-grok uninstall
npx --yes ai-cli-notify-pi uninstall
npx --yes ai-cli-notify-opencode uninstall
```

OpenCode：从全局 `opencode.json` 的 `plugin` 数组删除 `ai-cli-notify-opencode`，再重启 OpenCode。共享 Electron 和用户缓存可另外删除：

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\ai-cli-notify"
```

## 运行要求与安全

- Windows，PowerShell 5.1 或更新版本；首次准备 Electron 需要 Node.js 22.19 或更新版本。
- 插件 hooks 以当前 Windows 用户权限运行。安装前请审查 `runtime/hook.ps1`、`runtime/dispatch.ps1`。
- 提醒不包含提示词、回复或代码。
- 首次运行下载 Electron 及其校验清单和角色 PNG；禁用 Anya 后不会进行这些下载。

## 发布与维护

根目录 `runtime/` 和 `anya-notifier/` 是共享实现的唯一源码。`scripts/build-packages.cjs` 为六个平台生成独立 npm 包；每包只含一个适配器、必要共享运行时和 Anya，不包含 Electron、其他平台适配器或测试文件。

```powershell
# 修改共享源码后同步原生插件副本
.\sync-runtime.ps1

# 构建六个独立 npm 包并验证实际 npm 打包内容
npm run build
npm test
npm run test:visual  # Windows 真实 Electron 隔离视觉测试

# 分别发布（需要维护者自己的 npm 登录和发布权限）
npm publish .\packages\codex --access public
npm publish .\packages\claude --access public
npm publish .\packages\gemini --access public
npm publish .\packages\grok --access public
npm publish .\packages\opencode --access public
npm publish .\packages\pi --access public
```

GitHub 仓库只需提交 `packages/` 中的六个包目录；`.test-output/`、`dist/` 和 `node_modules/` 不提交。发布 npm 前，应先完成实际 CLI 安装验证。

### 项目结构

- `runtime/`：事件解析、终端身份识别、队列和单一 Anya 调度。
- `anya-notifier/`：Electron 主进程、聚合状态、紧凑 UI、IPC 和 Electron 获取脚本。
- `adapters/<platform>/`：GitHub 原生插件的自包含目录。
- `packages/<platform>/`：独立 npm 分发包，由构建脚本生成。
- `scripts/`：独立包构建、包内容验证及安装器模板。
- `test.ps1`：手动触发 Gemini 测试事件。
- `anya-notifier/test/visual-smoke.js`：真实 Electron 的隔离视觉/聚合测试。

## 平台文档

- [Codex plugins](https://developers.openai.com/codex/plugins/)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Gemini CLI extensions](https://geminicli.com/docs/extensions/)
- [Grok Build plugins](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/09-plugins.md)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
