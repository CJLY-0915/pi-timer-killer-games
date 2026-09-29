/**
 * 局域网炸金花 — 视图侧
 *
 * 和前两个联机玩法一样，网络不在这一层：面板会话连不到局域网对端（宿主只放行
 * file:/data:/blob:/plugin-asset: 与清单里声明的 net.domains），牌局全部走主进程的
 * lan.js + lan-zhajinhua.js。这里只做三件事：
 *   1. 把 lan 快照画成牌桌（座位卡 / 自己的手牌 / 行动条 / 大厅）；
 *   2. 把「看牌 / 跟注 / 加注 / 比牌 / 弃牌 / 开始本局」当意图交给房主那一端算，自己不算规则；
 *   3. 用 lan.wait 长轮询收下一份快照（插件不能主动推事件，只能长轮询）。
 *
 * 闷牌那三张牌在房主那边就不会发过来（见 lan-zhajinhua.js 的 view），所以这里没有
 * 「把牌藏起来」的逻辑：收到什么就画什么。
 *
 * 成绩记在本地：每局结束时按自己的座位记一次胜负，同一局重复收到快照不会重复计数。
 */
(function () {
  "use strict";
  const MOYU = (window.MOYU = window.MOYU || {});
  MOYU.games = MOYU.games || {};

  /** 顶栏「重开」按钮在 mount 之外调用：留一个当前外壳的 toast。 */
  let activeToast = null;

  const POLL_MS = 8000;
  const NAME_SAVE_MS = 500;
  const ADDR_MAX = 3;
  const MAX_NAME = 24;
  /** 开房表单的初值，与 lan-zhajinhua.js 的 DEFAULTS 对齐。 */
  const DEFAULTS = { ante: 10, cap: 200, stack: 2000 };
  const MIN_PLAYERS = 2;
  const CAPACITY = 5;
  /**
   * 传输里的牌：`r` 为 2-14（11-14 是 JQK A），`s` 为 0-3（♦ ♣ ♥ ♠），`r` 为 0 是牌背。
   * 编解码口径见 lan-zhajinhua.js 的 makeDeck / CARD_BACK，这里只是一份画图用的对照表。
   */
  const SUIT_LABEL = ["♦", "♣", "♥", "♠"];
  const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };

  MOYU.style(
    "zhajinhua",
    `
    /* 主体是牌桌：配置与日志都折起来，进游戏先看到人和牌 */
    .mg-zj-wrap {
      flex: 1 1 auto; min-height: 0;
      display: flex; flex-direction: column; gap: 10px;
      overflow: auto; overscroll-behavior: contain;
    }
    /* display 会盖掉 hidden 的 UA 规则，这里统一兜一层 */
    .mg-zj-wrap [hidden] { display: none !important; }
    .mg-zj-table {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 8px;
    }
    .mg-zj-seat {
      display: grid; gap: 6px;
      padding: 9px; min-width: 0;
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-md);
      background: var(--mg-surface);
    }
    .mg-zj-seat.me { border-color: var(--mg-accent); }
    .mg-zj-seat.turn { box-shadow: inset 0 0 0 1px var(--mg-accent); }
    .mg-zj-seat.folded { opacity: 0.5; }
    .mg-zj-seat-top { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
    .mg-zj-seat-name {
      font-size: 12.5px; font-weight: 650;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .mg-zj-seat-tag { margin-left: auto; font: 10px/1.4 var(--mg-mono); color: var(--mg-dim); }
    .mg-zj-seat-hold { font-size: 11px; font-weight: 650; color: var(--mg-accent); }
    .mg-zj-seat-meta { font: 10.5px/1.5 var(--mg-mono); color: var(--mg-dim); }
    .mg-zj-tags { display: flex; flex-wrap: wrap; gap: 4px; }
    .mg-zj-tag {
      padding: 0 5px;
      border: 1px solid var(--mg-line);
      border-radius: 999px;
      font-size: 10px; color: var(--mg-dim);
    }
    .mg-zj-cards { display: flex; gap: 4px; }
    .mg-zj-card {
      display: grid; place-content: center; justify-items: center;
      width: 30px; height: 42px;
      border: 1px solid var(--mg-line);
      border-radius: 5px;
      background: var(--mg-surface-2);
      font: 650 13px/1.05 var(--mg-mono);
    }
    /* ♦ ♥ 用告警色，只有两套配色里都够显眼 */
    .mg-zj-card.red { color: var(--mg-bad); }
    .mg-zj-card .s { font-size: 11px; }
    .mg-zj-card.back {
      /* 牌背：斜纹就够，不用图片 */
      background: repeating-linear-gradient(
        45deg,
        var(--mg-surface-2) 0 4px,
        var(--mg-line) 4px 5px
      );
    }
    .mg-zj-own {
      display: flex; gap: 8px; align-items: flex-end;
    }
    .mg-zj-own .mg-zj-card { width: 46px; height: 64px; font-size: 16px; }
    .mg-zj-own .mg-zj-card .s { font-size: 13px; }
    .mg-zj-hand {
      display: grid; gap: 8px;
      padding: 10px;
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-md);
      background: var(--mg-surface);
    }
    .mg-zj-label { font-size: 10.5px; letter-spacing: 0.08em; color: var(--mg-dim); }
    .mg-zj-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .mg-zj-field { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .mg-zj-field input {
      width: 88px;
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-sm);
      background: var(--mg-surface-2);
      color: var(--mg-text);
      padding: 6px 8px;
      font: 11.5px/1.3 var(--mg-mono);
    }
    .mg-zj-field select {
      max-width: 190px;
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-sm);
      background: var(--mg-surface-2);
      color: var(--mg-text);
      padding: 5px 6px;
      font: 11.5px/1.3 var(--mg-mono);
    }
    .mg-zj-hint {
      display: grid; gap: 2px;
      padding: 9px 10px;
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-md);
      background: var(--mg-surface);
      font-size: 11.5px; line-height: 1.6; color: var(--mg-dim);
    }
    .mg-zj-hint .good { color: var(--mg-accent); }
    .mg-zj-hint .warn { color: var(--mg-warn); }
    .mg-zj-hint strong { color: var(--mg-text); font-weight: 650; user-select: text; }
    .mg-zj-empty { padding: 10px; font-size: 11.5px; color: var(--mg-dim); }
    .mg-zj-card-box {
      display: grid; gap: 8px;
      padding: 10px;
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-md);
      background: var(--mg-surface);
    }
    .mg-zj-card-title { font-size: 11.5px; font-weight: 650; }
    .mg-zj-rooms { display: grid; max-height: 170px; overflow: auto; overscroll-behavior: contain; }
    .mg-zj-room {
      appearance: none; text-align: left;
      display: grid; grid-template-columns: 1fr auto; gap: 2px 8px;
      padding: 8px 6px;
      border: 0; border-bottom: 1px solid var(--mg-line);
      background: transparent; color: var(--mg-text); cursor: pointer;
    }
    .mg-zj-room:hover { background: var(--mg-mark); }
    .mg-zj-room:disabled { opacity: 0.45; cursor: default; }
    .mg-zj-room:disabled:hover { background: transparent; }
    .mg-zj-room-name { font-size: 12.5px; font-weight: 650; }
    .mg-zj-room-sub { font: 10.5px/1.4 var(--mg-mono); color: var(--mg-dim); }
    .mg-zj-room-stat { font: 600 11px/1.4 var(--mg-mono); color: var(--mg-dim); text-align: right; }
    .mg-zj-config {
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-md);
      background: var(--mg-surface);
    }
    .mg-zj-config > summary {
      display: flex; align-items: center; gap: 6px;
      padding: 9px 10px;
      font-size: 11.5px; font-weight: 650;
      cursor: pointer; list-style: none;
    }
    .mg-zj-config > summary::-webkit-details-marker { display: none; }
    .mg-zj-config > summary::after { content: "▾"; margin-left: auto; color: var(--mg-dim); font-size: 10px; }
    .mg-zj-config[open] > summary::after { content: "▴"; }
    .mg-zj-config-body { display: grid; gap: 8px; padding: 0 10px 10px; }
    .mg-zj-log { display: grid; gap: 1px; font-size: 11px; line-height: 1.5; color: var(--mg-dim); }
    .mg-zj-log .warn { color: var(--mg-warn); }
    .mg-zj-log .error { color: var(--mg-bad); }
    .mg-zj-log .good { color: var(--mg-accent); }
    .mg-zj-addr { font: 650 11.5px/1.4 var(--mg-mono); color: var(--mg-text); user-select: text; }
    .mg-zj-note { font-size: 11px; line-height: 1.6; color: var(--mg-dim); }
    .mg-zj-note strong { color: var(--mg-warn); font-weight: 650; }
    `,
  );

  /** 输入框只有昵称、IP、端口、金额四类，都用同一套清洗。 */
  function input(props) {
    return MOYU.el("input", Object.assign({ type: "text", spellcheck: "false", autocomplete: "off" }, props));
  }

  function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const rounded = Math.round(num);
    if (rounded < min || rounded > max) return fallback;
    return rounded;
  }

  function chip(label, value) {
    return MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: label }), value);
  }

  /** 顶栏 chip 的取值节点固定是最后一个子节点。 */
  function setChip(node, text) {
    node.lastChild.textContent = text;
  }

  MOYU.games.zhajinhua = {
    id: "zhajinhua",
    name: "局域网炸金花",
    tagline: "2-5 人一张牌桌，闷牌也能玩",
    emoji: "🎴",
    order: 10,

    mount(root, ctx) {
      const id = ctx.gameId;
      activeToast = ctx.toast;
      const bridge = typeof window.pluginBridge === "object" && typeof window.pluginBridge.invoke === "function"
        ? window.pluginBridge
        : null;

      let latest = null;
      let lastSeq = -1;
      let closed = false;
      let polling = false;
      let nameTimer = 0;
      let bridgeBroken = false;

      let nickname = String(ctx.store.get(id, "nickname", "") || "").slice(0, MAX_NAME);
      let joinHost = String(ctx.store.get(id, "lastHost", "") || "");
      let joinPort = String(ctx.store.get(id, "lastPort", "") || "");
      let ante = clampInt(ctx.store.get(id, "ante", DEFAULTS.ante), 1, 100000, DEFAULTS.ante);
      let cap = clampInt(ctx.store.get(id, "cap", DEFAULTS.cap), 1, 1000000, DEFAULTS.cap);
      let stack = clampInt(ctx.store.get(id, "stack", DEFAULTS.stack), 1, 10000000, DEFAULTS.stack);
      const recorded = new Set();

      // ── DOM ────────────────────────────────────────────────────

      const statusChip = chip("状态", "连接中");
      const seatChip = chip("我", "—");
      const roundChip = chip("牌局", "—");
      const potChip = chip("底池", "0");
      const betChip = chip("注额", "—");
      const bar = MOYU.el(
        "div",
        { class: "mg-game-bar" },
        MOYU.el("div", { class: "mg-chips" }, statusChip, seatChip, roundChip, potChip, betChip),
      );

      const hint = MOYU.el("div", { class: "mg-zj-hint" });
      const tableBox = MOYU.el("div", { class: "mg-zj-table" });

      const handTitle = MOYU.el("div", { class: "mg-zj-card-title", text: "我的手牌" });
      const ownCards = MOYU.el("div", { class: "mg-zj-cards" });
      const ownNote = MOYU.el("div", { class: "mg-zj-seat-meta" });
      const ownBox = MOYU.el(
        "div",
        { class: "mg-zj-card-box", hidden: true },
        handTitle,
        MOYU.el("div", { class: "mg-zj-own" }, ownCards),
        ownNote,
      );

      const lookBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "看牌", onclick: () => act("look") });
      const callBtn = MOYU.el("button", { class: "mg-btn primary", type: "button", text: "跟注", onclick: () => act("call") });
      const foldBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "弃牌", onclick: () => act("fold") });
      const raiseInput = input({ maxlength: "7", placeholder: "金额" });
      const raiseBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "加注", onclick: () => raiseTo() });
      const compareSelect = MOYU.el("select", { class: "mg-zj-select" });
      const compareBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "比牌", onclick: () => compareWith() });
      const nextBtn = MOYU.el("button", { class: "mg-btn primary", type: "button", text: "开始本局", onclick: () => act("next") });
      const leaveBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "退出房间", onclick: () => leaveRoom() });

      const raiseRow = MOYU.el(
        "div",
        { class: "mg-zj-field", hidden: true },
        MOYU.el("span", { class: "mg-zj-label", text: "加注到" }),
        raiseInput,
        raiseBtn,
      );
      const compareRow = MOYU.el(
        "div",
        { class: "mg-zj-field", hidden: true },
        MOYU.el("span", { class: "mg-zj-label", text: "跟谁比" }),
        compareSelect,
        compareBtn,
      );
      const actionBar = MOYU.el("div", { class: "mg-zj-actions", hidden: true }, lookBtn, callBtn, foldBtn, raiseRow, compareRow, nextBtn, leaveBtn);
      const actionNote = MOYU.el("div", { class: "mg-zj-seat-meta", hidden: true });

      // 联机配置默认折叠：进游戏先看到牌桌，昵称 / 开房参数 / 手动加入 / 本机地址都在这一张卡片里
      const nameInput = input({ maxlength: String(MAX_NAME), placeholder: "给自己起个名字" });
      nameInput.value = nickname;
      const hostInput = input({ maxlength: "64", placeholder: "对方的 IP，例如 192.168.1.23" });
      hostInput.value = joinHost;
      const portInput = input({ maxlength: "5", placeholder: "端口" });
      portInput.value = joinPort;
      const anteInput = input({ class: "short", maxlength: "7" });
      anteInput.value = String(ante);
      const capInput = input({ maxlength: "7" });
      capInput.value = String(cap);
      const stackInput = input({ maxlength: "8" });
      stackInput.value = String(stack);
      const addrLine = MOYU.el("div", { class: "mg-zj-addr", text: "正在读取本机地址…" });
      const lobbyDiag = MOYU.el("div", { class: "mg-zj-log" });

      const config = MOYU.el(
        "details",
        { class: "mg-zj-config" },
        MOYU.el("summary", { text: "联机设置" }),
        MOYU.el(
          "div",
          { class: "mg-zj-config-body" },
          MOYU.el("div", { class: "mg-zj-label", text: "你的名字" }),
          MOYU.el("div", { class: "mg-zj-field" }, nameInput),
          MOYU.el("div", { class: "mg-zj-label", text: "开房参数（自己做房主时生效）" }),
          MOYU.el(
            "div",
            { class: "mg-zj-field" },
            MOYU.el("span", { class: "mg-zj-label", text: "底注" }),
            anteInput,
            MOYU.el("span", { class: "mg-zj-label", text: "单注封顶" }),
            capInput,
            MOYU.el("span", { class: "mg-zj-label", text: "起始筹码" }),
            stackInput,
          ),
          MOYU.el("div", { class: "mg-zj-label", text: "手动加入" }),
          MOYU.el(
            "div",
            { class: "mg-zj-field" },
            hostInput,
            portInput,
            MOYU.el("button", { class: "mg-btn", type: "button", text: "加入", onclick: () => manualJoin() }),
          ),
          MOYU.el("div", { class: "mg-zj-label", text: "本机" }),
          addrLine,
          MOYU.el(
            "div",
            { class: "mg-zj-note" },
            "只在创建或加入房间时开端口：发现走 UDP 39731，房间走 TCP 39732（被占用时自动换一个）。",
            MOYU.el("strong", { text: "第一次开房 Windows 可能弹出防火墙询问，要选允许，否则同事连不进来。" }),
          ),
          lobbyDiag,
        ),
      );

      const roomsBox = MOYU.el("div", { class: "mg-zj-rooms" });
      const roomsCard = MOYU.el(
        "div",
        { class: "mg-zj-card-box" },
        MOYU.el("div", { class: "mg-zj-card-title", text: "局域网里找到的牌桌" }),
        roomsBox,
      );

      const roomLog = MOYU.el("div", { class: "mg-zj-log" });
      const logCard = MOYU.el(
        "div",
        { class: "mg-zj-card-box", hidden: true },
        MOYU.el("div", { class: "mg-zj-card-title", text: "牌局记录" }),
        roomLog,
      );

      const lobbyActions = MOYU.el(
        "div",
        { class: "mg-zj-actions" },
        MOYU.el("button", { class: "mg-btn primary", type: "button", text: "创建牌桌", onclick: () => createRoom() }),
        MOYU.el("button", { class: "mg-btn", type: "button", text: "刷新牌桌", onclick: () => refresh() }),
      );

      const offlineDetail = MOYU.el("div", { class: "mg-panel-text", text: "" });
      const offline = MOYU.el(
        "div",
        { class: "mg-panel", hidden: Boolean(bridge) },
        MOYU.el("div", { class: "mg-panel-title", text: "联机只在 PI-Desktop 面板里可用" }),
        MOYU.el("div", { class: "mg-panel-text", text: "局域网牌局要经插件主进程收发，直接在浏览器里打开这个视图时拿不到插件桥。" }),
        offlineDetail,
        MOYU.el(
          "div",
          { class: "mg-panel-actions" },
          MOYU.el("button", { class: "mg-btn primary", type: "button", text: "重试", onclick: () => retryBridge() }),
        ),
      );

      const stageNodes = [hint, tableBox, ownBox, actionBar, actionNote, lobbyActions, roomsCard, config, logCard];
      function showStage(visible) {
        for (const node of stageNodes) node.hidden = !visible;
      }

      const wrap = MOYU.el("div", { class: "mg-zj-wrap" }, offline, ...stageNodes);
      root.append(bar, wrap);
      if (!bridge) showStage(false);

      // ── 与主进程通话 ────────────────────────────────────────────

      async function call(channel, payload) {
        if (!bridge) throw new Error("没有插件桥");
        const result = await bridge.invoke(channel, payload || {});
        if (!result || typeof result !== "object") throw new Error("插件没有回话");
        if (result.status) applyStatus(result.status);
        return result;
      }

      /** 动作失败只提示，不打断界面：真正的状态由下一次快照决定。 */
      async function act(kind, payload) {
        try {
          const result = await call("lan.action", Object.assign({ kind, name: nickname }, payload));
          if (result.ok !== true) ctx.toast(result.message || "这个操作现在不行");
        } catch (error) {
          bridgeDown(error);
        }
      }

      function raiseTo() {
        const state = match();
        const target = Math.round(Number(raiseInput.value));
        if (!state || !Number.isFinite(target)) {
          ctx.toast("先填一个加注金额");
          return;
        }
        // 只管规则真正要求的两条界：比当前注额高、不超封顶（这条之外的房主那边也会拒）
        if (target <= state.currentBet || target > state.cap) {
          ctx.toast(`加注要在 ${state.currentBet + 1}-${state.cap} 之间`);
          return;
        }
        act("raise", { to: target });
      }

      function compareWith() {
        const target = Number(compareSelect.value);
        if (!Number.isInteger(target) || target < 1) {
          ctx.toast("先选一个比牌的人");
          return;
        }
        act("compare", { target });
      }

      async function createRoom() {
        try {
          const result = await call("lan.host", {
            name: nickname,
            game: "zhajinhua",
            ante,
            cap,
            stack,
          });
          if (result.ok !== true) ctx.toast(result.message || "开桌失败");
        } catch (error) {
          bridgeDown(error);
        }
      }

      async function joinRoom(host, port) {
        try {
          const result = await call("lan.join", { host, port, name: nickname, game: "zhajinhua" });
          if (result.ok === true) {
            joinHost = String(host);
            joinPort = String(port);
            ctx.store.set(id, "lastHost", joinHost);
            ctx.store.set(id, "lastPort", joinPort);
            hostInput.value = joinHost;
            portInput.value = joinPort;
            return;
          }
          ctx.toast(result.message || "加入失败");
        } catch (error) {
          bridgeDown(error);
        }
      }

      function manualJoin() {
        const host = hostInput.value.trim();
        const port = Number(portInput.value.trim());
        if (!host) {
          ctx.toast("先填对方的 IP");
          return;
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          ctx.toast("端口要填 1-65535");
          return;
        }
        joinRoom(host, port);
      }

      async function leaveRoom() {
        try {
          await call("lan.leave", {});
        } catch (error) {
          bridgeDown(error);
        }
      }

      async function refresh() {
        try {
          await call("lan.scan", { name: nickname });
        } catch (error) {
          bridgeDown(error);
        }
      }

      function bridgeDown(error) {
        if (bridgeBroken) return;
        bridgeBroken = true;
        showStage(false);
        offline.hidden = false;
        offlineDetail.textContent = String(error?.message || error);
        ctx.toast("和插件主进程的连接断了");
      }

      /** 桥断了不用退出去重进：修好（例如插件重新加载）后点一下就能继续。 */
      function retryBridge() {
        bridgeBroken = false;
        offline.hidden = true;
        latest = null;
        // showStage(false) 把整块舞台都关了，这里先放回来，再由 render() 按状态收掉该收的
        showStage(true);
        start();
      }

      // ── 快照 ───────────────────────────────────────────────────

      function applyStatus(status) {
        if (closed || !status || typeof status !== "object") return;
        latest = status;
        if (typeof status.seq === "number") lastSeq = status.seq;
        render();
      }

      function inRoom() {
        return Boolean(latest) && (latest.mode === "hosting" || latest.mode === "joined" || latest.mode === "joining");
      }

      function match() {
        return latest && latest.match ? latest.match : null;
      }

      function mySeat() {
        return latest && Number(latest.seat) ? Number(latest.seat) : 0;
      }

      function myPlayer(state) {
        const seat = mySeat();
        if (!state || !seat) return null;
        return (state.players || []).find((row) => row.seat === seat) || null;
      }

      function nameOf(state, seat) {
        return (state && state.names && state.names[seat]) || `${seat} 号位`;
      }

      function modeText() {
        if (!latest) return "连接中";
        if (latest.mode === "hosting") return "自己开的桌";
        if (latest.mode === "joined") return "在同事桌上";
        if (latest.mode === "joining") return "正在连接";
        return latest.error ? "出错" : "空闲";
      }

      // ── 渲染 ───────────────────────────────────────────────────

      function render() {
        if (closed || !latest) return;
        const roomy = inRoom();
        roomsCard.hidden = roomy;
        logCard.hidden = !roomy;
        lobbyActions.hidden = roomy;
        actionBar.hidden = !roomy;
        actionNote.hidden = !roomy;
        renderChips();
        renderHint(roomy);
        renderTable(roomy);
        renderOwn(roomy);
        if (roomy) {
          renderActions();
          renderLog();
        } else {
          renderLobby();
        }
      }

      function renderChips() {
        const state = match();
        setChip(statusChip, modeText());
        setChip(seatChip, mySeat() ? `${mySeat()} 号位` : "—");
        setChip(roundChip, state && state.hand ? `第 ${state.hand} 局` : "—");
        setChip(potChip, state ? String(state.pot ?? 0) : "0");
        setChip(betChip, state ? `${state.currentBet ?? 0} / ${state.cap ?? 0}` : "—");
      }

      function line(text, level) {
        return MOYU.el("div", { class: level || "", text });
      }

      /** 牌桌上方那一行：大厅讲怎么开局，房间里讲现在什么局面、本局结果。 */
      function renderHint(roomy) {
        MOYU.clear(hint);
        if (!roomy) {
          hint.append(line("同一局域网里 2-5 个人就能凑一桌：自己开一间当房主，或者从下面的牌桌列表进同事那一间。"));
          hint.append(line("规则：每人三张牌，闷牌只出明牌的一半；比牌要先看牌，且要付一次跟注。"));
          return;
        }
        const state = match();
        const phase = state?.phase || "waiting";
        if (phase === "waiting") {
          const addrs = (latest.self?.addrs || []).slice(0, ADDR_MAX);
          const where = latest.self?.tcpPort ? `${addrs.join(" / ") || "127.0.0.1"}:${latest.self.tcpPort}` : "";
          hint.append(
            MOYU.el("div", {}, MOYU.el("strong", { text: where ? (state.canNext ? "够开局了" : "等人入座") : "房间正在开端口…" }), where ? ` · 把这串发给同事：${where}` : ""),
          );
          const seated = (state.players || []).length;
          hint.append(
            line(
              state.canNext
                ? `已上桌 ${seated}/${latest.room?.cap || CAPACITY} 人 · 点「开始本局」发牌（想再多叫几个人也行）`
                : `已上桌 ${seated}/${latest.room?.cap || CAPACITY} 人 · 至少 ${MIN_PLAYERS} 家人有筹码才能发牌`,
            ),
          );
          return;
        }
        if (phase === "playing") {
          hint.append(
            MOYU.el(
              "div",
              {},
              MOYU.el("strong", { text: `第 ${state.hand} 局 · 第 ${state.roundOf}/${state.maxRounds} 轮` }),
              ` · 注额 ${state.currentBet} · 封顶 ${state.cap} · 底池 ${state.pot}`,
            ),
          );
          hint.append(line(state.turn ? `${nameOf(state, state.turn)} 正在说话` : "等待发牌"));
          return;
        }
        const outcome = state?.outcome || {};
        if (outcome.type === "showdown") {
          hint.append(line(outcome.reason ? `摊牌（${outcome.reason}）` : "摊牌"));
          for (const pot of outcome.pots || []) {
            hint.append(line(`池 ${pot.amount} · 参与 ${(pot.eligible || []).map((seat) => nameOf(state, seat)).join("、")}`));
          }
          for (const win of outcome.winners || []) hint.append(line(`${win.name} 赢 ${win.amount}`, "good"));
          return;
        }
        if (outcome.type === "uncontested") {
          for (const win of outcome.winners || []) hint.append(line(`${win.name} 收下底池 ${win.amount}（其他人都弃牌了）`, "good"));
          return;
        }
        hint.append(line("本局结束"));
      }

      function cardFace(card) {
        const rank = Number(card?.r);
        if (!rank || rank < 2) return MOYU.el("span", { class: "mg-zj-card back" });
        const suit = Number(card?.s);
        const node = MOYU.el("span", { class: "mg-zj-card" });
        // ♦(0) 与 ♥(2) 是红的
        if (suit === 0 || suit === 2) node.classList.add("red");
        node.append(
          MOYU.el("span", { class: "r", text: RANK_LABEL[rank] || String(rank) }),
          MOYU.el("span", { class: "s", text: SUIT_LABEL[suit] || "?" }),
        );
        return node;
      }

      function renderTable(roomy) {
        MOYU.clear(tableBox);
        const state = roomy ? match() : null;
        const players = Array.isArray(state?.players) ? state.players : [];
        if (!players.length) {
          tableBox.append(
            MOYU.el("div", { class: "mg-zj-empty", text: roomy ? "牌桌上还没有人。" : "还没上桌：自己开一间，或从下面的牌桌列表进同事那一间。" }),
          );
          return;
        }
        for (const row of players) tableBox.append(seatCard(state, row));
      }

      function seatCard(state, row) {
        const classes = ["mg-zj-seat"];
        if (row.seat === mySeat()) classes.push("me");
        if (row.turn) classes.push("turn");
        if (row.folded) classes.push("folded");

        const tags = [];
        if (row.seat === state.dealer) tags.push("庄");
        if (row.turn) tags.push("行动中");
        if (state.phase === "playing") {
          if (!row.inHand) tags.push("本局观战");
          else if (row.folded) tags.push("已弃牌");
          else tags.push(row.looked ? "明牌" : "闷牌");
        }
        if (row.allIn) tags.push("全下");
        if (row.away || row.online === false) tags.push("离线");

        const meta = [`筹码 ${row.stack}`];
        if (state.phase === "playing") meta.push(`本局投入 ${row.committed}`, `本轮 ${row.bet}`);

        return MOYU.el(
          "div",
          { class: classes.join(" ") },
          MOYU.el(
            "div",
            { class: "mg-zj-seat-top" },
            MOYU.el("span", { class: "mg-zj-seat-name", text: `${row.name || "同事"}${row.seat === mySeat() ? "（我）" : ""}` }),
            MOYU.el("span", { class: "mg-zj-seat-tag", text: `${row.seat} 号位` }),
          ),
          MOYU.el("div", { class: "mg-zj-cards" }, (row.cards || []).slice(0, 3).map((card) => cardFace(card))),
          row.holding ? MOYU.el("div", { class: "mg-zj-seat-hold", text: row.holding }) : null,
          MOYU.el("div", { class: "mg-zj-seat-meta", text: meta.join(" · ") }),
          tags.length ? MOYU.el("div", { class: "mg-zj-tags" }, tags.map((tag) => MOYU.el("span", { class: "mg-zj-tag", text: tag }))) : null,
        );
      }

      function renderOwn(roomy) {
        const state = roomy ? match() : null;
        const me = myPlayer(state);
        const visible = Boolean(state) && Boolean(me) && Boolean(state.inHand);
        ownBox.hidden = !visible;
        if (!visible) return;
        MOYU.clear(ownCards);
        for (const card of (me.cards || []).slice(0, 3)) ownCards.append(cardFace(card));

        const bits = [state.looked ? "已看牌，跟注出全价" : "闷牌中，跟注只要一半"];
        if (me.holding) bits.push(`牌型 ${me.holding}`);
        if (me.folded) bits.push("已弃牌");
        else if (state.allIn) bits.push("已全下，等开牌");
        else bits.push(`跟注要 ${state.toCall}`);
        ownNote.textContent = bits.join(" · ");
        handTitle.textContent = state.looked ? "我的手牌" : "我的手牌（还没看）";
      }

      function renderActions() {
        const state = match();
        if (!state) return;
        const me = myPlayer(state);
        const seat = mySeat();
        const playing = state.phase === "playing";
        const inHand = Boolean(me) && Boolean(state.inHand) && !state.folded;
        const myTurn = playing && state.turn === seat && seat > 0;
        const actable = myTurn && inHand && !state.allIn;

        lookBtn.disabled = !(playing && state.inHand && !state.folded && !state.looked && !state.allIn);
        callBtn.disabled = !actable;
        callBtn.textContent = state.toCall > 0 ? `跟注 ${state.toCall}` : "跟注";
        foldBtn.disabled = !actable;
        nextBtn.disabled = !state.canNext;
        raiseRow.hidden = !actable;
        compareRow.hidden = !actable;

        // 输入框给出规则允许的下限与封顶；默认值用状态里的建议加注额（比当前注额高一点）
        const floor = Math.max(1, Number(state.currentBet) + 1);
        const max = Math.max(floor, Number(state.cap) || floor);
        const suggest = Math.min(max, Math.max(floor, Number(state.minRaise) || floor));
        raiseInput.min = String(floor);
        raiseInput.max = String(max);
        // 不打断正在输入的金额：只在光标不在输入框里时才重置
        if (document.activeElement !== raiseInput) raiseInput.value = String(suggest);

        const targets = (state.players || []).filter((row) => row.seat !== seat && row.inHand && !row.folded);
        const previous = compareSelect.value;
        MOYU.clear(compareSelect);
        for (const row of targets) {
          compareSelect.append(MOYU.el("option", { value: String(row.seat), text: `${row.seat} 号位 · ${row.name || "同事"}` }));
        }
        if (targets.some((row) => String(row.seat) === previous)) compareSelect.value = previous;
        compareBtn.disabled = !state.looked || !targets.length;

        actionNote.textContent = turnNote(state, me, actable, inHand);
      }

      function turnNote(state, me, actable, inHand) {
        if (!state.hand) return `至少 ${MIN_PLAYERS} 家人有筹码就能发牌；点「开始本局」开牌。`;
        if (state.phase !== "playing") {
          return state.canNext ? "这一局结束了；点「开始本局」发下一局。" : `这一局结束了，还差一个人（或有人的筹码见底）才能再发牌。`;
        }
        if (!me || !state.inHand) return "你中途入座，这一局不参与，等下一局发牌。";
        if (me.folded) return "这一局你已经弃牌，等下一局。";
        if (me.allIn) return "你已经全下，等开牌。";
        if (!actable) return `等 ${nameOf(state, state.turn)} 说完这一手。`;
        const bits = [state.looked ? `跟注要 ${state.toCall}` : `跟注要 ${state.toCall}（闷牌一半）`];
        bits.push(`加注区间 ${state.currentBet + 1}-${state.cap}`);
        if (!state.looked) bits.push("比牌要先看牌");
        return bits.join(" · ");
      }

      function renderLog() {
        MOYU.clear(roomLog);
        const lines = [];
        if (latest.error) lines.push({ text: String(latest.error.message), level: "error" });
        // 两边的日志都看得到：传输层讲连接，规则层讲牌局
        for (const line of (latest.log || []).slice(-3)) lines.push(line);
        for (const line of (match()?.log || []).slice(-6)) lines.push(line);
        for (const item of lines) {
          roomLog.append(
            MOYU.el("div", {
              class: item.level === "warn" ? "warn" : item.level === "error" ? "error" : item.level === "good" ? "good" : "",
              text: item.text,
            }),
          );
        }
      }

      function renderLobby() {
        roomLog.replaceChildren();
        MOYU.clear(roomsBox);
        const list = (Array.isArray(latest.rooms) ? latest.rooms : []).filter((item) => item.game === "zhajinhua");
        if (!list.length) {
          roomsBox.append(MOYU.el("div", { class: "mg-zj-empty", text: "还没找到牌桌。让同事先开一间，或者自己去开。" }));
        } else {
          for (const item of list) {
            const full = Number(item.players) >= Number(item.cap);
            const extra = item.extra && typeof item.extra === "object" ? item.extra : {};
            roomsBox.append(
              MOYU.el(
                "button",
                {
                  class: "mg-zj-room",
                  type: "button",
                  disabled: full,
                  onclick: () => joinRoom(item.addr, item.port),
                },
                MOYU.el("span", { class: "mg-zj-room-name", text: item.name || "局域网牌桌" }),
                MOYU.el("span", { class: "mg-zj-room-stat", text: full ? "已满" : `${item.players}/${item.cap}` }),
                MOYU.el("span", {
                  class: "mg-zj-room-sub",
                  text: `${item.host || "同事"} · ${item.addr}:${item.port} · ${Math.round((item.ageMs || 0) / 1000)} 秒前`,
                }),
                MOYU.el("span", {
                  class: "mg-zj-room-stat",
                  text: extra.ante ? `底注 ${extra.ante} · 封顶 ${extra.limit ?? "–"}` : "参数未知",
                }),
              ),
            );
          }
        }

        const addrs = (latest.self?.addrs || []).slice(0, ADDR_MAX);
        addrLine.textContent = addrs.length
          ? `本机地址 ${addrs.join(" / ")} · 发现端口 ${latest.self?.discoveryPort || 39731}`
          : `没读到局域网地址（只有回环可用）· 发现端口 ${latest.self?.discoveryPort || 39731}`;

        MOYU.clear(lobbyDiag);
        const lines = [];
        if (latest.error) lines.push({ text: String(latest.error.message), level: "error" });
        lines.push({ text: `发现端口 ${latest.diag?.udp ?? "–"} · 房间通道 ${latest.diag?.tcp ?? "–"}`, level: "info" });
        for (const line of (latest.log || []).slice(-2)) lines.push(line);
        for (const item of lines) {
          lobbyDiag.append(
            MOYU.el("div", {
              class: item.level === "error" ? "error" : item.level === "warn" ? "warn" : "",
              text: item.text,
            }),
          );
        }
      }

      // ── 成绩 ───────────────────────────────────────────────────

      /** 一局只记一次；同一局重复收到快照不会重复计数。 */
      function recordResult() {
        const state = match();
        if (!state || state.phase !== "over" || !state.outcome) return;
        const seat = mySeat();
        if (!seat) return;
        const key = `${latest.room?.id || "room"}:${state.hand}`;
        if (recorded.has(key)) return;
        recorded.add(key);
        const winners = Array.isArray(state.outcome.winners) ? state.outcome.winners : [];
        const mine = winners.filter((row) => row.seat === seat);
        ctx.store.bump(id, "hands");
        if (mine.length) ctx.store.bump(id, "wins");
        else ctx.store.bump(id, "losses");
        // 净赢筹码：收池减掉本局投入，可能为负
        const me = myPlayer(state);
        ctx.store.bump(id, "netChips", mine.reduce((sum, row) => sum + (Number(row.amount) || 0), 0) - (Number(me?.committed) || 0));
      }

      // ── 轮询 ───────────────────────────────────────────────────

      async function pump() {
        if (polling || closed || !bridge) return;
        polling = true;
        try {
          while (!closed) {
            const result = await bridge.invoke("lan.wait", { since: lastSeq, timeoutMs: POLL_MS });
            if (closed) return;
            if (!result || result.ok !== true || !result.status) throw new Error(result?.message || "插件没有回话");
            applyStatus(result.status);
            recordResult();
          }
        } catch (error) {
          if (!closed) bridgeDown(error);
        } finally {
          polling = false;
        }
      }

      async function start() {
        try {
          await call("lan.scan", { name: nickname });
          pump();
        } catch (error) {
          bridgeDown(error);
        }
      }

      // ── 事件 ───────────────────────────────────────────────────

      function numberField(node, key, min, max, fallback) {
        node.addEventListener("change", () => {
          const value = clampInt(node.value, min, max, fallback);
          node.value = String(value);
          ctx.store.set(id, key, value);
          if (key === "ante") ante = value;
          else if (key === "cap") cap = value;
          else stack = value;
        });
      }

      nameInput.addEventListener("input", () => {
        nickname = nameInput.value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_NAME);
        ctx.store.set(id, "nickname", nickname);
        if (nameTimer) window.clearTimeout(nameTimer);
        nameTimer = window.setTimeout(() => {
          if (closed) return;
          // 只改名字不动牌局，失败也无所谓
          call("lan.rename", { name: nickname }).catch(() => {});
        }, NAME_SAVE_MS);
      });
      hostInput.addEventListener("change", () => {
        joinHost = hostInput.value.trim();
        ctx.store.set(id, "lastHost", joinHost);
      });
      portInput.addEventListener("change", () => {
        joinPort = portInput.value.trim();
        ctx.store.set(id, "lastPort", joinPort);
      });
      numberField(anteInput, "ante", 1, 100000, DEFAULTS.ante);
      numberField(capInput, "cap", 1, 1000000, DEFAULTS.cap);
      numberField(stackInput, "stack", 1, 10000000, DEFAULTS.stack);

      start();

      return () => {
        closed = true;
        if (nameTimer) window.clearTimeout(nameTimer);
        // 离开这个界面就把牌桌和端口一起收掉（房主关掉即散桌）
        if (bridge) bridge.invoke("lan.close", {}).catch(() => {});
      };
    },

    /** 联机牌局没有「重开」：换一局要所有人都在桌上，一个按钮做不到。 */
    restart() {
      if (activeToast) activeToast("联机牌局用「开始本局」发下一局，或退出房间重来");
    },

    hubLine(entry) {
      const wins = Number(entry.wins) || 0;
      const losses = Number(entry.losses) || 0;
      if (!wins && !losses) return "";
      const net = Number(entry.netChips) || 0;
      return `联机 ${wins} 胜 · ${losses} 负${net ? ` · 净 ${net > 0 ? "+" : ""}${net}` : ""}`;
    },
  };
})();
