# 开发说明（icedly.moyu-games）

这份文档解释「为什么这样写」，面向改代码的人。用户向的介绍、操作方式和已知限制见 [README](../README.md)。

## 文件结构

```
manifest.json                 插件清单：声明 ui.view 权限与 contributes.views[0]
main.js                       插件主进程：偏好持久化（games.prefs.*）与局域网对局通道（lan.*）
views/index.html              面板入口；<meta name="pi-plugin-chrome" content="v2" />
views/assets/style.css        设计令牌（亮「考勤表」/ 暗「夜班」）+ 外壳骨架、打卡行、翻页时钟
views/assets/app.js           外壳：游戏库、hash 路由、主题、持久化、游戏运行时 ctx
views/assets/games/*.js       十个自包含游戏模块（经典脚本，无构建步骤）
lan.js                        局域网传输：UDP 发现、TCP 房间、心跳与每座位快照分发（只被 main.js require，不进面板）
lan-gomoku.js                 五子棋规则内核（纯函数，不碰 socket，可单独单测）
lan-zhajinhua.js             炸金花规则内核（牌型、边池、按轮下注；同样可单独单测）
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
| 插件视图的出口请求只放行 `file:` / `data:` / `blob:` / `devtools:` / `chrome-extension:` / `plugin-asset:` 加清单声明的 `net.domains` | asar `isNetUrlAllowed` / `isNetSocketUrlAllowed` | 视图**不可能**直连局域网对端（`net.domains` 只收 http/https/ws/wss 裸主机名，不收 `*`、CIDR 与字面 IP）→ 网络整体放进 `lan.js` |
| 插件主进程由 `utilityProcess.fork` + `createRequire` 加载 `main.js`，是完整的 Node 环境 | asar `plugin-host-process.js` | `require("node:net")` / `require("node:dgram")` 直接可用；`PLUGIN_PERMISSIONS` 里没有「开局域网服务」这类条目，原始 socket 不走权限网关，所以「不联网」的说法要按 README 的口径写 |


### 视图脚本的加载时序

宿主把面板页当「文档已完整」注入，实测游戏模块会**分批**、晚于 `app.js` 才注册（约 400ms）。于是游戏库的第一次渲染可能只看到前几个模块，而且之后没有任何东西会再触发重绘——表现是「游戏库少几行，但游戏其实都在」。

`app.js` 的对策是启动后轮询 4 秒，**每发现 `MOYU.games` 的数量变化就重绘一次**。两条硬约束：

- 不能「一看到非空就收手」。第一个非空快照往往只含前两三个脚本，一收手就永远少几行——这是 0.4.0 里真实发生过的故障。
- 不能只在「首屏渲染成 0 款」时才启动轮询。宿主里首屏常常已经拿到两三个模块，那种情况下根本没机会启动。

复现与验证脚本见 `Temp/repro/late-games*.html`（两个文件只差文件名，用名字选时序）。

**尚未闭合的相邻风险**：如果宿主把某个游戏模块投递得比 `app.js` 还早，该模块会在顶层 `MOYU.style(...)` 抛 `TypeError` 并永不注册（`Temp/repro/late-games.html` 复现）。宿主目前实测是 `app.js` 先到，所以没触发；真出现这种症状时，要把 `el` / `clear` / `style` 三个助手从 `app.js` 挪到更早加载的位置（或内联进 `index.html` 的 `<head>`）。
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
    "twentyfour": { "mode": "easy", "wins": 4, "best.easy": 45000, "saved.mode": "easy", "saved.hand": "2 3 5 9", "saved.steps": "0,1,0,0,0" },
    "gomoku": { "plays": 2, "nickname": "摸鱼同事", "wins": 3, "losses": 1, "draws": 0, "lastHost": "192.168.1.23", "lastPort": "39732" }
    "zhajinhua": { "plays": 2, "wins": 1, "losses": 1, "hands": 2, "netChips": 60, "nickname": "摸鱼同事", "ante": 20, "cap": 400, "stack": 2000, "lastHost": "192.168.1.23", "lastPort": "39732" },
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

`gomoku`（局域网五子棋）一条 7 个键：`plays` / `wins` / `losses` / `draws` / `nickname` / `lastHost` / `lastPort`。**对局状态一个字都不落盘**——房间、棋盘、比分全在主进程 `lan.js` 的内存里，房主散桌即消失。落盘的只有自己的昵称、累计胜负，以及上次加入的地址与端口（下次进来预填「手动加入」）；`nickname` 同时也是 `lan.js` 取默认昵称的来源。

`zhajinhua`（局域网炸金花）一条 11 个键：`plays` / `wins` / `losses` / `hands` / `netChips` / `nickname` / `lastHost` / `lastPort` / `ante` / `cap` / `stack`。和五子棋一样**桌面状态一个字都不落盘**——牌桌、底池、筹码全在主进程里，房主散桌即消失；落盘的只有自己的战绩、昵称、开房参数与上次加入的地址（下次开桌时预填底注 / 封顶 / 起始筹码）。`netChips` 是净赢筹码（收池减本局投入），可以是负数；条目上限 16 键，所以「这一局的明细」只能留在界面上，不落盘。

视图侧在插件桥不可用时（例如直接用浏览器打开 `views/index.html` 预览）自动回退到 `localStorage`（键 `moyu-games.prefs.v1`）。这条回退路径不过 `main.js`，所以天数上限与键名校验在 `app.js` 的 `normalizePrefs` 里另守一份。

## 局域网对局

面板视图连不到局域网对端：它对 `file://` 的出口只放行上面那张表里列的 scheme 加 `net.domains`，而 `net.domains` 表达不了裸 IP 与端口。所以网络全部待在插件主进程，`lan.js` 由 `main.js` `require`，用 `node:net` 与 `node:dgram`。

