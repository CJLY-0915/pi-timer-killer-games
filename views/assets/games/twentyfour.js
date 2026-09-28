/**
 * 24 点 — 四张牌凑出 24
 *
 * 玩法：点两张牌 → 点一个运算符，两张牌合成一张（值用有理数精确算，÷ 不会掉进浮点误差）。
 * 合出来的牌在大字下面留一行算式小字（例如 8 底下写「3 + 5」），剩一张牌正好是 24 就赢。
 *
 * 出牌一定保证有解（生成时用同一个求解器验证）；当前局面接不下去会提示撤销。
 * 用了提示的那一步会带 flag，撤销它就把提示次数还回来，所以历史最短用时不虚。
 * 只写 7 个偏好键：mode / wins / best.easy / best.hard / saved.hand / saved.steps / saved.mode。
 */
(function () {
  "use strict";

  const MOYU = (window.MOYU = window.MOYU || {});
  MOYU.games = MOYU.games || {};

  const GAME_ID = "twentyfour";
  const TARGET = 24;
  const TILES = 4;
  const MAX_STEPS = TILES - 1;
  const START_PENALTY_MS = 30000; // 用了提示才赢，成绩按「真实用时 + 30 秒」计

  const MODES = {
    easy: { label: "1-9", max: 9 },
    hard: { label: "A-K", max: 13 },
  };
  const MODE_IDS = Object.keys(MODES);
  const DEFAULT_MODE = "easy";

  /** 扑克模式下的牌面：A / J / Q / K，其余用数字。 */
  const FACES = { 1: "A", 11: "J", 12: "Q", 13: "K" };

  // ── 纯逻辑：有理数 ──────────────────────────────────────────

  function gcd(a, b) {
    let x = Math.abs(a);
    let y = Math.abs(b);
    while (y) {
      const rest = x % y;
      x = y;
      y = rest;
    }
    return x || 1;
  }

  /** 规范化的有理数 [分子, 分母]，分母恒为正、约到最简。 */
  function rat(numerator, denominator) {
    let top = numerator;
    let bottom = denominator;
    if (bottom < 0) {
      top = -top;
      bottom = -bottom;
    }
    const divisor = gcd(top, bottom);
    return [top / divisor, bottom / divisor];
  }

  const isZero = (value) => value[0] === 0;
  const addRat = (a, b) => rat(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
  const subRat = (a, b) => rat(a[0] * b[1] - b[0] * a[1], a[1] * b[1]);
  const mulRat = (a, b) => rat(a[0] * b[0], a[1] * b[1]);
  const divRat = (a, b) => (isZero(b) ? null : rat(a[0] * b[1], a[1] * b[0]));

  function fmtRat(value) {
    return value[1] === 1 ? String(value[0]) : `${value[0]}/${value[1]}`;
  }

  function isTarget(value, target) {
    const goal = target === undefined ? TARGET : target;
    return value[0] === goal * value[1];
  }

  // ── 纯逻辑：合并与求解 ──────────────────────────────────────

  const OPS = [
    { label: "+", word: "加", apply: addRat },
    { label: "−", word: "减", apply: subRat },
    { label: "×", word: "乘", apply: mulRat },
    { label: "÷", word: "除", apply: divRat },
  ];

  /** 数字牌：v 是有理数，text 是「怎么算出来的」（原牌为空串）。 */
  function makeTile(value) {
    return { v: rat(value, 1), text: "" };
  }

  /**
   * 把第 i、j 张牌按第 op 号运算符合成一张，放在原 i 的位置（要求 i < j）。
   * swap 表示「先点的牌当右操作数」——减法和除法要认顺序，8÷3 和 3÷8 是两回事。
   * 除以 0 时返回 null，调用方负责提示。
   */
  function combine(list, i, j, op, swap) {
    if (!(i >= 0 && j > i && j < list.length) || !OPS[op]) return null;
    const left = swap ? list[j] : list[i];
    const right = swap ? list[i] : list[j];
    const value = OPS[op].apply(left.v, right.v);
    if (!value) return null;
    const side = (tile) => (tile.text ? `(${tile.text})` : fmtRat(tile.v));
    const next = list.slice();
    next.splice(j, 1);
    next.splice(i, 1, { v: value, text: `${side(left)} ${OPS[op].label} ${side(right)}` });
    return next;
  }

  /** 按一步 [{i,j,op,swap?}] 推进；任何一步非法就返回 null。 */
  function applyStep(list, step) {
    return combine(list, step.i, step.j, step.op, step.swap);
  }

  function replay(hand, steps) {
    let list = hand.map(makeTile);
    for (const step of steps) {
      list = applyStep(list, step);
      if (!list) return null;
    }
    return list;
  }

  /**
   * 穷举求解：返回一串「怎么合」的步骤，找不到就返回 null。
   * 4 张牌最多 24×12×4 个分支，随便算。
   */
  function solve(list, random) {
    if (list.length === 1) return isTarget(list[0].v) ? [] : null;
    const pairs = [];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) pairs.push([i, j]);
    }
    const ops = OPS.map((_, index) => index);
    if (typeof random === "function") {
      shuffle(pairs, random);
      shuffle(ops, random);
    }
    for (const [i, j] of pairs) {
      for (const op of ops) {
        for (const swap of [false, true]) {
          const next = combine(list, i, j, op, swap);
          if (!next) continue;
          const rest = solve(next, random);
          if (rest) return [{ i, j, op, swap }].concat(rest);
        }
      }
    }
    return null;
  }

  const hasSolution = (list) => solve(list) !== null;

  function shuffle(list, random) {
    for (let index = list.length - 1; index > 0; index -= 1) {
      const pick = Math.floor(random() * (index + 1));
      const temporary = list[index];
      list[index] = list[pick];
      list[pick] = temporary;
    }
    return list;
  }

  /** 保证有解的一手牌；连续碰不到就退回一手固定的有解牌。 */
  const FALLBACK_HAND = [4, 6, 6, 6];
  function generateHand(modeId, random = Math.random) {
    const max = (MODES[modeId] || MODES[DEFAULT_MODE]).max;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const hand = [];
      for (let index = 0; index < TILES; index += 1) hand.push(1 + Math.floor(random() * max));
      if (hasSolution(hand.map(makeTile))) return hand;
    }
    return FALLBACK_HAND.slice();
  }

  function serializeHand(hand) {
    return hand.join(" ");
  }

  function parseHand(text, modeId) {
    const max = (MODES[modeId] || MODES[DEFAULT_MODE]).max;
    const parts = String(text).trim().split(/\s+/).filter(Boolean);
    if (parts.length !== TILES) return null;
    const hand = [];
    for (const part of parts) {
      const value = Number(part);
      if (!Number.isInteger(value) || value < 1 || value > max) return null;
      hand.push(value);
    }
    return hand;
  }

  function serializeSteps(steps) {
    return steps.map((step) => `${step.i},${step.j},${step.op},${step.swap ? 1 : 0},${step.hint ? 1 : 0}`).join(";");
  }

  /** 步骤里带位置，所以要按牌数递减逐条校验，避免恢复出一盘错牌。 */
  function parseSteps(text) {
    const raw = String(text).trim();
    if (!raw) return [];
    const chunks = raw.split(";");
    if (chunks.length > MAX_STEPS) return null;
    const steps = [];
    let size = TILES;
    for (const chunk of chunks) {
      const parts = chunk.split(",").map(Number);
      if (parts.length !== 5 || parts.some((part) => !Number.isInteger(part))) return null;
      const [i, j, op, swap, hint] = parts;
      if (!(i >= 0 && i < j && j < size && op >= 0 && op < OPS.length)) return null;
      if (swap !== 0 && swap !== 1) return null;
      if (hint !== 0 && hint !== 1) return null;
      steps.push({ i, j, op, swap: swap === 1, hint: hint === 1 });
      size -= 1;
    }
    return steps;
  }

  function fmtTime(ms) {
    const total = Math.max(0, Math.floor(Number(ms) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  /** 扑克模式：牌面用 A/J/Q/K，同时把实际点数写在下面。 */
  function faceOf(value, modeId) {
    return modeId === "hard" ? FACES[value] || String(value) : String(value);
  }

  // ── 样式 ────────────────────────────────────────────────────

  MOYU.style(
    GAME_ID,
    `
    .mg-tf-wrap { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; width: 100%; }
    .mg-tf-bar { flex: none; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .mg-tf-note { flex: none; font-size: 11.5px; line-height: 1.35; color: var(--mg-warn); }
    .mg-tf-note[hidden] { display: none; }

    .mg-tf-hand { flex: 1 1 auto; min-height: 0; display: flex; flex-wrap: wrap; align-content: center; justify-content: center; gap: 8px; padding: 2px 0; }
    .mg-tf-tile {
      appearance: none;
      flex: 1 1 40%;
      min-height: 72px;
      display: grid;
      gap: 2px;
      place-content: center;
      justify-items: center;
      padding: 8px 6px;
      border: 1.5px solid var(--mg-line);
      border-radius: var(--mg-r-sm);
      background: var(--mg-surface);
      color: var(--mg-text);
      cursor: pointer;
    }
    .mg-tf-value { font: 700 28px/1 var(--mg-mono); }
    .mg-tf-from { font: 500 10.5px/1.2 var(--mg-mono); color: var(--mg-dim); }
    .mg-tf-tile.picked { border-color: var(--mg-accent); background: var(--mg-accent-soft); color: var(--mg-accent); }
    .mg-tf-tile.picked .mg-tf-from { color: var(--mg-accent); }
    .mg-tf-tile.alone { border-color: var(--mg-rule-ink); }
    .mg-tf-tile.bad { color: var(--mg-bad); }
    .mg-tf-tile:hover { border-color: var(--mg-rule-ink); }

    .mg-tf-ops { flex: none; display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .mg-tf-ops .mg-btn { justify-content: center; font: 600 17px/1 var(--mg-mono); padding: 8px 4px; }
    .mg-tf-tools { flex: none; display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
    .mg-tf-tools .mg-btn { justify-content: center; }
    `,
  );

  /** 顶栏「重开」拿到的回调：挂载时接管，卸载时交回。 */
  let requestNewRound = null;

  MOYU.games[GAME_ID] = {
    id: GAME_ID,
    name: "24 点",
    tagline: "四张牌凑出 24",
    emoji: "🃏",
    order: 8,

    mount(root, ctx) {
      const id = ctx.gameId;
      const storedMode = String(ctx.store.get(id, "mode", DEFAULT_MODE));
      let modeId = MODES[storedMode] ? storedMode : DEFAULT_MODE;

      let hand = [];
      let tiles = [];
      let picked = [];
      let steps = [];
      const hintCount = () => steps.filter((step) => step.hint).length;
      let started = false;
      let startedAt = 0;
      let elapsed = 0;
      let over = false;
      let timerHooked = false;

      // ── DOM ──────────────────────────────────────────────────
      const timeChip = MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: "用时" }), "0:00");
      const modeButtons = new Map();
      const modeSeg = MOYU.el(
        "div",
        { class: "mg-seg", role: "group", "aria-label": "牌面" },
        ...MODE_IDS.map((key) => {
          const button = MOYU.el("button", {
            type: "button",
            text: MODES[key].label,
            "aria-pressed": String(key === modeId),
            onclick: () => selectMode(key),
          });
          modeButtons.set(key, button);
          return button;
        }),
      );

      const opButtons = OPS.map((op, index) =>
        MOYU.el("button", {
          class: "mg-btn",
          type: "button",
          text: op.label,
          "aria-label": `${op.word}法`,
          onclick: () => merge(index),
        }),
      );
      const undoBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "撤销", onclick: () => undo() });
      const hintBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "提示", onclick: () => useHint() });

      const note = MOYU.el("div", { class: "mg-tf-note", hidden: true, role: "status" });
      const handBox = MOYU.el("div", { class: "mg-tf-hand" });

      const overlay = MOYU.el("div", { class: "mg-overlay", hidden: true });
      const overlayBody = MOYU.el("div", { class: "mg-panel" });
      overlay.append(overlayBody);

      const wrap = MOYU.el("div", { class: "mg-tf-wrap" });
      wrap.append(
        MOYU.el("div", { class: "mg-tf-bar" }, modeSeg, MOYU.el("div", { class: "mg-spacer" }), timeChip),
        note,
        handBox,
        MOYU.el("div", { class: "mg-tf-ops" }, ...opButtons),
        MOYU.el("div", { class: "mg-tf-tools" }, undoBtn, hintBtn),
        overlay,
      );
      root.append(wrap);

      // ── 局面 ─────────────────────────────────────────────────

      function startTimer() {
        started = true;
        startedAt = Date.now();
        elapsed = 0;
        if (timerHooked) return;
        timerHooked = true;
        ctx.interval(() => {
          if (!started || over) return;
          elapsed = Date.now() - startedAt;
          timeChip.lastChild.textContent = fmtTime(elapsed);
        }, 250);
      }

      function stopTimer() {
        if (started && !over) elapsed = Date.now() - startedAt;
        over = true;
      }

      function save() {
        ctx.store.set(id, "mode", modeId);
        ctx.store.set(id, "saved.mode", modeId);
        ctx.store.set(id, "saved.hand", serializeHand(hand));
        ctx.store.set(id, "saved.steps", serializeSteps(steps));
      }

      function clearSave() {
        ctx.store.set(id, "saved.mode", modeId);
        ctx.store.set(id, "saved.hand", "");
        ctx.store.set(id, "saved.steps", "");
      }

      function install(freshHand) {
        hand = freshHand.slice();
        tiles = hand.map(makeTile);
        steps = [];
        picked = [];
        started = false;
        over = false;
        elapsed = 0;
        timeChip.lastChild.textContent = "0:00";
        overlay.hidden = true;
        for (const [key, button] of modeButtons) {
          button.setAttribute("aria-pressed", String(key === modeId));
        }
        save();
        render();
      }

      function newRound(nextModeId) {
        if (nextModeId && MODES[nextModeId]) modeId = nextModeId;
        install(generateHand(modeId));
      }

      /** 读回上一局：牌与步骤都要自洽，否则当作没有。 */
      function restore() {
        const savedMode = String(ctx.store.get(id, "saved.mode", ""));
        const savedHand = parseHand(ctx.store.get(id, "saved.hand", ""), MODES[savedMode] ? savedMode : modeId);
        const savedSteps = parseSteps(ctx.store.get(id, "saved.steps", ""));
        if (!savedHand || !savedSteps) return false;
        const restored = replay(savedHand, savedSteps);
        if (!restored) return false;
        if (restored.length === 1) return false; // 已经是终局，不该再恢复
        if (MODES[savedMode]) modeId = savedMode;
        hand = savedHand;
        tiles = restored;
        steps = savedSteps;
        picked = [];
        started = false;
        over = false;
        elapsed = 0;
        timeChip.lastChild.textContent = "0:00";
        for (const [key, button] of modeButtons) {
          button.setAttribute("aria-pressed", String(key === modeId));
        }
        save();
        render();
        ctx.toast("接着上次的牌");
        return true;
      }

      // ── 操作 ─────────────────────────────────────────────────

      function selectMode(nextModeId) {
        if (!MODES[nextModeId] || nextModeId === modeId) return;
        newRound(nextModeId);
      }

      function togglePick(index) {
        if (over) return;
        const at = picked.indexOf(index);
        if (at >= 0) {
          picked.splice(at, 1);
          return;
        }
        if (picked.length >= 2) picked.shift();
        picked.push(index);
        render();
      }

      function clearPick() {
        if (!picked.length) return;
        picked = [];
        render();
      }

      function merge(opIndex) {
        if (over) return;
        if (picked.length < 2) {
          ctx.toast("先点两张牌");
          return;
        }
        const [i, j] = [...picked].sort((a, b) => a - b);
        const swap = picked[0] > picked[1]; // 先点的牌当左操作数
        const next = combine(tiles, i, j, opIndex, swap);
        if (!next) {
          ctx.toast("不能除以 0");
          return;
        }
        if (!started) startTimer();
        tiles = next;
        steps.push(swap ? { i, j, op: opIndex, swap: true } : { i, j, op: opIndex });
        picked = [];
        save();
        commit();
      }

      function undo() {
        const step = steps.pop();
        if (!step) {
          ctx.toast("没有可撤销的步骤");
          return;
        }
        const replayed = replay(hand, steps);
        if (!replayed) return;
        tiles = replayed;
        picked = [];
        over = false;
        overlay.hidden = true;
        save();
        render();
      }

      /** 提示：按求解器给的第一步走一手，代价是成绩加 30 秒。 */
      function useHint() {
        if (over) return;
        const plan = solve(tiles);
        if (!plan || !plan.length) {
          ctx.toast(hasSolution(tiles) ? "已经没有要算的步骤" : "这盘接不下去了，撤销一步吧");
          return;
        }
        const step = plan[0];
        const before = tiles;
        if (!started) startTimer();
        tiles = combine(tiles, step.i, step.j, step.op, step.swap);
        steps.push({ ...step, hint: true });
        picked = [];
        save();
        commit();
        ctx.toast(`提示：先算 ${fmtRat(before[step.i].v)} ${OPS[step.op].label} ${fmtRat(before[step.j].v)}`);
      }

      /** lines 是结算面板上的正文行：先说算式，再说成绩。 */
      function showOverlay(title, lines, actions) {
        overlayBody.replaceChildren(
          MOYU.el("div", { class: "mg-panel-title", text: title }),
          ...lines.map((line) => MOYU.el("div", { class: "mg-panel-text", text: line })),
          MOYU.el("div", { class: "mg-panel-actions" }, ...actions),
        );
        overlay.hidden = false;
      }

      function finishMiss() {
        const value = tiles[0] ? tiles[0].v : null;
        showOverlay(
          "差一点",
          [`${tiles[0] ? tiles[0].text || fmtRat(tiles[0].v) : "?"} = ${value ? fmtRat(value) : "?"}，不是 24`],
          [
            MOYU.el("button", { class: "mg-btn", type: "button", text: "撤销一步", onclick: () => undo() }),
            MOYU.el("button", { class: "mg-btn primary", type: "button", text: "换一局", onclick: () => newRound() }),
          ],
        );
      }

      function checkEnd() {
        if (over) return;
        if (tiles.length === 1 && isTarget(tiles[0].v)) {
          stopTimer();
          timeChip.lastChild.textContent = fmtTime(elapsed);
          const score = elapsed + hintCount() * START_PENALTY_MS;
          const key = `best.${modeId}`;
          const previous = Number(ctx.store.get(id, key, 0)) || 0;
          const broke = previous === 0 || score < previous;
          if (broke) ctx.store.set(id, key, score);
          ctx.store.bump(id, "wins");
          clearSave();
          render();
          showOverlay(
            broke ? "新纪录！" : "凑出 24",
            [
              `${tiles[0].text || fmtRat(tiles[0].v)} = 24`,
              `用时 ${fmtTime(elapsed)}${hintCount() > 0 ? ` · 提示 ${hintCount()} 次` : ""} · ${MODES[modeId].label}${
                broke ? "" : ` · 历史最佳 ${fmtTime(previous)}`
              }`,
            ],
            [
              MOYU.el("button", { class: "mg-btn primary", type: "button", text: "再来一局", onclick: () => newRound() }),
              MOYU.el("button", { class: "mg-btn", type: "button", text: "看看牌面", onclick: () => { overlay.hidden = true; } }),
            ],
          );
          return;
        }
        if (tiles.length === 1) {
          stopTimer();
          render();
          finishMiss();
        }
      }

      // ── 渲染 ─────────────────────────────────────────────────

      function render() {
        const reached = tiles.length === 1;
        const stuck = !reached && !hasSolution(tiles);
        const value = tiles.length === 1 ? tiles[0].v : null;

        handBox.replaceChildren(
          ...tiles.map((tile, index) =>
            MOYU.el(
              "button",
              {
                class: `mg-tf-tile${picked.includes(index) ? " picked" : ""}${reached ? " alone" : ""}${
                  value && !isTarget(value) ? " bad" : ""
                }`,
                type: "button",
                "aria-pressed": String(picked.includes(index)),
                "aria-label": `第 ${index + 1} 张 ${fmtRat(tile.v)}${tile.text ? `，来自 ${tile.text}` : ""}`,
                onclick: () => togglePick(index),
              },
              MOYU.el("span", { class: "mg-tf-value", text: faceOf(tile.v[1] === 1 ? tile.v[0] : fmtRat(tile.v), modeId) }),
              MOYU.el("span", {
                class: "mg-tf-from",
                text: tile.text || (modeId === "hard" && tile.v[1] === 1 ? fmtRat(tile.v) : ""),
              }),
            ),
          ),
        );

        note.hidden = !stuck;
        note.textContent = stuck ? "这几张牌接不到 24 了，撤销一步试试" : "";
        for (const button of opButtons) button.disabled = reached;
        undoBtn.disabled = steps.length === 0;
        hintBtn.disabled = reached || stuck;
      }

      function commit() {
        render();
        checkEnd();
      }

      // ── 键盘 ─────────────────────────────────────────────────

      const offKey = ctx.key((event) => {
        if (event.ctrlKey || event.metaKey) {
          if (event.key === "z" || event.key === "Z") {
            event.preventDefault();
            undo();
          }
          return;
        }
        const key = event.key;
        if (key >= "1" && key <= "4") {
          event.preventDefault();
          togglePick(Number(key) - 1);
          return;
        }
        const opIndex = { "+": 0, "-": 1, "*": 2, "x": 2, "/": 3 }[key];
        if (opIndex !== undefined) {
          event.preventDefault();
          merge(opIndex);
          return;
        }
        if (key === "0" || key === "Backspace" || key === "Escape" || key === "Delete") {
          event.preventDefault();
          clearPick();
          return;
        }
        if (key === "h" || key === "H") {
          event.preventDefault();
          useHint();
        }
      });

      requestNewRound = () => newRound();

      if (!restore()) install(generateHand(modeId));

      return () => {
        requestNewRound = null;
        offKey();
      };
    },

    restart() {
      if (typeof requestNewRound === "function") requestNewRound();
    },

    hubLine(entry) {
      const source = entry && typeof entry === "object" ? entry : {};
      const wins = Math.max(0, Math.floor(Number(source.wins) || 0));
      if (wins <= 0) return "";
      const modeId = MODES[String(source.mode)] ? String(source.mode) : DEFAULT_MODE;
      const best = Math.max(0, Math.floor(Number(source[`best.${modeId}`]) || 0));
      return best > 0 ? `${wins} 局 · ${MODES[modeId].label} ${fmtTime(best)}` : `${wins} 局`;
    },

    _logic: {
      MODES,
      MODE_IDS,
      TILES,
      TARGET,
      OPS,
      FACES,
      rat,
      fmtRat,
      isTarget,
      addRat,
      subRat,
      mulRat,
      divRat,
      makeTile,
      combine,
      applyStep,
      replay,
      solve,
      hasSolution,
      generateHand,
      serializeHand,
      parseHand,
      serializeSteps,
      parseSteps,
      faceOf,
      fmtTime,
    },
  };
})();
