# 开发说明（icedly.moyu-games）

这份文档解释「为什么这样写」，面向改代码的人。用户向的介绍、操作方式和已知限制见 [README](../README.md)。

## 文件结构

```
manifest.json                 插件清单：声明 ui.view 权限与 contributes.views[0]
main.js                       插件主进程：只做偏好持久化（games.prefs.get / games.prefs.set）
views/index.html              面板入口；<meta name="pi-plugin-chrome" content="v2" />
views/assets/style.css        设计令牌（亮「考勤表」/ 暗「夜班」）+ 外壳骨架、打卡行、翻页时钟
views/assets/app.js           外壳：游戏库、hash 路由、主题、持久化、游戏运行时 ctx
views/assets/games/*.js       八个自包含游戏模块（经典脚本，无构建步骤）
```

## 为什么这样组织

宿主的实证约束（来自 `resources/app.asar` 0.15.6 与本机已安装插件）：

| 事实 | 出处 | 对本插件的影响 |
| --- | --- | --- |
| 右侧工作面板 = `contributes.views`，需要 `ui.view` 权限 | `registerPluginUiIpc` → `pluginViews` | manifest 只声明 `["ui.view"]`，一个视图 `games` |
| 面板以 `file://` 加载，CSP 为 `script-src 'self' 'unsafe-inline'`、`connect-src 'self'` | preload `plugin-panel.js` / CSP 常量 | 不能用 ES module、不能引外链资源 → 经典脚本 + 全局 `MOYU` 命名空间，零依赖零构建 |
| `pluginBridge.invoke(channel, payload)` → 插件进程 `onPanelInvoke(channel, payload)`，**无通道白名单**，转发超时 30s | `ipcMain.handle("pi-plugin-panel-invoke")`、`PLUGIN_PANEL_TIMEOUT_MS = 3e4` | 偏好读写走自定义通道 `games.prefs.*`（与 pi.file-manager 的 `fm.*` 同款）；三个通道都是内存 + 一次落盘 |
| 文档列的固定通道里**没有** `plugin.setSettings` | 插件开发文档 | 视图不能直接写设置，必须经 `main.js` 代写 |
| `pi.plugin.setSettings(partial)` 按 key 合并，落在 `<插件数据目录>/settings.json` | host API `plugin.setSettings` | 偏好按 key 合并，写坏不影响其他 key |
| `<meta name="pi-plugin-chrome" content="v2">` 时宿主发布 `--pi-plugin-titlebar-height`（停靠视图里为 0，独立面板窗口里为 46px） | preload `publishTitlebarHeight` | `body { padding-top: var(--pi-plugin-titlebar-height, 0px) }`，两种宿主形态都正确 |
| 主题经 `app.getAppearance`（`base`）+ `appearance:changed` 事件下发 | preload / 面板示例 | 亮暗双主题，切换即时生效 |
| 宿主可把视图「打开」到某位置：`?piViewOpen=<id>` 或 `view:open` 推送 | `PLUGIN_VIEW_LOCATION_EVENT` | 支持 `#/snake` 这类深链，也接受宿主投递 |
| 同一插件同时存活的停靠视图上限 4 | `MAX_LIVE_VIEWS` | 只用一个视图承载全部游戏，不触顶 |

## 游戏模块契约

每个游戏是一个自包含模块，外壳（`app.js`）负责路由、主题、持久化和资源回收：

```js
MOYU.games.<id> = {
  id, name, tagline, emoji, order,
  mount(root, ctx) { /* 挂 DOM；可返回 dispose() */ },
  unmount() {},        // 可选，ctx 资源释放后再调
  restart() {},        // 可选，顶栏「重开」按钮调用；不实现就重新 mount
  hubLine(entry) {},   // 可选：游戏库打卡行上的战绩
};
```

`ctx` 提供 `store`（get/set/bump/record/addTotal）、`toast`、`key`、`interval`、`timeout`、`frame`、`onThemeChange`、`theme`、`gameId`。
**所有**通过 `ctx` 申请的监听与定时器都会在切走游戏时被统一释放，游戏只需要在返回的 `dispose` 里收拾自己 new 的 `ResizeObserver` 之类。

游戏自己用 `MOYU.style("<id>", css)` 注入样式，类名统一加前缀（`.mg-snake-`、`.mg-ms-`…），避免互相污染。游戏内部引用的 `--mg-*` 令牌名被 `style.css` 与各游戏共同依赖：**只能改值，不能改名**。