代码按「谁碰 socket」分成两层：

- `lan.js` **只讲传输**：发现、握手、分帧、心跳、座位、每座位快照分发、长轮询。它不认识任何一条游戏规则。
- `lan-gomoku.js` / `lan-zhajinhua.js` **只讲规则**：一盘棋 / 一桌牌的状态机与全部判定，纯函数，不 require socket，能被 `Temp/tests` 里的脚本直接驱动（各带一个 `_logic` 出口给单测）。

`lan.js` 按同一份接口把两者拼起来：`capacity` / `minPlayers` / `intents` / `roomName` / `create` / `seatJoined` / `seatLeft` / `seatRenamed` / `view` / `intent` / `advertise` / `sanitize`。视图发来的意图先过 `rules.intents` 白名单（不在表里直接回「不认识的操作」），再交给 `rules.intent()`；所以加第三个联机玩法就是再加一个这样的模块，传输层一行都不用改。

协议只有一条原则：**房主权威**。房主进程持有唯一一份局面，访客只发意图、收到的是完整快照——两边规则不可能分叉，重连也只是重发一份快照。

- **发现**：UDP 39731 广播带 `moyu-lan-1` 魔数的报文。`who` 探询 → 房主回 `room`（房名、人数、上限、阶段、真实 TCP 端口，外加这桌的 `game` 与附加参数）；房主自己也周期广播，收到的广播写进房间列表，5 秒不刷新即过期。列表里的房间按 `game` 分类，两种玩法的上限也不同（五子棋 2、炸金花 5），所以大厅只列自己这一种。
- **握手**：`hello` 带协议版本和想要的游戏。`PROTO` 现在是 2（0.4.x 对端没有这个字段，或值不同）：版本不符回 `proto_mismatch`，进错游戏回 `game_mismatch`，坐满回 `room_full`；三种都补一个 `bye`，让对端干净地回到大厅，而不是留在半连接里各解析各的帧。
- **房间**：TCP 39732，被占用时退回临时端口——所以界面必须显示回包里的真实端口。换行分隔的 JSON 帧，单行有长度上限，非 JSON 与超长行直接丢弃。
- **心跳**：2 秒一次 ping，7 秒收不到判掉线。掉线的后果由规则模块决定：五子棋判对方胜，炸金花视为弃牌（他投进池里的钱留下，池子不能凭空少）。
- **每座位快照**：`snapshotFor(seat)` = `rules.sanitize(rules.view(state, seat))`，房主自己也走同一条路，所以房主与访客拿到的形状完全一致。炸金花的暗牌全靠这一条：闷牌的人**拿不到**自己那三张（`view` 给的是牌背），而不是发过去让前端藏起来——否则「闷牌只付一半」会变成稳赚（不出全价、照样知道自己的牌）。

