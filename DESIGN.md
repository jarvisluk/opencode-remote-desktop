# Design

Live Screen 侧边栏是 OpenCode Desktop 的一部分，不是一个嵌进去的独立应用。用户切换浅色/深色、换主题、换字体时，它要跟着变，看起来像原生面板。

## 原则

1. **先用原生组件，再写样式。** 有 `ctx.ui.*` 的控件一律用它；只有布局和视频区域自己写。
2. **只用主题 token，不写颜色值。** 不出现 `#hex`、`rgba()`，深浅色由 token 自动切换。
3. **画面优先。** 工具栏和信息面板尽量矮、尽量安静，把高度留给远程画面。
4. **不重复原生键盘。** 只在桌面端使用，物理键盘直接发往远端，不做屏幕按键。
5. **状态用文字 + 语义色，不用 emoji。**

## 组件

组件来自 `setup(ctx)` 的 `ctx.ui`（`node_modules/@opencode/plugin/dist/gui/host-apis.d.ts` 的 `Ui`），需要从 `Plugin.define` 一路传给视图。

| 用途 | 组件 | 用法 |
| --- | --- | --- |
| 工具栏图标按钮 | `IconButton` + `Tooltip` | `variant="ghost-muted"`，`label` 必填，提示写在 `Tooltip` |
| 有文字的操作 | `Button` | 默认 `size="small"`；主操作 `variant="contrast"`；破坏性操作 `variant="danger"` |
| 选项（窗口、帧率） | `Select` | `label` 必填 |
| 开关（链路面板等） | `Switch` | 状态在按钮内表达时可改用 `IconButton` 的选中态 |
| 文本输入 | `TextInput` | |
| 等待/连接中 | `Loader` | 不写 "Connecting…" 动画文字 |
| 低频操作 | `Menu` | 工具栏放不下的放进"更多" |
| 图标 | `Icon` | 只用 `IconName` 目录里的名字 |

工具栏图标约定：

| 动作 | 图标 |
| --- | --- |
| 适应面板 | `collapse` |
| 1:1 / 全屏 | `expand` |
| 放大 / 缩小 | `outline-magnifier-plus` / `outline-magnifier-minus` |
| 链路信息 | `info` |
| 刷新 | `outline-rotate-clockwise` |
| 屏幕 / 窗口 | `monitor` |
| 警告 / 降级 | `warning` |

## Token

以下变量取自 OpenCode Desktop 2.3.0 的样式表（`app.asar`），即 `Theme.v2Overrides` 所说的新 token 集。SDK 没把它们列为公开 API，所以用 `var(--token, 后备值)` 写后备值，版本升级后要复查。

**背景**

| Token | 用途 |
| --- | --- |
| `--v2-background-bg-base` | 面板底色 |
| `--v2-background-bg-layer-01` | 工具栏、链路面板 |
| `--v2-background-bg-layer-02` | 悬浮卡片 |
| `--v2-background-bg-deep` | 视频画面周围的留白 |
| `--v2-overlay-simple-overlay-hover` / `-pressed` | 自绘可点区域的悬停/按下 |

**文字与图标**

| Token | 用途 |
| --- | --- |
| `--v2-text-text-base` | 正文、数值 |
| `--v2-text-text-muted` | 标签、状态行 |
| `--v2-text-text-faint` | 占位、次要说明 |
| `--v2-text-text-accent` | 链接 |
| `--v2-icon-icon-muted` / `-base` | 图标默认 / 激活 |

**边框**：`--v2-border-border-base`（分隔线）、`--v2-border-border-muted`（弱分隔）、`--v2-border-border-focus`（视频获得键盘焦点时的描边）。

**状态色**

| 状态 | 前景 | 背景 |
| --- | --- | --- |
| 正常（已连接、直连） | `--v2-state-fg-success` | — |
| 降级（截图模式、TURN 中继、重连中） | `--v2-state-fg-warning` | — |
| 失败、人工接管 | `--v2-state-fg-danger` | `--v2-state-bg-danger` |
| 信息 | `--v2-state-fg-info` | — |

**字体**：界面 `--v2-font-family-sans`；数值（地址、码率、延迟）用 `--v2-font-family-code` 并开 `font-variant-numeric: tabular-nums`，防止每秒刷新时跳动。字号只用 `--font-size-small`（工具栏、链路面板）和 `--font-size-base`。

**圆角**：`--radius-sm`（徽标）、`--radius-md`（卡片、横幅）。

**间距**：基于 `--spacing`（4px 档），只用 1/2/3/4 倍：`calc(var(--spacing) * 2)`。

## 布局

```
┌ 接管横幅（仅接管时）  danger 背景 · 原因 · [完成并恢复 AI]
├ 工具栏  状态点 + 状态文字 ……  [适应][1:1][−] 100% [+] │ [ⓘ][⛶]
├ 链路面板（可折叠）  两列：标签 muted / 值 code 字体
└ 画面  bg-deep，视频 contain 居中；放大后可滚动
```

- 工具栏高度 32px，左侧状态，右侧按钮；按钮组之间用 1px `border-muted` 竖线分隔。
- 状态点 6px 圆点，颜色取状态色；文字为"WebRTC · 直连 · 30 fps · 5 ms"这类短句。
- 链路面板分三组，组名用 faint 小字：**通道**（服务器、信令通道）、**画面**（模式、路径、候选、延迟、帧率/码率/丢包、分辨率）、**输入**。
- 截图模式的降级说明用 warning 色单行，放在工具栏下，不用整条黄底。

## 交互

- 画面获得焦点后才接收键盘，此时显示 `border-focus` 描边；失焦时按键不发往远端。
- 触控板捏合 = 本地缩放；普通滚动 = 发往远端。
- 全屏是整个面板进入全屏，Esc 退出。
- 所有图标按钮都有 `Tooltip`，有快捷键的用 `Keybind` 显示。

## 文案

- 界面文字中文，技术名词保留原文：WebRTC、H.264、TURN、fps、kbps、ms。
- 数值单位前空格：`30 fps`、`5 ms`。
- 不用感叹号和 emoji。

## 现状差距

当前 `src/stream/view.ts` 与 `src/gui.ts` 尚未遵循本规范：

- 颜色全是硬编码（`#05070a`、`#b91c1c`、`rgba(255,255,255,…)`），浅色主题下会变成一块黑板。
- 按钮是自绘 `<button>` + 共享 `btn()` 样式，不是 `ctx.ui.Button` / `IconButton`。
- 窗口、帧率是原生 `<select>`，应换成 `ctx.ui.Select`。
- 接管横幅与状态文字使用 emoji（⚠️、●、⏸、⛶、ⓘ）。
- `ctx.ui` 没有传入视图。
