# Sidebery Chromium edition（实验版）

这是为 Chrome、Brave 等 Chromium 浏览器编写的独立 Manifest V3 扩展，使用浏览器原生侧边栏。界面采用浅薄荷背景（`#EFFFFD`）、灰青文字、青绿色选中项和彩色分组标签。它实现常用的侧边栏标签管理功能，并不是 Firefox 版全部功能的完整移植。

功能和交互规则见 [Chromium / Brave 功能说明](chromium-features.md)。

## 构建与安装

构建只需要 Node.js，无需安装 npm 依赖，也不会运行 Firefox 版的构建流程：

```sh
node build/chromium.js
```

构建产物位于 `dist/chromium/`。如需可分发的 ZIP 文件，使用：

```sh
node build/chromium.js --zip
```

此命令另外需要系统提供 `zip`，产物为 `dist/sidebery-chromium-0.1.0.zip`。ZIP 需要先解压，再加载其中包含 `manifest.json` 的文件夹。

1. Brave 打开 `brave://extensions`；Chrome 打开 `chrome://extensions`。
2. 打开右上角的「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择 `dist/chromium/`。
4. 将 Sidebery 固定到扩展工具栏，点击图标打开侧边栏，也可使用 `Alt+Shift+S`。
5. 快捷键冲突时，在浏览器的扩展程序「键盘快捷键」页面修改。

源码更新后重新构建，并在扩展程序管理页点击该扩展的重新加载按钮。重新加载会清除本次扩展会话保存的树形关系。

## 当前范围

- 当前窗口的垂直标签列表、切换、新建和关闭。界面不显示顶部标题栏或搜索框。
- Chromium 原生标签组，以及彩色组标题和折叠状态。
- 标签树与折叠：在侧边栏组织父子关系，同一次浏览器会话内保存树形元数据。
- “新建标签页”右侧按钮可一键折叠除当前活动标签所在树之外的所有根树；折叠后在父标签图标上显示子孙标签数量。
- 拖拽调整顺序和父子关系（上沿放到前面、下沿放到分支后面、中间作为子标签）；多选后拖到标签中间可批量成为其直接子标签。
- Ctrl / ⌘ 多选、Shift 连选后建立分组；右键可新建子标签、复制标签、移动到其他窗口、固定、静音和休眠。
- 关闭已折叠的父标签会关闭整个折叠分支；带来源标签的新页面会成为其子标签；从系统或其他应用打开的无来源链接会作为根标签追加到列表末尾。
- 浅薄荷 / 深色主题、三种密度及自定义 CSS，设置会即时应用到已打开的侧边栏。
- 手动快照：保存当前窗口的标签、分组和树形关系，恢复到新窗口，最多保留 20 份。

原生标签组由浏览器维护。侧边栏的树形层级是这个扩展自己的元数据，浏览器原生标签栏不会显示相同的树形结构。关闭侧边栏后再打开可以继续使用本次会话内的树形数据。

暂未移植 Firefox 容器、代理切换、隐藏浏览器原生标签、Firefox Sync、多面板工作区，以及 Firefox 版的设置/快照导入。浏览器完全退出或扩展重新加载后，**不会自动恢复上次会话的树形父子关系**；原生标签及分组的恢复由浏览器设置决定。

快照功能保留在后台实现中，当前极简侧边栏不提供入口。Firefox 版自定义 CSS 的选择器和变量也不完全适用于此版，可在外观设置查看此版的 CSS 示例。

## 兼容性与权限

最低要求是支持 `chrome.sidePanel.open()` 的 Chromium 116。具体浏览器还需要开放扩展侧边栏 API；Chromium 内核版本本身不保证所有衍生浏览器都实现该功能。Chrome 的侧边栏位置由浏览器设置控制，扩展不能强制隐藏顶部标签栏。

扩展声明以下权限：

| 权限        | 用途                                   |
| ----------- | -------------------------------------- |
| `tabs`      | 读取标签标题和网址并管理标签           |
| `tabGroups` | 读取和管理原生标签组                   |
| `storage`   | 保存外观设置、快照及会话内的树形元数据 |
| `sidePanel` | 在浏览器原生侧边栏显示界面             |

不请求网页内容注入权限或 `<all_urls>` 主机权限。界面和脚本都随扩展打包，不依赖远程脚本。

参考：[Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)、[Chrome 扩展图标要求](https://developer.chrome.com/docs/extensions/reference/manifest/icons)、[加载未打包的扩展](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)。

## 验证状态

2026-09-07 验证：

- `npm run test.chromium`：42 个自动化测试通过，覆盖树循环和边界校验、后台唤醒、标签 ID 替换、折叠分支关闭、保留当前树并折叠其他根树、带来源的新标签子级关系与外部链接置尾、复制、批量拖拽和跨窗口移动、快照校验和恢复、多选、错误提示、样式更新及极简标签页布局。
- 在独立临时配置的 Brave `152.1.94.121`（Chromium `152.0.7977.83`）无头实例中执行了 23 项集成检查：实际加载 MV3 扩展、打开原生侧边栏、跨组拖拽、子树移动、固定、静音、休眠及 ID 替换、停止 service worker 后唤醒、快照恢复和页面渲染，均通过。
- 构建校验所有必需文件及 JavaScript 语法；扩展 UI 截图已检查，运行时未记录到页面异常。

Chrome 使用同一套标准 API，但尚未单独运行 Chrome 的端到端测试。Brave 的完整图形界面工具栏交互、所有衍生浏览器版本，以及超大规模标签窗口尚未全面验证。此版本适合先在日常浏览器中试用，不代表 Firefox 版所有功能都已迁移。

## 许可证和来源

本项目基于 [mbnuqw/sidebery](https://github.com/mbnuqw/sidebery)，沿用仓库的 MIT 许可证。图标由原有 `src/assets/logo.svg` 转为 PNG，以满足 Chrome 对扩展清单图标格式的要求；构建产物包含原始 `LICENSE`。这是仓库内的实验性 Chromium 版本，不表示原作者发布了官方 Chrome 版本。