所有外部输入都过一遍清洗：昵称去控制字符并截断，端口夹到 1–65535，连接目标只收主机名或 IP 字面量；面板发来的意图在房主侧还要再校验一次（不在你回合、格子已占、越界、不在白名单都拒）。对端发来的快照只当数据看：递归复制时丢弃 `__proto__` / `constructor` / `prototype`，深度 6 层、每层 64 键、字符串 256 字符、整包 16 KB 封顶，越界的整体丢掉；具体数值再由规则模块的 `sanitize` 夹进合法区间（超范围的取回退值，而不是贴到边界上）。

插件不能主动推事件（`onPanelInvoke` 只有请求—响应），所以界面用 `lan.wait` 长轮询：带上已知的 `seq`，没有新快照就挂到 20 秒再返回当前状态——宿主转发超时是 30 秒，留出余量。`seq` 只由真正的状态变化驱动（开房、进人、收到广播、房间过期、意图生效、对端快照），心跳本身不动 `seq`，否则长轮询会退化成每 2 秒一次的忙轮询。

端口只在用户点「创建房间」或「加入房间」时打开，离开房间或退出这个游戏界面（`dispose` 里的 `lan.close`）即释放。热重载另有一条：宿主重载只重新 `require` 入口，不会替我们调 `onUnload`，所以 `main.js` 在加载阶段就把上一份 `globalThis.__moyuLan` 关掉，否则旧实例会一直占着端口与定时器。

## 验证

```powershell
node --check views\assets\app.js
node --check views\assets\games\*.js     # PowerShell 下逐文件执行
```

模块契约与生命周期用 Node + 最小 DOM 桩做冒烟（注册、挂载、定时器/键盘路径、卸载后无残留监听、重复进出、冷启动回填、天数上限）。
各游戏的纯逻辑（合并、旋转踢墙、消行、接龙规则、挂机的成本曲线与离岗结算、数独的生成与冲突判定、24 点的有理数与求解器）在模块上挂 `_logic` 供单测脚本驱动。

发布前另外确认：窄面板（320 / 360 / 460px）下十个游戏都不产生横向溢出；亮暗两套主题的 `--mg-*` 全部有解析值；小字与底色的对比度过 AA。

局域网部分的冒烟脚本放在 `Temp/`（被 `.gitignore` 排除，不进仓库），用纯 Node 跑，不需要 Electron：

```powershell
node Temp\tests\lan.test.js             # 传输层 + 五子棋规则 + 炸金花联机（真实双端 TCP/UDP）
node Temp\tests\zhajinhua.test.js       # 炸金花规则：牌型、边池、按轮下注、私有视图
node Temp\tests\main.channels.test.js   # main.js 的通道装配、热重载放端口、onUnload 收摊
```

它们会在 399xx 上短暂绑定 UDP/TCP 做真实的双端对局，跑完即放。

视图层有两个带假插件桥的预览页：在浏览器里打开 `Temp/preview/gomoku.html`（控制台 `window.__demo.idle()/hosting()/playing()/undoRequest()/over()/joined()/broken()`）或 `Temp/preview/zhajinhua.html`（`idle()/waiting()/ready()/playing()/looked()/guest()/over()/uncontested()/broken()/heal()`），就能核对大厅 / 对局 / 结算 / 断线几种形态的布局与滚动，不必真开两个房间。`broken()` 之后用 `heal()` 加页面上的「重试」可以验恢复路径。

**发布前必须清空 `Temp/`**：`PluginPack` 按目录收文件，`.gitignore` 挡不住它，留着就会把测试脚本打进 `.piplug`。
