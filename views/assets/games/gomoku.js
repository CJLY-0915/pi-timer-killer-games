/**
 * 局域网五子棋 — 视图侧
 *
 * 网络不在这一层：面板会话连不到局域网对端（宿主只放行 file:/data:/blob:/plugin-asset:
 * 与清单里声明的 net.domains），所以对局走主进程的 lan.js。这里只做三件事：
 *   1. 把 lan 快照渲染成棋盘与大厅；
 *   2. 把「落子 / 悔棋 / 认输 / 下一局」当意图交出去，不自己算规则（主机权威）；
 *   3. 用 lan.wait 长轮询收下一次快照（插件不能主动推事件，只能长轮询）。
 *
 * 成绩记在本地：每局结束时按自己的座位记一次胜负，局数变化后才会再记一次。
 */
(function () {
  "use strict";
  const MOYU = (window.MOYU = window.MOYU || {});
  MOYU.games = MOYU.games || {};

  /** 顶栏「重开」按钮要提示，但它在 mount 之外调用：留一个当前外壳的 toast。 */
  let activeToast = null;

  const SIZE = 15;
  const POLL_MS = 8000;
  const NAME_SAVE_MS = 500;
  const ADDR_MAX = 3;

  MOYU.style(
    "gomoku",
    `
    /* 主体是棋盘：配置与日志都折起来，进游戏先看到能下棋的那一块 */
    .mg-gk-wrap {
      flex: 1 1 auto; min-height: 0;
      display: flex; flex-direction: column; gap: 10px;
      overflow: auto; overscroll-behavior: contain;
    }
    /* display 会盖掉 hidden 的 UA 规则，这里统一兜一层 */
    .mg-gk-wrap [hidden] { display: none !important; }
    .mg-gk-board { flex: 1 1 auto; min-height: 260px; }
    .mg-gk-canvas {
      display: block;
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-md);
      background: var(--mg-surface-2);
      touch-action: none;
    }
    .mg-gk-line { display: flex; flex-wrap: wrap; gap: 2px 6px; align-items: baseline; font-size: 11.5px; line-height: 1.55; color: var(--mg-dim); }
    .mg-gk-line strong { color: var(--mg-text); font-weight: 650; user-select: text; }
    .mg-gk-side { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .mg-gk-card {
      display: grid; gap: 8px;
      padding: 10px;
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-md);
      background: var(--mg-surface);
    }
    .mg-gk-card-title { font-size: 11.5px; font-weight: 650; }
    .mg-gk-label { font-size: 10.5px; letter-spacing: 0.08em; color: var(--mg-dim); }
    .mg-gk-field { display: flex; gap: 6px; align-items: center; }
    .mg-gk-field input {
      flex: 1 1 auto; min-width: 0;
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-sm);
      background: var(--mg-surface-2);
      color: var(--mg-text);
      padding: 6px 8px;
      font: 11.5px/1.3 var(--mg-mono);
    }
    .mg-gk-field .short { flex: 0 0 78px; }
    .mg-gk-rooms { display: grid; max-height: 170px; overflow: auto; overscroll-behavior: contain; }
    .mg-gk-room {
      appearance: none; text-align: left;
      display: grid; grid-template-columns: 1fr auto; gap: 2px 8px;
      padding: 8px 6px;
      border: 0; border-bottom: 1px solid var(--mg-line);
      background: transparent; color: var(--mg-text); cursor: pointer;
    }
    .mg-gk-room:hover { background: var(--mg-mark); }
    .mg-gk-room:disabled { opacity: 0.45; cursor: default; }
    .mg-gk-room:disabled:hover { background: transparent; }
    .mg-gk-room-name { font-size: 12.5px; font-weight: 650; }
    .mg-gk-room-sub { font: 10.5px/1.4 var(--mg-mono); color: var(--mg-dim); }
    .mg-gk-room-stat { font: 600 11px/1.4 var(--mg-mono); color: var(--mg-dim); text-align: right; }
    .mg-gk-empty { padding: 8px 6px; font-size: 11px; color: var(--mg-dim); }
    .mg-gk-config {
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-md);
      background: var(--mg-surface);
    }
    .mg-gk-config > summary {
      display: flex; align-items: center; gap: 6px;
      padding: 9px 10px;
      font-size: 11.5px; font-weight: 650;
      cursor: pointer; list-style: none;
    }
    .mg-gk-config > summary::-webkit-details-marker { display: none; }
    .mg-gk-config > summary::after { content: "▾"; margin-left: auto; color: var(--mg-dim); font-size: 10px; }
    .mg-gk-config[open] > summary::after { content: "▴"; }
    .mg-gk-config-body { display: grid; gap: 8px; padding: 0 10px 10px; }
    .mg-gk-log { display: grid; gap: 1px; font-size: 11px; line-height: 1.5; color: var(--mg-dim); }
    .mg-gk-log .warn { color: var(--mg-warn); }
    .mg-gk-log .error { color: var(--mg-bad); }
    .mg-gk-log .good { color: var(--mg-accent); }
    .mg-gk-addr { font: 650 11.5px/1.4 var(--mg-mono); color: var(--mg-text); user-select: text; }
    .mg-gk-note { font-size: 11px; line-height: 1.6; color: var(--mg-dim); }
    .mg-gk-note strong { color: var(--mg-warn); font-weight: 650; }
    `,
  );

  function readColors() {
    const style = getComputedStyle(document.documentElement);
    const value = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    return {
      line: value("--mg-line", "#2e3540"),
      surface: value("--mg-surface", "#1b2027"),
      surface2: value("--mg-surface-2", "#222831"),
      text: value("--mg-text", "#e4e2d7"),
      dim: value("--mg-dim", "#8b94a0"),
      accent: value("--mg-accent", "#57c4a6"),
      bad: value("--mg-bad", "#d9584b"),
      rule: value("--mg-rule-ink", "rgba(0,0,0,.4)"),
    };
  }

  /** 无边框输入：只有昵称、IP、端口三个字段，都用同一套清洗。 */
  function input(props) {
    return MOYU.el("input", Object.assign({ type: "text", spellcheck: "false", autocomplete: "off" }, props));
  }

  MOYU.games.gomoku = {
    id: "gomoku",
    name: "局域网五子棋",
    tagline: "同一张局域网，两个人下一步",
    emoji: "⚫",
    order: 9,

    mount(root, ctx) {
      const id = ctx.gameId;
      activeToast = ctx.toast;
      const bridge = typeof window.pluginBridge === "object" && typeof window.pluginBridge.invoke === "function"
        ? window.pluginBridge
        : null;

      let colors = readColors();
      let latest = null;
      let lastSeq = -1;
      let closed = false;
      let polling = false;
      let nameTimer = 0;
      let bridgeBroken = false;

      let nickname = String(ctx.store.get(id, "nickname", "") || "").slice(0, 24);
      let joinHost = String(ctx.store.get(id, "lastHost", "") || "");
      let joinPort = String(ctx.store.get(id, "lastPort", "") || "");
      const recorded = new Set();

      // 键盘光标：方向键移动，回车落子
      let cursor = { x: 7, y: 7 };
      let hover = null;
      let metrics = { size: 0, cell: 0 };

      // ── DOM ────────────────────────────────────────────────────

      const statusChip = MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: "状态" }), "连接中");
      const sideChip = MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: "我" }), "—");
      const rivalChip = MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: "对手" }), "等待");
      const scoreChip = MOYU.el("span", { class: "mg-chip good" }, MOYU.el("span", { class: "k", text: "比分" }), "0 : 0");
      const movesChip = MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: "手数" }), "0");

      const bar = MOYU.el(
        "div",
        { class: "mg-game-bar" },
        MOYU.el("div", { class: "mg-chips" }, statusChip, sideChip, rivalChip, scoreChip, movesChip),
      );

      // 联机配置默认折叠：进游戏先看到棋盘，昵称 / 手动加入 / 本机地址 / 诊断都在这一张卡片里
      const nameInput = input({ maxlength: "24", placeholder: "给自己起个名字" });
      nameInput.value = nickname;
      const hostInput = input({ maxlength: "64", placeholder: "对方的 IP，例如 192.168.1.23" });
      hostInput.value = joinHost;
      const portInput = input({ class: "short", maxlength: "5", placeholder: "端口" });
      portInput.value = joinPort;
      const addrLine = MOYU.el("div", { class: "mg-gk-addr", text: "正在读取本机地址…" });
      const lobbyDiag = MOYU.el("div", { class: "mg-gk-log" });
      const config = MOYU.el(
        "details",
        { class: "mg-gk-config" },
        MOYU.el("summary", { text: "联机设置" }),
        MOYU.el(
          "div",
          { class: "mg-gk-config-body" },
          MOYU.el("div", { class: "mg-gk-label", text: "你的名字" }),
          MOYU.el("div", { class: "mg-gk-field" }, nameInput),
          MOYU.el("div", { class: "mg-gk-label", text: "手动加入" }),
          MOYU.el(
            "div",
            { class: "mg-gk-field" },
            hostInput,
            portInput,
            MOYU.el("button", { class: "mg-btn", type: "button", text: "加入", onclick: () => manualJoin() }),
          ),
          MOYU.el("div", { class: "mg-gk-label", text: "本机" }),
          addrLine,
          MOYU.el(
            "div",
            { class: "mg-gk-note" },
            "只在创建或加入房间时开端口：发现走 UDP 39731，房间走 TCP 39732（被占用时自动换一个）。",
            MOYU.el("strong", { text: "第一次开房 Windows 可能弹出防火墙询问，要选允许，否则同事连不进来。" }),
          ),
          lobbyDiag,
        ),
      );

      const roomsBox = MOYU.el("div", { class: "mg-gk-rooms" });
      const roomsCard = MOYU.el(
        "div",
        { class: "mg-gk-card" },
        MOYU.el("div", { class: "mg-gk-card-title", text: "局域网里找到的房间" }),
        roomsBox,
      );

      // 棋盘是主视图：大厅里也画一副空盘，进游戏就看到「能下棋的那一块」
      const canvas = MOYU.el("canvas", { class: "mg-gk-canvas" });
      const board = MOYU.el("div", { class: "mg-board mg-gk-board" }, canvas);
      const overlay = MOYU.el("div", { class: "mg-overlay", hidden: true });
      const overlayBody = MOYU.el("div", { class: "mg-panel" });
      overlay.append(overlayBody);
      board.append(overlay);

      const statusLine = MOYU.el("div", { class: "mg-gk-line" });

      const undoBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "悔棋", onclick: () => act("undo.request") });
      const resignBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "认输", onclick: () => act("resign") });
      const rematchBtn = MOYU.el("button", { class: "mg-btn primary", type: "button", text: "下一局", onclick: () => act("rematch") });
      const leaveBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "退出房间", onclick: () => leaveRoom() });
      const acceptBtn = MOYU.el("button", { class: "mg-btn primary", type: "button", text: "同意悔棋", onclick: () => act("undo.accept") });
      const rejectBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "不同意", onclick: () => act("undo.reject") });
      const undoPrompt = MOYU.el(
        "div",
        { class: "mg-gk-field", hidden: true },
        MOYU.el("span", { class: "mg-gk-label", text: "对方想悔棋：" }),
        acceptBtn,
        rejectBtn,
      );

      const roomActions = MOYU.el("div", { class: "mg-gk-side", hidden: true }, undoBtn, resignBtn, rematchBtn, leaveBtn);
      const lobbyActions = MOYU.el(
        "div",
        { class: "mg-gk-side" },
        MOYU.el("button", { class: "mg-btn primary", type: "button", text: "创建房间", onclick: () => createRoom() }),
        MOYU.el("button", { class: "mg-btn", type: "button", text: "刷新房间", onclick: () => refresh() }),
      );

      const roomLog = MOYU.el("div", { class: "mg-gk-log" });
      const logCard = MOYU.el(
        "div",
        { class: "mg-gk-card", hidden: true },
        MOYU.el("div", { class: "mg-gk-card-title", text: "对局记录" }),
        roomLog,
      );

      const offlineDetail = MOYU.el("div", { class: "mg-panel-text", text: "" });
      const offline = MOYU.el(
        "div",
        { class: "mg-panel", hidden: Boolean(bridge) },
        MOYU.el("div", { class: "mg-panel-title", text: "联机只在 PI-Desktop 面板里可用" }),
        MOYU.el("div", { class: "mg-panel-text", text: "局域网对局要经插件主进程收发，直接在浏览器里打开这个视图时拿不到插件桥。" }),
        offlineDetail,
        MOYU.el(
          "div",
          { class: "mg-panel-actions" },
          MOYU.el("button", { class: "mg-btn primary", type: "button", text: "重试", onclick: () => retryBridge() }),
        ),
      );

      const stageNodes = [board, statusLine, roomActions, undoPrompt, lobbyActions, roomsCard, config, logCard];
      function showStage(visible) {
        for (const node of stageNodes) node.hidden = !visible;
      }

      const wrap = MOYU.el("div", { class: "mg-gk-wrap" }, offline, ...stageNodes);
      root.append(bar, wrap);
      if (!bridge) showStage(false);

      function statusText(node, text) {
        node.lastChild.textContent = text;
      }

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

      async function createRoom() {
        try {
          const result = await call("lan.host", { name: nickname, game: "gomoku" });
          if (result.ok !== true) ctx.toast(result.message || "开房失败");
        } catch (error) {
          bridgeDown(error);
        }
      }

      async function joinRoom(host, port) {
        try {
          const result = await call("lan.join", { host, port, name: nickname, game: "gomoku" });
          if (result.ok === true) {
            joinHost = host;
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

      function play(x, y) {
        if (!canPlay()) return;
        if (stone(x, y) !== "0") return;
        call("lan.move", { x, y }).then((result) => {
          if (result.ok !== true) ctx.toast(result.message || "这手不行");
        }).catch(bridgeDown);
        cursor = { x, y };
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

      function stone(x, y) {
        const board = match()?.board;
        if (typeof board !== "string" || board.length !== SIZE * SIZE) return "0";
        return board.charAt(y * SIZE + x);
      }

      function canPlay() {
        const state = match();
        return Boolean(state) && state.phase === "playing" && mySeat() > 0 && state.turn === mySeat();
      }

      // ── 渲染 ───────────────────────────────────────────────────

      function render() {
        if (closed || !latest) return;
        const roomy = inRoom();
        roomsCard.hidden = roomy;
        logCard.hidden = !roomy;
        roomActions.hidden = !roomy;
        lobbyActions.hidden = roomy;
        renderChips();
        renderStatus(roomy);
        if (roomy) renderRoom();
        else {
          undoPrompt.hidden = true;
          renderLobby();
        }
        renderOverlay(roomy ? match()?.phase || "waiting" : "idle", mySeat());
        sizeCanvas();
      }

      function renderChips() {
        statusText(statusChip, modeText());
        const seat = mySeat();
        statusText(sideChip, seat ? `${seat === 1 ? "黑" : "白"}（${seat === 1 ? "先手" : "后手"}）` : "—");
        const state = match();
        const rivalSeat = seat === 1 ? 2 : 1;
        const rivalName = state?.names?.[rivalSeat] || "";
        statusText(rivalChip, rivalName || "等待");
        statusText(scoreChip, state ? `${state.score?.[seat] ?? 0} : ${state.score?.[rivalSeat] ?? 0}` : "0 : 0");
        statusText(movesChip, String(state?.moves ?? 0));
      }

      function modeText() {
        if (!latest) return "连接中";
        if (latest.mode === "hosting") return "房间中";
        if (latest.mode === "joined") return "对局中";
        if (latest.mode === "joining") return "正在连接";
        return latest.error ? "出错" : "空闲";
      }

      /** 棋盘上面那一行：大厅讲怎么开局，房间里讲现在什么局面。 */
      function renderStatus(roomy) {
        if (!roomy) {
          const addrs = Array.isArray(latest.self?.addrs) ? latest.self.addrs.slice(0, ADDR_MAX) : [];
          statusLine.textContent = addrs.length
            ? `本机 ${addrs.join(" / ")} · 发现端口 ${latest.self?.discoveryPort || 39731}`
            : "没读到局域网地址（只有回环可用）";
          return;
        }
        const state = match();
        const seat = mySeat();
        const phase = state?.phase || "waiting";
        const rivalName = state?.names?.[seat === 1 ? 2 : 1] || "";
        const bits = [MOYU.el("strong", { text: latest.room?.name || "房间" })];
        if (phase === "waiting") {
          const addrs = (latest.self?.addrs || []).slice(0, ADDR_MAX);
          bits.push(
            MOYU.el("span", {
              text: latest.self?.tcpPort
                ? `等人入座 · ${addrs.join(" / ") || "127.0.0.1"}:${latest.self.tcpPort}`
                : "正在开端口…",
            }),
          );
        } else if (phase === "playing") {
          bits.push(
            MOYU.el("span", {
              text: `第 ${state.round} 局 · ${state.turn === seat ? "轮到你了" : "等对方落子"}${rivalName ? ` · 对手 ${rivalName}` : ""}`,
            }),
          );
        } else {
          bits.push(MOYU.el("span", { text: `第 ${state.round} 局结束` }));
        }
        statusLine.replaceChildren(...bits);
      }

      function renderLobby() {
        MOYU.clear(roomsBox);
        const roomList = (Array.isArray(latest.rooms) ? latest.rooms : []).filter((item) => item.game === "gomoku");
        if (!roomList.length) {
          roomsBox.append(MOYU.el("div", { class: "mg-gk-empty", text: "还没找到房间。让同事先创建一间，或者自己去开。" }));
        } else {
          for (const item of roomList) {
            const full = Number(item.players) >= Number(item.cap);
            roomsBox.append(
              MOYU.el(
                "button",
                {
                  class: "mg-gk-room",
                  type: "button",
                  disabled: full,
                  onclick: () => joinRoom(item.addr, item.port),
                },
                MOYU.el("span", { class: "mg-gk-room-name", text: item.name || "局域网房间" }),
                MOYU.el("span", { class: "mg-gk-room-stat", text: full ? "已满" : `${item.players}/${item.cap}` }),
                MOYU.el("span", {
                  class: "mg-gk-room-sub",
                  text: `${item.host || "同事"} · ${item.addr}:${item.port} · ${Math.round((item.ageMs || 0) / 1000)} 秒前`,
                }),
                MOYU.el("span", { class: "mg-gk-room-stat", text: item.phase === "playing" ? "对局中" : "等待中" }),
              ),
            );
          }
        }

        const addrs = Array.isArray(latest.self?.addrs) ? latest.self.addrs.slice(0, ADDR_MAX) : [];
        addrLine.textContent = addrs.length
          ? `本机地址 ${addrs.join(" / ")} · 发现端口 ${latest.self?.discoveryPort || 39731}`
          : `没读到局域网地址（只有回环可用）· 发现端口 ${latest.self?.discoveryPort || 39731}`;

        MOYU.clear(lobbyDiag);
        const lines = [];
        if (latest.error) lines.push({ text: String(latest.error.message), level: "error" });
        lines.push({ text: `发现端口 ${latest.diag?.udp ?? "–"} · 房间通道 ${latest.diag?.tcp ?? "–"}`, level: "info" });
        for (const line of (latest.log || []).slice(-2)) lines.push(line);
        for (const line of lines) {
          lobbyDiag.append(MOYU.el("div", { class: line.level === "error" ? "error" : line.level === "warn" ? "warn" : "", text: line.text }));
        }
      }

      function renderRoom() {
        const state = match();
        const seat = mySeat();
        const phase = state?.phase || "waiting";
        undoBtn.disabled = phase !== "playing";
        resignBtn.disabled = phase !== "playing";
        rematchBtn.disabled = phase !== "over" || (Array.isArray(state?.rematch) && state.rematch.includes(seat));
        undoPrompt.hidden = !(state?.undo && Number(state.undo.by) !== seat);

        MOYU.clear(roomLog);
        const lines = [];
        if (latest.error) lines.push({ text: latest.error.message, level: "error" });
        // 传输层讲连接、规则层讲棋局，两边都摆出来
        for (const line of (latest.log || []).slice(-2)) lines.push(line);
        for (const line of (state?.log || []).slice(-6)) lines.push(line);
        for (const line of lines) {
          roomLog.append(
            MOYU.el("div", {
              class: line.level === "warn" ? "warn" : line.level === "error" ? "error" : line.level === "good" ? "good" : "",
              text: line.text,
            }),
          );
        }
      }

      /** 棋盘上的浮层：没房间时讲怎么开局，等人时给地址，结束了给结果。 */
      function renderOverlay(phase, seat) {
        const state = match();
        if (phase === "idle") {
          overlayBody.replaceChildren(
            MOYU.el("div", { class: "mg-panel-title", text: "还没有房间" }),
            MOYU.el("div", { class: "mg-panel-text", text: "同一局域网里两台机器各开一个面板就能下一盘。" }),
            MOYU.el("div", { class: "mg-panel-text", text: "自己开一间当房主，或者从下面的房间列表进同事那一间。" }),
          );
          overlay.hidden = false;
          return;
        }
        if (phase === "waiting") {
          const addrs = (latest.self?.addrs || []).slice(0, ADDR_MAX);
          const where = latest.self?.tcpPort ? `${addrs.join(" / ") || "127.0.0.1"}:${latest.self.tcpPort}` : "";
          overlayBody.replaceChildren(
            MOYU.el("div", { class: "mg-panel-title", text: "等人入座" }),
            MOYU.el("div", { class: "mg-panel-text", text: where ? `把这串发给同事：${where}` : "房间正在开端口…" }),
            MOYU.el("div", { class: "mg-panel-text", text: "让对方在「联机设置 → 手动加入」里填上，或直接从房间列表进。" }),
          );
          overlay.hidden = false;
          return;
        }
        if (phase !== "over") {
          overlay.hidden = true;
          return;
        }
        const outcome = state?.outcome || {};
        const rivalSeat = seat === 1 ? 2 : 1;
        let title = "本局结束";
        let text = "";
        if (outcome.type === "draw") {
          title = "平局";
          text = "棋盘满了，谁也没连成五子。";
        } else if (outcome.seat === seat) {
          title = "你赢了";
          text = outcome.type === "offline" ? "对方掉线，判你胜。" : outcome.type === "resign" ? "对方认输。" : "连成五子。";
        } else if (outcome.seat === rivalSeat) {
          title = "你输了";
          text = outcome.type === "offline" ? "你掉线了。" : outcome.type === "resign" ? "你认输了。" : "对方连成五子。";
        }
        const scoreText = `比分 ${state.score?.[seat] ?? 0} : ${state.score?.[rivalSeat] ?? 0} · 第 ${state.round} 局`;
        overlayBody.replaceChildren(
          MOYU.el("div", { class: "mg-panel-title", text: title }),
          MOYU.el("div", { class: "mg-panel-text", text }),
          MOYU.el("div", { class: "mg-panel-text", text: scoreText }),
          MOYU.el(
            "div",
            { class: "mg-panel-actions" },
            MOYU.el("button", {
              class: "mg-btn primary",
              type: "button",
              text: state.rematch?.includes(seat) ? "已点下一局" : "下一局",
              disabled: Boolean(state.rematch?.includes(seat)),
              onclick: () => act("rematch"),
            }),
            MOYU.el("button", { class: "mg-btn", type: "button", text: "退出房间", onclick: () => leaveRoom() }),
          ),
        );
        overlay.hidden = false;
      }

      // ── 棋盘绘制 ───────────────────────────────────────────────

      function sizeCanvas() {
        const width = board.clientWidth || 300;
        const height = board.clientHeight || 300;
        // 宽高都要看：只按宽度算，画布会把容器顶高，形成伸缩循环
        const side = Math.max(160, Math.min(width, height, 460));
        if (side !== metrics.size) {
          const ratio = window.devicePixelRatio || 1;
          canvas.style.width = `${side}px`;
          canvas.style.height = `${side}px`;
          canvas.width = Math.round(side * ratio);
          canvas.height = Math.round(side * ratio);
          canvas.getContext("2d").setTransform(ratio, 0, 0, ratio, 0, 0);
          metrics = { size: side, cell: side / SIZE };
        }
        draw();
      }

      function drawStone(context, x, y, seat) {
        const { cell } = metrics;
        const cx = (x + 0.5) * cell;
        const cy = (y + 0.5) * cell;
        const radius = cell * 0.42;
        context.beginPath();
        context.arc(cx, cy, radius, 0, Math.PI * 2);
        if (seat === 1) {
          context.fillStyle = colors.text;
          context.fill();
        } else {
          context.fillStyle = colors.surface;
          context.fill();
          context.strokeStyle = colors.text;
          context.lineWidth = 1.2;
          context.stroke();
        }
      }

      function draw() {
        if (canvas.hidden) return;
        const { size, cell } = metrics;
        const context = canvas.getContext("2d");
        context.clearRect(0, 0, size, size);
        context.fillStyle = colors.surface2;
        context.fillRect(0, 0, size, size);

        context.strokeStyle = colors.line;
        context.lineWidth = 1;
        for (let i = 0; i < SIZE; i += 1) {
          const at = Math.round((i + 0.5) * cell) + 0.5;
          context.beginPath();
          context.moveTo(Math.round(cell / 2) + 0.5, at);
          context.lineTo(Math.round(size - cell / 2) + 0.5, at);
          context.moveTo(at, Math.round(cell / 2) + 0.5);
          context.lineTo(at, Math.round(size - cell / 2) + 0.5);
          context.stroke();
        }
        context.fillStyle = colors.rule;
        for (const [sx, sy] of [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]]) {
          context.beginPath();
          context.arc((sx + 0.5) * cell, (sy + 0.5) * cell, Math.max(1.6, cell * 0.07), 0, Math.PI * 2);
          context.fill();
        }

        const state = match();
        const board = state?.board;
        if (typeof board === "string" && board.length === SIZE * SIZE) {
          for (let y = 0; y < SIZE; y += 1) {
            for (let x = 0; x < SIZE; x += 1) {
              const seat = Number(board.charAt(y * SIZE + x));
              if (seat === 1 || seat === 2) drawStone(context, x, y, seat);
            }
          }
        }

        const last = state?.lastMove;
        if (last && Number.isInteger(last.x)) {
          context.beginPath();
          context.arc((last.x + 0.5) * cell, (last.y + 0.5) * cell, Math.max(1.6, cell * 0.1), 0, Math.PI * 2);
          context.fillStyle = colors.bad;
          context.fill();
        }

        const line = state?.outcome?.line;
        if (Array.isArray(line)) {
          context.strokeStyle = colors.accent;
          context.lineWidth = Math.max(1.5, cell * 0.08);
          for (const point of line) {
            context.beginPath();
            context.arc((point.x + 0.5) * cell, (point.y + 0.5) * cell, cell * 0.44, 0, Math.PI * 2);
            context.stroke();
          }
        }

        if (canPlay()) {
          if (hover && stone(hover.x, hover.y) === "0") {
            context.globalAlpha = 0.35;
            drawStone(context, hover.x, hover.y, mySeat());
            context.globalAlpha = 1;
          }
          context.strokeStyle = colors.accent;
          context.lineWidth = 1.6;
          context.strokeRect(cursor.x * cell + 1, cursor.y * cell + 1, cell - 2, cell - 2);
        }
      }

      function pointerCell(event) {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width) return null;
        const scale = metrics.size / rect.width;
        const px = (event.clientX - rect.left) * scale;
        const py = (event.clientY - rect.top) * scale;
        const x = Math.floor(px / metrics.cell);
        const y = Math.floor(py / metrics.cell);
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return null;
        return { x, y };
      }

      // ── 成绩 ───────────────────────────────────────────────────

      /** 一局只记一次；同一局重复收到快照不会重复计数。 */
      function recordResult() {
        const state = match();
        if (!state || state.phase !== "over" || !state.outcome) return;
        const seat = mySeat();
        if (!seat) return;
        const key = `${latest.room?.id || "room"}:${state.round}`;
        if (recorded.has(key)) return;
        recorded.add(key);
        const rivalSeat = seat === 1 ? 2 : 1;
        if (state.outcome.type === "draw") ctx.store.bump(id, "draws");
        else if (state.outcome.seat === seat) ctx.store.bump(id, "wins");
        else if (state.outcome.seat === rivalSeat) ctx.store.bump(id, "losses");
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
          if (!closed) {
            bridgeDown(error);
          }
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

      const offKey = ctx.key((event) => {
        if (event.target instanceof Element && event.target.closest("input, textarea, select")) return;
        const state = match();
        if (!state) return;
        if (event.key === "ArrowUp") cursor = { x: cursor.x, y: Math.max(0, cursor.y - 1) };
        else if (event.key === "ArrowDown") cursor = { x: cursor.x, y: Math.min(SIZE - 1, cursor.y + 1) };
        else if (event.key === "ArrowLeft") cursor = { x: Math.max(0, cursor.x - 1), y: cursor.y };
        else if (event.key === "ArrowRight") cursor = { x: Math.min(SIZE - 1, cursor.x + 1), y: cursor.y };
        else if (event.key === "Enter" || event.key === " ") {
          if (!inRoom() || state.phase !== "playing") return;
          play(cursor.x, cursor.y);
        } else return;
        event.preventDefault();
        draw();
      });

      const onPointerDown = (event) => {
        const cell = pointerCell(event);
        if (!cell) return;
        cursor = cell;
        play(cell.x, cell.y);
        draw();
      };
      const onPointerMove = (event) => {
        if (!canPlay()) return;
        const cell = pointerCell(event);
        const changed = (hover?.x ?? -1) !== (cell?.x ?? -1) || (hover?.y ?? -1) !== (cell?.y ?? -1);
        hover = cell;
        if (changed) draw();
      };
      const onPointerLeave = () => {
        if (!hover) return;
        hover = null;
        draw();
      };

      nameInput.addEventListener("input", () => {
        nickname = nameInput.value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 24);
        ctx.store.set(id, "nickname", nickname);
        if (nameTimer) window.clearTimeout(nameTimer);
        nameTimer = window.setTimeout(() => {
          if (closed) return;
          // 只改名字不动对局，失败也无所谓
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

      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerleave", onPointerLeave);

      const offTheme = ctx.onThemeChange(() => {
        colors = readColors();
        draw();
      });

      const observer = new ResizeObserver(() => sizeCanvas());
      observer.observe(board);

      start();

      return () => {
        closed = true;
        if (nameTimer) window.clearTimeout(nameTimer);
        offKey();
        offTheme();
        observer.disconnect();
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerleave", onPointerLeave);
        // 离开这个界面就把房间和端口一起收掉（房主关掉即散桌）
        if (bridge) {
          bridge.invoke("lan.close", {}).catch(() => {});
        }
      };
    },

    /** 联机对局没有「重开」：重开要双方同意，一个按钮做不到。 */
    restart() {
      if (activeToast) activeToast("联机对局用「下一局」（需双方同意），或退出房间重来");
    },

    hubLine(entry) {
      const wins = Number(entry.wins) || 0;
      const losses = Number(entry.losses) || 0;
      const draws = Number(entry.draws) || 0;
      if (!wins && !losses && !draws) return "";
      return `联机 ${wins} 胜 · ${losses} 负${draws ? ` · ${draws} 平` : ""}`;
    },
  };
})();
