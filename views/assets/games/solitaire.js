/**
 * 纸牌接龙 — 经典 Klondike（DOM 方案）
 *
 * 七列 tableau + 四门 foundation + stock/waste。规则判定为纯函数并挂到 _logic 便于自测。
 * 列高溢出时按列动态压缩扇形 offset（不做内部滚动），保证最高列也放进右侧窄面板。
 */
(function () {
  "use strict";
  const MOYU = (window.MOYU = window.MOYU || {});
  MOYU.games = MOYU.games || {};

  // ── 常量与纯规则函数 ─────────────────────────────────────────

  const SUITS = ["s", "h", "c", "d"]; // 黑桃 红桃 梅花 方块
  const RED = new Set(["h", "d"]);
  const SUIT_SYMBOL = { s: "♠", h: "♥", c: "♣", d: "♦" };
  const COL_GAP = 5;
  const BOARD_GAP = 8;
  const UNDO_LIMIT = 50;
  const AUTO_MS = 60;
  const DRAG_THRESHOLD = 5;
  const DOUBLE_MS = 320;

  function isRed(card) {
    return RED.has(card.suit);
  }

  function rankLabel(rank) {
    if (rank === 1) return "A";
    if (rank === 11) return "J";
    if (rank === 12) return "Q";
    if (rank === 13) return "K";
    return String(rank);
  }

  /** tableau：递减且红黑交替；空列只收 K。 */
  function canStackTableau(card, target) {
    if (!card) return false;
    if (!target) return card.rank === 13;
    return card.rank === target.rank - 1 && isRed(card) !== isRed(target);
  }

  /** foundation：同花色升序，从 A 起。 */
  function canStackFoundation(card, top) {
    if (!card) return false;
    if (!top) return card.rank === 1;
    return card.rank === top.rank + 1 && card.suit === top.suit;
  }

  /** 从 column[fromIndex] 起（含）向上截出可整组移动的正面牌 run。 */
  function findMovableRun(column, fromIndex) {
    if (fromIndex < 0 || fromIndex >= column.length) return [];
    const first = column[fromIndex];
    if (!first.faceUp) return [];
    const run = [first];
    for (let i = fromIndex + 1; i < column.length; i += 1) {
      const prev = column[i - 1];
      const next = column[i];
      if (!next.faceUp) break;
      if (next.rank !== prev.rank - 1) break;
      if (isRed(next) === isRed(prev)) break;
      run.push(next);
    }
    return run;
  }

  function isWon(foundations) {
    return foundations.every((pile) => pile.length === 13);
  }

  function createDeck() {
    const deck = [];
    for (const suit of SUITS) {
      for (let rank = 1; rank <= 13; rank += 1) {
        deck.push({ id: suit + rank, suit, rank, faceUp: false });
      }
    }
    return deck;
  }

  function shuffle(deck, rng) {
    const rand = rng || Math.random;
    for (let i = deck.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = deck[i];
      deck[i] = deck[j];
      deck[j] = tmp;
    }
    return deck;
  }

  /** 发牌：第 i 列 i+1 张，仅末张正面；余下 24 张进 stock。 */
  function deal(rng) {
    const deck = shuffle(createDeck(), rng);
    const tableau = [[], [], [], [], [], [], []];
    let cursor = 0;
    for (let col = 0; col < 7; col += 1) {
      for (let k = 0; k <= col; k += 1) {
        tableau[col].push(deck[cursor]);
        cursor += 1;
      }
      tableau[col][tableau[col].length - 1].faceUp = true;
    }
    return { tableau, foundations: [[], [], [], []], stock: deck.slice(cursor), waste: [] };
  }

  /** 从 stock 顶（数组末）发最多 count 张到 waste，返回实发张数。 */
  function drawFromStock(state, count) {
    let drawn = 0;
    for (let i = 0; i < count && state.stock.length > 0; i += 1) {
      const card = state.stock.pop();
      card.faceUp = true;
      state.waste.push(card);
      drawn += 1;
    }
    return drawn;
  }

  /** 回收 waste 回 stock：pop waste→push stock 并翻背，顺序与原牌序一致。 */
  function recycleWaste(state) {
    while (state.waste.length > 0) {
      const card = state.waste.pop();
      card.faceUp = false;
      state.stock.push(card);
    }
  }

  function cloneCard(card) {
    return { id: card.id, suit: card.suit, rank: card.rank, faceUp: card.faceUp };
  }

  function cloneState(state) {
    return {
      tableau: state.tableau.map((col) => col.map(cloneCard)),
      foundations: state.foundations.map((pile) => pile.map(cloneCard)),
      stock: state.stock.map(cloneCard),
      waste: state.waste.map(cloneCard),
    };
  }

  function formatTime(ms) {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  const logic = {
    isRed,
    rankLabel,
    canStackTableau,
    canStackFoundation,
    findMovableRun,
    isWon,
    createDeck,
    shuffle,
    deal,
    drawFromStock,
    recycleWaste,
    cloneCard,
    cloneState,
    formatTime,
  };

  MOYU.style(
    "solitaire",
    `
    html[data-theme="dark"] {
      --mg-sol-face: #232a35;
      --mg-sol-red: #ff7b7b;
      --mg-sol-black: #e8ebf0;
      --mg-sol-back-a: #314257;
      --mg-sol-back-b: #243244;
    }
    html[data-theme="light"] {
      --mg-sol-face: #ffffff;
      --mg-sol-red: #cc3a38;
      --mg-sol-black: #17202b;
      --mg-sol-back-a: #cbd5e1;
      --mg-sol-back-b: #aebdd0;
    }
    .mg-sol-board {
      flex: 1 1 auto;
      min-height: 0;
      position: relative;
      display: flex;
      flex-direction: column;
      gap: ${BOARD_GAP}px;
      --cardW: 44px;
      --cardH: 62px;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
    }
    .mg-sol-top,
    .mg-sol-tableau {
      display: grid;
      grid-template-columns: repeat(7, var(--cardW));
      gap: ${COL_GAP}px;
      justify-content: center;
      width: 100%;
    }
    .mg-sol-top { flex: none; }
    .mg-sol-tableau { flex: 1 1 auto; min-height: 0; align-items: start; }
    .mg-sol-gap { width: var(--cardW); height: var(--cardH); }
    .mg-sol-col { position: relative; width: var(--cardW); }
    .mg-sol-slot {
      position: relative;
      width: var(--cardW);
      height: var(--cardH);
      border: 1px dashed var(--mg-line);
      border-radius: var(--mg-r-sm);
      display: grid;
      place-items: center;
      color: var(--mg-dim);
      font-size: calc(var(--cardW) * 0.42);
    }
    .mg-sol-ph-col {
      position: absolute;
      inset: 0;
      border: 1px dashed var(--mg-line);
      border-radius: var(--mg-r-sm);
    }
    .mg-sol-ph { opacity: 0.5; pointer-events: none; }
    .mg-sol-card {
      position: absolute;
      left: 0;
      top: 0;
      width: var(--cardW);
      height: var(--cardH);
      box-sizing: border-box;
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-sm);
      background: var(--mg-sol-face);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
      display: flex;
      align-items: flex-start;
      justify-content: flex-start;
      padding: 2px 3px;
      font: 700 calc(var(--cardW) * 0.34) / 1.1 var(--mg-font);
      cursor: grab;
    }
    .mg-sol-face.mg-sol-red { color: var(--mg-sol-red); }
    .mg-sol-face.mg-sol-black { color: var(--mg-sol-black); }
    .mg-sol-back {
      border-color: var(--mg-line);
      background-image:
        radial-gradient(circle at center, var(--mg-sol-back-b) 1.5px, transparent 2px),
        repeating-linear-gradient(45deg, var(--mg-sol-back-a) 0 5px, var(--mg-sol-back-b) 5px 10px);
      background-size: 10px 10px, auto;
      cursor: pointer;
    }
    .mg-sol-sel { box-shadow: 0 0 0 2px var(--mg-accent); z-index: 3; }
    .mg-sol-target { outline: 2px solid var(--mg-accent); outline-offset: 1px; }
    .mg-sol-ghost { visibility: hidden; }
    .mg-sol-flip { animation: mg-sol-flip 0.2s ease-out; }
    @keyframes mg-sol-flip {
      from { transform: scale(0.55); opacity: 0.3; }
      to { transform: scale(1); opacity: 1; }
    }
    .mg-sol-float { position: fixed; z-index: 50; pointer-events: none; }
    .mg-sol-float .mg-sol-card { box-shadow: var(--mg-shadow); cursor: grabbing; }
    .mg-sol-lift { filter: brightness(1.04); }
    .mg-sol-drop-ok { outline: 2px solid var(--mg-accent); outline-offset: 1px; }
    .mg-sol-drop-bad { outline: 2px solid var(--mg-bad); outline-offset: 1px; }
    `,
  );

  MOYU.games.solitaire = {
    id: "solitaire",
    name: "纸牌接龙",
    tagline: "七列收齐四门花色",
    emoji: "🃏",
    order: 3,

    mount(root, ctx) {
      const id = ctx.gameId;
      const initialDraw = Number(ctx.store.get(id, "draw", 1)) === 3 ? 3 : 1;

      let state = deal();
      let undoStack = [];
      let selection = null;
      let pointer = null;
      let lastTap = null;
      let lastFlippedId = null;
      let moves = 0;
      let won = false;
      let drawCount = initialDraw;
      let startedAt = 0;
      let timerRunning = false;
      let timerId = 0;
      let autoTimer = 0;
      let autoRunning = false;
      let cardW = 44;
      let cardH = 62;
      let faceOffset = 12;
      let backOffset = 6;
      let maxSpan = 0;

      // ── 顶栏与骨架 ────────────────────────────────────────
      const movesChip = MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: "步数" }), "0");
      const timeChip = MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: "用时" }), "0:00");
      const undoBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "撤销", onclick: () => { cancelAuto(); undo(); } });
      const autoBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "自动完成", hidden: true, onclick: () => startAutoComplete() });

      const drawButtons = new Map();
      const diffSeg = MOYU.el(
        "div",
        { class: "mg-seg", role: "group", "aria-label": "发牌模式" },
        ...[1, 3].map((n) => {
          const b = MOYU.el("button", { type: "button", text: `翻 ${n}`, "aria-pressed": String(n === drawCount), onclick: () => setDraw(n) });
          drawButtons.set(String(n), b);
          return b;
        }),
      );

      const bar = MOYU.el(
        "div",
        { class: "mg-game-bar" },
        MOYU.el("div", { class: "mg-chips" }, movesChip, timeChip),
        MOYU.el("div", { class: "mg-spacer" }),
        undoBtn,
        autoBtn,
        diffSeg,
      );

      const topRow = MOYU.el("div", { class: "mg-sol-top" });
      const tableauRow = MOYU.el("div", { class: "mg-sol-tableau" });
      const overlay = MOYU.el("div", { class: "mg-overlay", hidden: true });
      const overlayBody = MOYU.el("div", { class: "mg-panel" });
      overlay.append(overlayBody);
      const board = MOYU.el("div", { class: "mg-sol-board" }, topRow, tableauRow, overlay);

      const help = MOYU.el("div", {
        class: "mg-help",
        text: "点击选牌再点目标移动，或直接拖拽；双击把牌自动送进上方回收堆。数列需递减且红黑交替，空列只收 K。",
      });

      root.append(bar, board, help);
      board.addEventListener("contextmenu", (event) => event.preventDefault());

      // ── 查询辅助 ──────────────────────────────────────────
      function topOf(col) {
        const column = state.tableau[col];
        return column.length ? column[column.length - 1] : null;
      }
      function foundTop(idx) {
        const pile = state.foundations[idx];
        return pile.length ? pile[pile.length - 1] : null;
      }
      function isSelected(card) {
        return !!selection && selection.cards.some((c) => c.id === card.id);
      }
      function isValidTableauTarget(col) {
        if (!selection) return false;
        if (selection.kind === "tableau" && selection.col === col) return false;
        return canStackTableau(selection.cards[0], topOf(col));
      }
      function isValidFoundationTarget(idx) {
        if (!selection || selection.kind === "foundation") return false;
        if (selection.kind === "tableau" && selection.cards.length !== 1) return false;
        return canStackFoundation(selection.cards[0], foundTop(idx));
      }

      // ── 状态变更 ──────────────────────────────────────────
      function pushUndo() {
        undoStack.push(cloneState(state));
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      }

      function flipExposed(col) {
        const column = state.tableau[col];
        const top = column[column.length - 1];
        if (top && !top.faceUp) {
          top.faceUp = true;
          lastFlippedId = top.id;
        }
      }

      function applyMove(move) {
        switch (move.type) {
          case "t2t": {
            const run = state.tableau[move.from].splice(move.index);
            state.tableau[move.to].push(...run);
            flipExposed(move.from);
            break;
          }
          case "w2t":
            state.tableau[move.to].push(state.waste.pop());
            break;
          case "w2f":
            state.foundations[move.to].push(state.waste.pop());
            break;
          case "f2t":
            state.tableau[move.to].push(state.foundations[move.from].pop());
            break;
          // t2f 由 performMove 单独处理（需先取出牌再翻开暴露牌）
          default:
            break;
        }
      }

      // t2f 需要先取出牌再翻开，单独实现避免上面占位逻辑
      function performMove(move) {
        pushUndo();
        if (move.type === "t2f") {
          const card = state.tableau[move.from].pop();
          state.foundations[move.to].push(card);
          flipExposed(move.from);
        } else {
          applyMove(move);
        }
        moves += 1;
        selection = null;
        startTimerIfNeeded();
        afterChange();
      }

      function afterChange() {
        movesChip.lastChild.textContent = String(moves);
        render();
        if (!won) checkWin();
        refreshUndoButton();
        refreshAutoButton();
      }

      function undo() {
        if (won) return;
        const prev = undoStack.pop();
        if (!prev) return;
        state = prev;
        selection = null;
        afterChange();
      }

      function onStockActivate() {
        selection = null;
        if (state.stock.length > 0) {
          pushUndo();
          drawFromStock(state, drawCount);
        } else if (state.waste.length > 0) {
          pushUndo();
          recycleWaste(state);
        } else {
          return;
        }
        startTimerIfNeeded();
        afterChange();
      }

      // ── 点击选中 / 点击目标 ───────────────────────────────
      function selectTableauRun(col, pos) {
        const run = findMovableRun(state.tableau[col], pos);
        if (!run.length) {
          clearSelection();
          return;
        }
        selection = { kind: "tableau", col, pos, cards: run };
        render();
      }
      function selectWaste() {
        const top = state.waste[state.waste.length - 1];
        if (!top) {
          clearSelection();
          return;
        }
        selection = { kind: "waste", cards: [top] };
        render();
      }
      function selectFoundation(idx) {
        const top = foundTop(idx);
        if (!top) {
          clearSelection();
          return;
        }
        selection = { kind: "foundation", idx, cards: [top] };
        render();
      }
      function clearSelection() {
        if (!selection) return;
        selection = null;
        render();
      }

      function tryMoveSelectionToTableau(col) {
        const sel = selection;
        const top = topOf(col);
        if (sel.kind === "tableau") {
          if (sel.col === col) return false;
          if (canStackTableau(sel.cards[0], top)) {
            performMove({ type: "t2t", from: sel.col, index: sel.pos, to: col });
            return true;
          }
          return false;
        }
        if (sel.kind === "waste") {
          if (canStackTableau(sel.cards[0], top)) {
            performMove({ type: "w2t", to: col });
            return true;
          }
          return false;
        }
        if (sel.kind === "foundation") {
          if (canStackTableau(sel.cards[0], top)) {
            performMove({ type: "f2t", from: sel.idx, to: col });
            return true;
          }
          return false;
        }
        return false;
      }

      function tryMoveSelectionToFoundation(idx) {
        const sel = selection;
        const top = foundTop(idx);
        if (sel.kind === "foundation") return false;
        if (sel.kind === "tableau") {
          if (sel.cards.length !== 1) return false;
          if (canStackFoundation(sel.cards[0], top)) {
            performMove({ type: "t2f", from: sel.col, to: idx });
            return true;
          }
          return false;
        }
        if (canStackFoundation(sel.cards[0], top)) {
          performMove({ type: "w2f", to: idx });
          return true;
        }
        return false;
      }

      function tapTableauCard(col, pos) {
        const column = state.tableau[col];
        if (pos < 0 || pos >= column.length) {
          if (selection && tryMoveSelectionToTableau(col)) return;
          clearSelection();
          return;
        }
        if (!column[pos].faceUp) {
          clearSelection();
          return;
        }
        if (selection && tryMoveSelectionToTableau(col)) return;
        selectTableauRun(col, pos);
      }

      function tapFoundation(idx, empty) {
        if (selection && tryMoveSelectionToFoundation(idx)) return;
        if (empty) {
          clearSelection();
          return;
        }
        selectFoundation(idx);
      }

      function handleSingle(loc) {
        cancelAuto();
        if (loc.kind === "stock") onStockActivate();
        else if (loc.kind === "waste") selectWaste();
        else if (loc.kind === "waste-empty") clearSelection();
        else if (loc.kind === "foundation") tapFoundation(loc.idx, loc.empty);
        else if (loc.kind === "tableau") tapTableauCard(loc.col, loc.pos);
        else clearSelection();
      }

      function handleDouble(loc) {
        cancelAuto();
        let card = null;
        let from = null;
        if (loc.kind === "tableau") {
          const column = state.tableau[loc.col];
          if (loc.pos !== column.length - 1) return;
          card = column[loc.pos];
          from = loc.col;
        } else if (loc.kind === "waste") {
          card = state.waste[state.waste.length - 1];
          if (!card) return;
        } else {
          return;
        }
        for (let f = 0; f < 4; f += 1) {
          if (canStackFoundation(card, foundTop(f))) {
            if (from !== null) performMove({ type: "t2f", from, to: f });
            else performMove({ type: "w2f", to: f });
            return;
          }
        }
      }

      function locKey(loc) {
        if (loc.kind === "tableau") return `t${loc.col}:${loc.pos}`;
        if (loc.kind === "waste") return "w";
        if (loc.kind === "foundation") return `f${loc.idx}`;
        return loc.kind;
      }

      function handleTap(loc) {
        const now = Date.now();
        if (lastTap && lastTap.key === locKey(loc) && now - lastTap.time < DOUBLE_MS) {
          lastTap = null;
          handleDouble(loc);
          return;
        }
        lastTap = { key: locKey(loc), time: now };
        handleSingle(loc);
      }

      // ── 拖拽 ──────────────────────────────────────────────
      function isPrimary(event) {
        return event.pointerType !== "mouse" || event.button === 0;
      }

      function cardElsFor(col, pos, count) {
        const colEl = tableauRow.children[col];
        if (!colEl) return [];
        const els = [];
        for (let p = pos; p < pos + count; p += 1) {
          const el = colEl.querySelector(`.mg-sol-card[data-pos="${p}"]`);
          if (el) els.push(el);
        }
        return els;
      }

      function getMovableAt(loc) {
        if (loc.kind === "tableau") {
          const column = state.tableau[loc.col];
          const card = column[loc.pos];
          if (!card || !card.faceUp) return null;
          const run = findMovableRun(column, loc.pos);
          if (!run.length) return null;
          return { cards: run, els: cardElsFor(loc.col, loc.pos, run.length) };
        }
        if (loc.kind === "waste") {
          const top = state.waste[state.waste.length - 1];
          if (!top) return null;
          const el = board.querySelector('[data-slot="waste"] .mg-sol-card');
          return { cards: [top], els: el ? [el] : [] };
        }
        if (loc.kind === "foundation") {
          const top = foundTop(loc.idx);
          if (!top) return null;
          const el = board.querySelector(`[data-slot="f"][data-index="${loc.idx}"] .mg-sol-card`);
          return { cards: [top], els: el ? [el] : [] };
        }
        return null;
      }

      function beginPointer(event, loc, movable) {
        if (pointer) return;
        if (!isPrimary(event)) return;
        pointer = {
          loc,
          movable,
          startX: event.clientX,
          startY: event.clientY,
          pointerId: event.pointerId,
          dragging: false,
          floatEl: null,
          grabX: 0,
          grabY: 0,
        };
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerCancel);
      }

      function removePointerListeners() {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
      }

      function onPointerMove(event) {
        if (!pointer || event.pointerId !== pointer.pointerId) return;
        const dx = event.clientX - pointer.startX;
        const dy = event.clientY - pointer.startY;
        if (!pointer.dragging) {
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
          if (!pointer.movable) return;
          startDrag(event);
        }
        moveDrag(event);
      }

      function onPointerUp(event) {
        if (!pointer || event.pointerId !== pointer.pointerId) return;
        removePointerListeners();
        if (pointer.dragging) finishDrag(event);
        else handleTap(pointer.loc);
        pointer = null;
      }

      function onPointerCancel(event) {
        if (!pointer || event.pointerId !== pointer.pointerId) return;
        removePointerListeners();
        if (pointer.dragging) cancelDrag();
        pointer = null;
      }

      function positionFloat(x, y) {
        const el = pointer.floatEl;
        if (!el) return;
        el.style.left = `${x - pointer.grabX}px`;
        el.style.top = `${y - pointer.grabY}px`;
      }

      function startDrag(event) {
        const movable = pointer.movable;
        const run = movable.cards;
        const span = (run.length - 1) * faceOffset;
        const floatEl = MOYU.el("div", {
          class: "mg-sol-float",
          style: { width: `${cardW}px`, height: `${span + cardH}px` },
        });
        for (let i = 0; i < run.length; i += 1) {
          const card = run[i];
          floatEl.append(
            MOYU.el("div", {
              class: "mg-sol-card mg-sol-face mg-sol-lift " + (isRed(card) ? "mg-sol-red" : "mg-sol-black"),
              text: rankLabel(card.rank) + SUIT_SYMBOL[card.suit],
              style: { top: `${(run.length - 1 - i) * faceOffset}px` },
            }),
          );
        }
        board.append(floatEl);
        pointer.floatEl = floatEl;
        pointer.dragging = true;
        pointer.grabX = cardW / 2;
        pointer.grabY = span + cardH / 2;
        selection = null;
        for (const el of board.querySelectorAll(".mg-sol-sel, .mg-sol-target")) {
          el.classList.remove("mg-sol-sel", "mg-sol-target");
        }
        for (const el of movable.els) el.classList.add("mg-sol-ghost");
        positionFloat(event.clientX, event.clientY);
      }

      function moveDrag(event) {
        positionFloat(event.clientX, event.clientY);
        clearDropHint();
        const target = findDropTarget(event.clientX, event.clientY);
        if (!target) return;
        const ok = canDrop(pointer.loc, pointer.movable.cards, target);
        const slotEl = slotElementFor(target);
        if (slotEl) slotEl.classList.add(ok ? "mg-sol-drop-ok" : "mg-sol-drop-bad");
      }

      function removeFloat() {
        if (pointer && pointer.floatEl) {
          pointer.floatEl.remove();
          pointer.floatEl = null;
        }
      }

      function finishDrag(event) {
        const loc = pointer.loc;
        const cards = pointer.movable.cards;
        const target = findDropTarget(event.clientX, event.clientY);
        removeFloat();
        clearDropHint();
        cancelAuto();
        if (target && canDrop(loc, cards, target)) {
          doDrop(loc, cards, target);
        } else {
          selection = null;
          render();
        }
      }

      function cancelDrag() {
        removeFloat();
        clearDropHint();
        render();
      }

      function clearDropHint() {
        for (const el of board.querySelectorAll(".mg-sol-drop-ok, .mg-sol-drop-bad")) {
          el.classList.remove("mg-sol-drop-ok", "mg-sol-drop-bad");
        }
      }

      function findDropTarget(x, y) {
        const el = document.elementFromPoint(x, y);
        if (!el || !el.closest) return null;
        const slot = el.closest("[data-slot]");
        if (!slot) return null;
        const kind = slot.dataset.slot;
        if (kind === "t") return { kind: "tableau", col: Number(slot.dataset.index) };
        if (kind === "f") return { kind: "foundation", idx: Number(slot.dataset.index) };
        return null;
      }

      function slotElementFor(target) {
        if (target.kind === "tableau") return tableauRow.children[target.col] || null;
        return topRow.querySelector(`[data-slot="f"][data-index="${target.idx}"]`);
      }

      function canDrop(loc, cards, target) {
        if (loc.kind === "tableau") {
          if (target.kind === "tableau") {
            if (target.col === loc.col) return false;
            return canStackTableau(cards[0], topOf(target.col));
          }
          if (target.kind === "foundation") {
            return cards.length === 1 && canStackFoundation(cards[0], foundTop(target.idx));
          }
          return false;
        }
        if (loc.kind === "waste") {
          if (target.kind === "tableau") return canStackTableau(cards[0], topOf(target.col));
          if (target.kind === "foundation") return canStackFoundation(cards[0], foundTop(target.idx));
          return false;
        }
        if (loc.kind === "foundation") {
          if (target.kind === "tableau") return canStackTableau(cards[0], topOf(target.col));
          return false;
        }
        return false;
      }

      function doDrop(loc, cards, target) {
        if (loc.kind === "tableau") {
          if (target.kind === "tableau") performMove({ type: "t2t", from: loc.col, index: loc.pos, to: target.col });
          else performMove({ type: "t2f", from: loc.col, to: target.idx });
        } else if (loc.kind === "waste") {
          if (target.kind === "tableau") performMove({ type: "w2t", to: target.col });
          else performMove({ type: "w2f", to: target.idx });
        } else if (loc.kind === "foundation") {
          performMove({ type: "f2t", from: loc.idx, to: target.col });
        }
      }

      // ── 自动完成 ──────────────────────────────────────────
      function canAutoComplete() {
        if (state.stock.length || state.waste.length) return false;
        for (const col of state.tableau) {
          for (const card of col) if (!card.faceUp) return false;
        }
        return true;
      }

      function findFoundationMove() {
        for (let col = 0; col < 7; col += 1) {
          const top = topOf(col);
          if (!top) continue;
          for (let f = 0; f < 4; f += 1) {
            if (canStackFoundation(top, foundTop(f))) return { type: "t2f", from: col, to: f };
          }
        }
        const wtop = state.waste[state.waste.length - 1];
        if (wtop) {
          for (let f = 0; f < 4; f += 1) {
            if (canStackFoundation(wtop, foundTop(f))) return { type: "w2f", to: f };
          }
        }
        return null;
      }

      function startAutoComplete() {
        if (autoRunning || won || !canAutoComplete()) return;
        selection = null;
        autoRunning = true;
        refreshAutoButton();
        autoStep();
      }

      function autoStep() {
        const move = findFoundationMove();
        if (!move) {
          autoRunning = false;
          refreshAutoButton();
          return;
        }
        performMove(move);
        if (won) {
          autoRunning = false;
          refreshAutoButton();
          return;
        }
        autoTimer = ctx.timeout(autoStep, AUTO_MS);
      }

      function cancelAuto() {
        if (autoTimer) {
          window.clearTimeout(autoTimer);
          autoTimer = 0;
        }
        autoRunning = false;
      }

      // ── 计时与胜负 ────────────────────────────────────────
      function startTimerIfNeeded() {
        if (timerRunning || won) return;
        timerRunning = true;
        startedAt = Date.now();
        timerId = ctx.interval(() => {
          timeChip.lastChild.textContent = formatTime(Date.now() - startedAt);
        }, 500);
      }

      function stopTimer() {
        if (timerId) {
          window.clearInterval(timerId);
          timerId = 0;
        }
        timerRunning = false;
      }

      function checkWin() {
        if (!isWon(state.foundations)) return;
        won = true;
        stopTimer();
        const elapsed = Date.now() - startedAt;
        const prevBest = Number(ctx.store.get(id, "bestMs", 0)) || 0;
        const broke = prevBest === 0 || elapsed < prevBest;
        if (broke) ctx.store.set(id, "bestMs", elapsed);
        ctx.store.bump(id, "wins");
        overlayBody.replaceChildren(
          MOYU.el("div", { class: "mg-panel-title", text: broke ? "🎉 新纪录！" : "🎉 全部收齐" }),
          MOYU.el("div", {
            class: "mg-panel-text",
            text: `用时 ${formatTime(elapsed)} · ${moves} 步${broke ? "" : ` · 历史最佳 ${formatTime(prevBest)}`}`,
          }),
          MOYU.el(
            "div",
            { class: "mg-panel-actions" },
            MOYU.el("button", { class: "mg-btn primary", type: "button", text: "再来一局", onclick: () => newGame() }),
          ),
        );
        overlay.hidden = false;
      }

      function newGame() {
        cancelAuto();
        undoStack = [];
        state = deal();
        selection = null;
        won = false;
        moves = 0;
        lastFlippedId = null;
        stopTimer();
        timerRunning = false;
        startedAt = 0;
        timeChip.lastChild.textContent = "0:00";
        overlay.hidden = true;
        afterChange();
      }

      function setDraw(n) {
        if (n !== 1 && n !== 3) return;
        drawCount = n;
        ctx.store.set(id, "draw", n);
        for (const [key, btn] of drawButtons) btn.setAttribute("aria-pressed", String(Number(key) === n));
      }

      function refreshUndoButton() {
        const n = undoStack.length;
        undoBtn.disabled = won || n === 0;
        undoBtn.textContent = n > 0 ? `撤销 ${n}` : "撤销";
      }

      function refreshAutoButton() {
        if (won) {
          autoBtn.hidden = true;
          return;
        }
        if (autoRunning) {
          autoBtn.hidden = false;
          autoBtn.disabled = true;
          autoBtn.textContent = "完成中…";
          return;
        }
        if (canAutoComplete()) {
          autoBtn.hidden = false;
          autoBtn.disabled = false;
          autoBtn.textContent = "自动完成";
          return;
        }
        autoBtn.hidden = true;
      }

      // ── 渲染 ──────────────────────────────────────────────
      function columnLayout(column) {
        const n = column.length;
        if (n === 0) return { tops: [], height: cardH };
        let naturalSpan = 0;
        for (let j = 0; j < n - 1; j += 1) naturalSpan += column[j].faceUp ? faceOffset : backOffset;
        const compress = naturalSpan > maxSpan && naturalSpan > 0 ? maxSpan / naturalSpan : 1;
        const tops = new Array(n);
        let top = 0;
        for (let i = n - 1; i >= 0; i -= 1) {
          tops[i] = Math.round(top);
          if (i === 0) break;
          top += (column[i - 1].faceUp ? faceOffset : backOffset) * compress;
        }
        return { tops, height: Math.round(top) + cardH };
      }

      function makeFaceCard(card, loc) {
        const el = MOYU.el("div", {
          class: "mg-sol-card mg-sol-face " + (isRed(card) ? "mg-sol-red" : "mg-sol-black"),
          text: rankLabel(card.rank) + SUIT_SYMBOL[card.suit],
        });
        if (loc.kind === "tableau") el.dataset.pos = String(loc.pos);
        if (isSelected(card)) el.classList.add("mg-sol-sel");
        if (card.id === lastFlippedId) el.classList.add("mg-sol-flip");
        return el;
      }

      function makeColumn(col) {
        const column = state.tableau[col];
        const layoutInfo = columnLayout(column);
        const colEl = MOYU.el("div", {
          class: "mg-sol-col",
          dataset: { slot: "t", index: String(col) },
          style: { height: `${layoutInfo.height}px` },
        });
        if (isValidTableauTarget(col)) colEl.classList.add("mg-sol-target");
        if (column.length === 0) {
          colEl.append(MOYU.el("div", { class: "mg-sol-ph-col" }));
        } else {
          column.forEach((card, pos) => {
            const el = makeFaceCard(card, { kind: "tableau", col, pos });
            el.style.top = `${layoutInfo.tops[pos]}px`;
            colEl.append(el);
          });
        }
        colEl.addEventListener("pointerdown", (event) => {
          if (!isPrimary(event)) return;
          const cardEl = event.target.closest ? event.target.closest(".mg-sol-card") : null;
          if (cardEl) {
            onCardPointerDown(event, { kind: "tableau", col, pos: Number(cardEl.dataset.pos) });
          } else {
            beginPointer(event, { kind: "tableau", col, pos: -1 }, null);
          }
        });
        return colEl;
      }

      function makeFoundation(idx) {
        const top = foundTop(idx);
        const slot = MOYU.el("div", { class: "mg-sol-slot mg-sol-found", dataset: { slot: "f", index: String(idx) } });
        if (isValidFoundationTarget(idx)) slot.classList.add("mg-sol-target");
        if (top) slot.append(makeFaceCard(top, { kind: "foundation", idx }));
        else slot.append(MOYU.el("div", { class: "mg-sol-ph", text: SUIT_SYMBOL[SUITS[idx]] }));
        slot.addEventListener("pointerdown", (event) => {
          if (!isPrimary(event)) return;
          const cardEl = event.target.closest ? event.target.closest(".mg-sol-card") : null;
          if (cardEl) onCardPointerDown(event, { kind: "foundation", idx });
          else beginPointer(event, { kind: "foundation", idx, empty: true }, null);
        });
        return slot;
      }

      function makeStock() {
        const slot = MOYU.el("div", { class: "mg-sol-slot mg-sol-stock", dataset: { slot: "stock" } });
        if (state.stock.length > 0) {
          slot.append(MOYU.el("div", { class: "mg-sol-card mg-sol-back" }));
        } else if (state.waste.length > 0) {
          slot.append(MOYU.el("div", { class: "mg-sol-ph", text: "↻" }));
        }
        slot.addEventListener("pointerdown", (event) => {
          if (!isPrimary(event)) return;
          beginPointer(event, { kind: "stock" }, null);
        });
        return slot;
      }

      function makeWaste() {
        const slot = MOYU.el("div", { class: "mg-sol-slot mg-sol-waste", dataset: { slot: "waste" } });
        const top = state.waste[state.waste.length - 1];
        if (top) slot.append(makeFaceCard(top, { kind: "waste" }));
        slot.addEventListener("pointerdown", (event) => {
          if (!isPrimary(event)) return;
          const cardEl = event.target.closest ? event.target.closest(".mg-sol-card") : null;
          if (cardEl) onCardPointerDown(event, { kind: "waste" });
          else beginPointer(event, { kind: "waste-empty" }, null);
        });
        return slot;
      }

      function onCardPointerDown(event, loc) {
        beginPointer(event, loc, getMovableAt(loc));
      }

      function buildTop() {
        for (let f = 0; f < 4; f += 1) topRow.append(makeFoundation(f));
        topRow.append(MOYU.el("div", { class: "mg-sol-gap" }));
        topRow.append(makeStock());
        topRow.append(makeWaste());
      }

      function buildTableau() {
        for (let col = 0; col < 7; col += 1) tableauRow.append(makeColumn(col));
      }

      function render() {
        MOYU.clear(topRow);
        buildTop();
        MOYU.clear(tableauRow);
        buildTableau();
        lastFlippedId = null;
      }

      function layout() {
        const width = board.clientWidth || 320;
        cardW = Math.max(34, Math.min(62, Math.floor((width - 6 * COL_GAP) / 7)));
        cardH = Math.round(cardW * 1.4);
        faceOffset = Math.round(cardW * 0.28);
        backOffset = Math.max(2, Math.round(cardW * 0.14));
        board.style.setProperty("--cardW", `${cardW}px`);
        board.style.setProperty("--cardH", `${cardH}px`);
        const tableauH = (board.clientHeight || 0) - cardH - BOARD_GAP;
        maxSpan = Math.max(0, tableauH - cardH);
        render();
      }

      const observer = new ResizeObserver(() => layout());
      observer.observe(board);
      refreshUndoButton();
      refreshAutoButton();
      layout();

      return () => {
        cancelAuto();
        stopTimer();
        removePointerListeners();
        removeFloat();
        observer.disconnect();
      };
    },

    hubLine(entry) {
      const wins = Number(entry.wins) || 0;
      if (wins <= 0) return "";
      const best = Number(entry.bestMs) || 0;
      if (best <= 0) return `${wins} 胜`;
      return `${wins} 胜 · 最快 ${formatTime(best)}`;
    },
  };

  MOYU.games.solitaire._logic = logic;
})();