## 持久化形状

```json
{
  "games": {
    "snake": { "plays": 3, "best": 120, "speed": "normal" },
    "minesweeper": { "plays": 5, "wins": 2, "level": "beginner", "best.beginner": 32100 },
    "office": { "value": 11542, "earned": 11544, "bulk": 1, "lastSeen": 1758674400000, "lv0": 9, "lv3": 4 },
    "sudoku": { "level": "medium", "wins": 3, "best.medium": 245000, "saved.given": "53…", "saved.cells": "53…", "saved.level": "medium" },
    "twentyfour": { "mode": "easy", "wins": 4, "best.easy": 45000, "saved.mode": "easy", "saved.hand": "2 3 5 9", "saved.steps": "0,1,0,0,0" }
  },
  "days": { "2026-09-24": 1800000 },
  "totalMs": 1234567,
  "lastGame": "snake"
}
```

`main.js` 在入口处清洗：只接受 number / boolean / string，整数夹到安全范围，字符串截断，游戏条目数与每条目键数都有上限。

`days` 是「打卡机」用的按天累计毫秒，键为本地时区的 `YYYY-MM-DD`，只保留最近 31 天（`MAX_DAY_ENTRIES`），用于首页翻页时钟显示「今日已摸 N 分」。它和 `totalMs` 分开存：前者回答「今天摸了多久」，后者回答「一共摸了多久」。

`office`（工位模拟器）一条只有 12 个键：`value` / `earned` / `bulk` / `lastSeen` 加 `lv0`…`lv7`，全部整数。条目上限 16 键（`MAX_ENTRY_KEYS`）决定了它没法按日期存历史，段位只能由 `earned` 反推；`lastSeen` 是离岗结算的唯一依据，所以每次落盘都必须刷新它，否则同一段离岗时间会被算两次。

`office` 的数值曲线由互不重叠的三条决定：装备成本按 `growth`（1.22–1.24）逐级复利、产出按等级线性、段位倍率固定 ×1.2。**段位门槛不是拍出来的，而是按目标到达时间反推的**：起手 1 分钟、中段 40 分钟、最高段位约 8 小时面板在线时长，八件全部满级约 11 小时。改动 `FACILITIES`、`RANKS`、`MAX_LEVEL` 或倍率里的任何一项，都要重新反推门槛——只改一头会退化成「几分钟通关」。冒烟里的数值曲线闸门（顶档耗时、逐档递增、终局量级、满级在段位之后）就是防这个的。

`sudoku` 一条 8 个键：`level` / `wins` / `best.easy` / `best.medium` / `best.hard` 加 `saved.given` / `saved.cells` / `saved.level`。两个 81 字符的牌面串分别存题面（同时当掩码，`0` 表示空格）和当前棋盘——这样「哪些格是题面给的」不用额外存一份布尔数组，省下的键位留给三档最快纪录。

`twentyfour` 一条 7 个键：`mode` / `wins` / `best.easy` / `best.hard` 加 `saved.mode` / `saved.hand` / `saved.steps`。`saved.hand` 存**开局**的四张牌，`saved.steps` 存此后每一步（`i,j,op,swap,hint`），恢复时把步骤重放一遍就得到当前局面——存增量而不是存快照，算式小字才能原样还原。`hint` 记的是「这一手是提示替我走的」，于是提示次数不必单独计数：撤销一步就把对应的罚时一并退回。

视图侧在插件桥不可用时（例如直接用浏览器打开 `views/index.html` 预览）自动回退到 `localStorage`（键 `moyu-games.prefs.v1`）。这条回退路径不过 `main.js`，所以天数上限与键名校验在 `app.js` 的 `normalizePrefs` 里另守一份。

## 验证

```powershell
node --check views\assets\app.js
node --check views\assets\games\*.js     # PowerShell 下逐文件执行
```

模块契约与生命周期用 Node + 最小 DOM 桩做冒烟（注册、挂载、定时器/键盘路径、卸载后无残留监听、重复进出、冷启动回填、天数上限）。
各游戏的纯逻辑（合并、旋转踢墙、消行、接龙规则、挂机的成本曲线与离岗结算、数独的生成与冲突判定、24 点的有理数与求解器）在模块上挂 `_logic` 供单测脚本驱动。

发布前另外确认：窄面板（320 / 360 / 460px）下八个游戏都不产生横向溢出；亮暗两套主题的 `--mg-*` 全部有解析值；小字与底色的对比度过 AA。
