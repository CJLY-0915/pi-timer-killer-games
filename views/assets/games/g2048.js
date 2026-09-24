/**
 * 2048 — DOM 绝对定位方块方案
 *
 * 4×4 标准规则：整行/列滑动、相等合并且每块每次移动最多合并一次、有效移动后空位生成 2(90%)/4(10%)。
 * 方块带 id：移动时用 transform 过渡滑动，合并源块滑到目标格后移除，新块与随机块加 .mg-pop。
 * 撤销只保存一步深拷贝；最高分用 store.record（只破纪录才写盘），达成 2048 用 store.bump 计次。
 */
(function () {
  "use strict";
  const MOYU = (window.MOYU = window.MOYU || {});
  MOYU.games = MOYU.games || {};

  const SIZE = 4;
  const WIN_VALUE = 2048;
  const SLIDE_MS = 120;
  const SWIPE_THRESHOLD = 18;

  const KEY_DIRECTIONS = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
    a: "left",
    d: "right",
    w: "up",
    s: "down",
    A: "left",
    D: "right",
    W: "up",
    S: "down",
  };

  MOYU.style(
    "g2048",
    `
    .mg-2048-stage {
      flex: 1 1 auto;
      min-height: 0;
      display: grid;
      place-items: center;
    }
    .mg-2048-board {
      position: relative;
      display: grid;
      grid-template-columns: repeat(4, var(--mg-2048-cell, 64px));
      grid-auto-rows: var(--mg-2048-cell, 64px);
      gap: var(--mg-2048-gap, 10px);
      padding: var(--mg-2048-gap, 10px);
      background: var(--mg-surface);
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-md);
      touch-action: none;
      user-select: none;
    }
    .mg-2048-bg {
      background: var(--mg-surface-2);
      border-radius: var(--mg-r-sm);
    }
    .mg-2048-tiles {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .mg-2048-tile {
      position: absolute;
      left: 0;
      top: 0;
      width: var(--mg-2048-cell, 64px);
      height: var(--mg-2048-cell, 64px);
      display: grid;
      place-items: center;
      border-radius: var(--mg-r-sm);
      font-family: var(--mg-mono);
      font-weight: 700;
      font-size: calc(var(--mg-2048-cell, 64px) * 0.46);
      line-height: 1;
      background: var(--mg-2048-t2-bg);
      color: var(--mg-2048-t2-fg);
      /* 位移写在独立的 translate 上、弹出动画写在独立的 scale 上，两者都不碰 transform：
         共用一个 transform 时，scale 会以位移前的原点缩放，方块一边长大一边往格子里滑。 */
      transition: translate 0.12s ease-in-out;
      will-change: translate;
    }
    .mg-2048-tile.vwide { font-size: calc(var(--mg-2048-cell, 64px) * 0.38); }
    .mg-2048-tile.vlong { font-size: calc(var(--mg-2048-cell, 64px) * 0.3); }
    .mg-2048-tile.v2 { background: var(--mg-2048-t2-bg); color: var(--mg-2048-t2-fg); }
    .mg-2048-tile.v4 { background: var(--mg-2048-t4-bg); color: var(--mg-2048-t4-fg); }
    .mg-2048-tile.v8 { background: var(--mg-2048-t8-bg); color: var(--mg-2048-t8-fg); }
    .mg-2048-tile.v16 { background: var(--mg-2048-t16-bg); color: var(--mg-2048-t16-fg); }
    .mg-2048-tile.v32 { background: var(--mg-2048-t32-bg); color: var(--mg-2048-t32-fg); }
    .mg-2048-tile.v64 { background: var(--mg-2048-t64-bg); color: var(--mg-2048-t64-fg); }
    .mg-2048-tile.v128 { background: var(--mg-2048-t128-bg); color: var(--mg-2048-t128-fg); }
    .mg-2048-tile.v256 { background: var(--mg-2048-t256-bg); color: var(--mg-2048-t256-fg); }
    .mg-2048-tile.v512 { background: var(--mg-2048-t512-bg); color: var(--mg-2048-t512-fg); }
    .mg-2048-tile.v1024 { background: var(--mg-2048-t1024-bg); color: var(--mg-2048-t1024-fg); }
    .mg-2048-tile.v2048 { background: var(--mg-2048-t2048-bg); color: var(--mg-2048-t2048-fg); }
    .mg-2048-tile.vsuper { background: var(--mg-2048-super-bg); color: var(--mg-2048-super-fg); }
    .mg-2048-board .mg-overlay { border-radius: var(--mg-r-md); }
    .mg-2048-pad {
      flex: none;
      display: grid;
      grid-template-columns: repeat(3, 44px);
      grid-template-rows: repeat(2, 34px);
      gap: 6px;
      justify-content: center;
    }
    .mg-2048-pad button {
      appearance: none;
      border: 1px solid var(--mg-line);
      background: var(--mg-surface-2);
      color: var(--mg-text);
      border-radius: var(--mg-r-sm);
      font-size: 15px;
      cursor: pointer;
    }
    .mg-2048-pad button:active { background: var(--mg-accent-soft); }
    .mg-2048-pad .up { grid-area: 1 / 2; }
    .mg-2048-pad .left { grid-area: 2 / 1; }
    .mg-2048-pad .down { grid-area: 2 / 2; }
    .mg-2048-pad .right { grid-area: 2 / 3; }
    html[data-theme="dark"] {
      --mg-2048-t2-bg: #333b47;
      --mg-2048-t2-fg: #e6ebf2;
      --mg-2048-t4-bg: #3e4859;
      --mg-2048-t4-fg: #eef2f8;
      --mg-2048-t8-bg: #b06a2c;
      --mg-2048-t8-fg: #fff4ea;
      --mg-2048-t16-bg: #bd5a30;
      --mg-2048-t16-fg: #fff2ec;
      --mg-2048-t32-bg: #b84c37;
      --mg-2048-t32-fg: #fff0ed;
      --mg-2048-t64-bg: #b23c2c;
      --mg-2048-t64-fg: #ffeeea;
      --mg-2048-t128-bg: #a8892f;
      --mg-2048-t128-fg: #fdf5e0;
      --mg-2048-t256-bg: #a07f2a;
      --mg-2048-t256-fg: #fdf5e0;
      --mg-2048-t512-bg: #987626;
      --mg-2048-t512-fg: #fdf5e0;
      --mg-2048-t1024-bg: #906d21;
      --mg-2048-t1024-fg: #fdf5e0;
      --mg-2048-t2048-bg: #d9a62e;
      --mg-2048-t2048-fg: #1c1503;
      --mg-2048-super-bg: #7a5fb0;
      --mg-2048-super-fg: #f4efff;
    }
    html[data-theme="light"] {
      --mg-2048-t2-bg: #eee4da;
      --mg-2048-t2-fg: #6f675c;
      --mg-2048-t4-bg: #ede0c8;
      --mg-2048-t4-fg: #6f675c;
      --mg-2048-t8-bg: #f2b179;
      --mg-2048-t8-fg: #f9f6f2;
      --mg-2048-t16-bg: #f59563;
      --mg-2048-t16-fg: #f9f6f2;
      --mg-2048-t32-bg: #f67c5f;
      --mg-2048-t32-fg: #f9f6f2;
      --mg-2048-t64-bg: #f65e3b;
      --mg-2048-t64-fg: #f9f6f2;
      --mg-2048-t128-bg: #edcf72;
      --mg-2048-t128-fg: #f9f6f2;
      --mg-2048-t256-bg: #edcc61;
      --mg-2048-t256-fg: #f9f6f2;
      --mg-2048-t512-bg: #edc850;
      --mg-2048-t512-fg: #f9f6f2;
      --mg-2048-t1024-bg: #edc53f;
      --mg-2048-t1024-fg: #f9f6f2;
      --mg-2048-t2048-bg: #edc22e;
      --mg-2048-t2048-fg: #f9f6f2;
      --mg-2048-super-bg: #3c3a32;
      --mg-2048-super-fg: #f9f6f2;
    }
    `,
  );

  // ── 纯逻辑（可经 MOYU.games.g2048._logic 独立自测） ────────────

  let nextTileId = 1;

  function buildGrid(tiles) {
    const grid = Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
    for (const tile of tiles) grid[tile.row][tile.col] = tile;
    return grid;
  }

  /** 一条线的格子顺序：靠近被滑动方向的那端排在最前。 */
  function lineSpots(direction, line) {
    const horizontal = direction === "left" || direction === "right";
    const reverse = direction === "right" || direction === "down";
    const order = reverse ? [3, 2, 1, 0] : [0, 1, 2, 3];
    return order.map((index) => (horizontal ? { row: line, col: index } : { row: index, col: line }));
  }

  /** 计算滑动合并计划；moved=false 表示该方向不改变局面（不生成新块、不计分）。 */
  function planMove(tiles, direction) {
    const grid = buildGrid(tiles);
    const slides = [];
    const merges = [];
    let gained = 0;
    let moved = false;

    for (let line = 0; line < SIZE; line += 1) {
      const spots = lineSpots(direction, line);
      const queue = spots.map((spot) => grid[spot.row][spot.col]).filter(Boolean);
      let target = 0;
      for (let i = 0; i < queue.length; i += 1) {
        const tile = queue[i];
        const partner = queue[i + 1];
        const spot = spots[target];
        const settled = tile.row === spot.row && tile.col === spot.col;
        if (partner && partner.value === tile.value) {
          const value = tile.value * 2;
          gained += value;
          merges.push({ a: tile, b: partner, value, row: spot.row, col: spot.col });
          slides.push({ tile, row: spot.row, col: spot.col });
          slides.push({ tile: partner, row: spot.row, col: spot.col });
          if (!settled || partner.row !== spot.row || partner.col !== spot.col) moved = true;
          i += 1;
        } else {
          slides.push({ tile, row: spot.row, col: spot.col });
          if (!settled) moved = true;
        }
        target += 1;
      }
    }
    return { slides, merges, gained, moved };
  }

  /** 落地计划：幸存块移到新位置，合并源块退役，生成合并新块。 */
  function applyPlan(tiles, plan) {
    const retired = new Set();
    for (const merge of plan.merges) {
      retired.add(merge.a);
      retired.add(merge.b);
    }
    const survivors = tiles.filter((tile) => !retired.has(tile));
    for (const slide of plan.slides) {
      if (retired.has(slide.tile)) continue;
      slide.tile.row = slide.row;
      slide.tile.col = slide.col;
    }
    const fresh = plan.merges.map((merge) => {
      const tile = { id: nextTileId++, value: merge.value, row: merge.row, col: merge.col };
      survivors.push(tile);
      return tile;
    });
    return { tiles: survivors, fresh };
  }

  function tilesFromNumbers(cells) {
    const tiles = [];
    for (let index = 0; index < cells.length; index += 1) {
      const value = cells[index];
      if (!value) continue;
      tiles.push({ id: nextTileId++, value, row: Math.floor(index / SIZE), col: index % SIZE });
    }
    return tiles;
  }

  function numbersFromTiles(tiles) {
    const cells = new Array(SIZE * SIZE).fill(0);
    for (const tile of tiles) cells[tile.row * SIZE + tile.col] = tile.value;
    return cells;
  }

  /** 自测入口：数字棋盘 + 方向 → 新棋盘、得分与是否发生移动（不修改入参）。 */
  function moveNumbers(cells, direction) {
    const tiles = tilesFromNumbers(cells);
    const plan = planMove(tiles, direction);
    if (!plan.moved) return { cells: cells.slice(), gained: 0, moved: false };
    return { cells: numbersFromTiles(applyPlan(tiles, plan).tiles), gained: plan.gained, moved: true };
  }

  function canMove(tiles) {
    const grid = buildGrid(tiles);
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const tile = grid[row][col];
        if (!tile) return true;
        const right = col + 1 < SIZE ? grid[row][col + 1] : null;
        const down = row + 1 < SIZE ? grid[row + 1][col] : null;
        if ((right && right.value === tile.value) || (down && down.value === tile.value)) return true;
      }
    }
    return false;
  }

  function hasMoves(cells) {
    return canMove(tilesFromNumbers(cells));
  }

  function spawnValue() {
    return Math.random() < 0.9 ? 2 : 4;
  }

  MOYU.games.g2048 = {
    id: "g2048",
    name: "2048",
    tagline: "滑动合并，冲向 2048",
    emoji: "🔢",
    order: 2,

    mount(root, ctx) {
      const id = ctx.gameId;

      let tiles = [];
      let score = 0;
      let undoState = null;
      let celebrated = 0;
      let won = false;
      let finished = false;
      let blocked = false;
      let pending = null;
      let slideToken = 0;
      let cellSize = 64;
      let gapSize = 12;
      const els = new Map();

      const scoreChip = MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: "分数" }), "0");
      const bestChip = MOYU.el("span", { class: "mg-chip good" }, MOYU.el("span", { class: "k", text: "最高" }), "0");
      const undoBtn = MOYU.el("button", {
        class: "mg-btn ghost",
        type: "button",
        text: "撤销",
        disabled: true,
        onclick: () => undo(),
      });
      const newBtn = MOYU.el("button", { class: "mg-btn primary", type: "button", text: "新游戏", onclick: () => newGame() });
      const bar = MOYU.el(
        "div",
        { class: "mg-game-bar" },
        MOYU.el("div", { class: "mg-chips" }, scoreChip, bestChip),
        MOYU.el("div", { class: "mg-spacer" }),
        undoBtn,
        newBtn,
      );

      const stage = MOYU.el("div", { class: "mg-2048-stage" });
      const board = MOYU.el("div", { class: "mg-2048-board", role: "application", "aria-label": "2048 棋盘" });
      const tileLayer = MOYU.el("div", { class: "mg-2048-tiles" });
      const overlay = MOYU.el("div", { class: "mg-overlay", hidden: true });
      const overlayBody = MOYU.el("div", { class: "mg-panel" });
      overlay.append(overlayBody);

      const bgCells = [];
      for (let row = 0; row < SIZE; row += 1) {
        for (let col = 0; col < SIZE; col += 1) {
          bgCells.push(MOYU.el("div", { class: "mg-2048-bg" }));
        }
      }
      board.append(...bgCells, tileLayer, overlay);
      stage.append(board);

      const pad = MOYU.el(
        "div",
        { class: "mg-2048-pad" },
        MOYU.el("button", { class: "up", type: "button", text: "↑", "aria-label": "上", onclick: () => move("up") }),
        MOYU.el("button", { class: "left", type: "button", text: "←", "aria-label": "左", onclick: () => move("left") }),
        MOYU.el("button", { class: "down", type: "button", text: "↓", "aria-label": "下", onclick: () => move("down") }),
        MOYU.el("button", { class: "right", type: "button", text: "→", "aria-label": "右", onclick: () => move("right") }),
      );

      const help = MOYU.el(
        "div",
        { class: "mg-help" },
        MOYU.el("kbd", { text: "↑↓←→" }),
        " / ",
        MOYU.el("kbd", { text: "WASD" }),
        " 滑动，也可在棋盘上直接滑动；撤销只能回退一步。",
      );

      root.append(bar, stage, pad, help);

      // ── 渲染 ─────────────────────────────────────────────────

      function layout() {
        const side = Math.max(180, Math.min(stage.clientWidth || 320, stage.clientHeight || 380, 380));
        gapSize = Math.max(6, Math.round(side * 0.03));
        cellSize = (side - gapSize * (SIZE + 1)) / SIZE;
        board.style.setProperty("--mg-2048-cell", `${cellSize}px`);
        board.style.setProperty("--mg-2048-gap", `${gapSize}px`);
        // 底色格由 board 的 4×4 grid 定位，这里再 translate 会重复偏移并把最后一列推到棋盘外
        for (const tile of tiles) {
          const el = els.get(tile.id);
          if (el) place(el, tile.row, tile.col);
        }
      }

      /** 位置只走 translate 属性：transform 留给别处（弹出动画用 scale），避免合成顺序把弹出变成滑动。 */
      function place(el, row, col) {
        const x = gapSize + col * (cellSize + gapSize);
        const y = gapSize + row * (cellSize + gapSize);
        el.style.translate = `${x}px ${y}px`;
      }

      function tileClass(value) {
        const base = value > WIN_VALUE ? "vsuper" : `v${value}`;
        if (value >= 10000) return `${base} vlong`;
        if (value >= 1000) return `${base} vwide`;
        return base;
      }

      function addTileEl(tile, pop) {
        const el = MOYU.el("div", { class: `mg-2048-tile ${tileClass(tile.value)}`, text: String(tile.value) });
        place(el, tile.row, tile.col);
        if (pop) el.classList.add("mg-pop");
        tileLayer.append(el);
        els.set(tile.id, el);
      }

      function rebuild() {
        MOYU.clear(tileLayer);
        els.clear();
        for (const tile of tiles) addTileEl(tile, false);
      }

      // ── 局面 ─────────────────────────────────────────────────

      function snapshot() {
        return tiles.map((tile) => ({ id: tile.id, value: tile.value, row: tile.row, col: tile.col }));
      }

      function maxTile() {
        let peak = 0;
        for (const tile of tiles) if (tile.value > peak) peak = tile.value;
        return peak;
      }

      function refreshScore() {
        scoreChip.lastChild.textContent = String(score);
        ctx.store.record(id, "best", score);
        ctx.store.record(id, "bestTile", maxTile());
        bestChip.lastChild.textContent = String(Number(ctx.store.get(id, "best", 0)) || 0);
      }

      function setUndoEnabled(enabled) {
        undoBtn.disabled = !enabled;
      }

      function spawnRandomTile() {
        const grid = buildGrid(tiles);
        const free = [];
        for (let row = 0; row < SIZE; row += 1) {
          for (let col = 0; col < SIZE; col += 1) {
            if (!grid[row][col]) free.push({ row, col });
          }
        }
        if (!free.length) return null;
        const spot = free[Math.floor(Math.random() * free.length)];
        const tile = { id: nextTileId++, value: spawnValue(), row: spot.row, col: spot.col };
        tiles.push(tile);
        return tile;
      }

      function newGame() {
        tiles = [];
        score = 0;
        undoState = null;
        celebrated = 0;
        won = false;
        finished = false;
        blocked = false;
        pending = null;
        slideToken += 1;
        overlay.hidden = true;
        setUndoEnabled(false);
        spawnRandomTile();
        spawnRandomTile();
        rebuild();
        refreshScore();
      }

      // ── 操作 ─────────────────────────────────────────────────

      function move(direction) {
        if (blocked || finished) return;
        flushPending();
        const plan = planMove(tiles, direction);
        if (!plan.moved) return;
        undoState = { tiles: snapshot(), score };
        setUndoEnabled(true);
        const applied = applyPlan(tiles, plan);
        tiles = applied.tiles;
        score += plan.gained;
        refreshScore();
        for (const slide of plan.slides) {
          const el = els.get(slide.tile.id);
          if (el) place(el, slide.row, slide.col);
        }
        const fresh = applied.fresh.slice();
        const spawned = spawnRandomTile();
        if (spawned) fresh.push(spawned);
        pending = { sources: plan.merges.flatMap((merge) => [merge.a, merge.b]), fresh };
        const token = (slideToken += 1);
        ctx.timeout(() => {
          if (token === slideToken) flushPending();
        }, SLIDE_MS);
        celebrate();
        if (!canMove(tiles)) {
          finished = true;
          setUndoEnabled(false);
          const settleToken = slideToken;
          ctx.timeout(() => {
            if (settleToken === slideToken) showGameOver();
          }, SLIDE_MS + 80);
        }
      }

      /** 结算上一手尚未收尾的动画元素；连按时先落地再走下一步，避免丢块。 */
      function flushPending() {
        if (!pending) return;
        for (const tile of pending.sources) {
          els.get(tile.id)?.remove();
          els.delete(tile.id);
        }
        for (const tile of pending.fresh) addTileEl(tile, true);
        pending = null;
      }

      function celebrate() {
        const peak = maxTile();
        if (peak < WIN_VALUE || peak <= celebrated) return;
        celebrated = peak;
        if (!won) {
          won = true;
          ctx.store.bump(id, "wins");
        }
        blocked = true;
        const settleToken = slideToken;
        ctx.timeout(() => {
          if (settleToken === slideToken) showWin(peak); // 新开过一局就别弹过期浮层
        }, SLIDE_MS + 60);
      }

      function undo() {
        if (!undoState || blocked || finished) return;
        flushPending();
        tiles = undoState.tiles.map((tile) => ({ ...tile }));
        score = undoState.score;
        undoState = null;
        setUndoEnabled(false);
        rebuild();
        refreshScore();
      }

      // ── 浮层 ─────────────────────────────────────────────────

      function showOverlay(title, text, actions) {
        overlayBody.replaceChildren(
          MOYU.el("div", { class: "mg-panel-title", text: title }),
          MOYU.el("div", { class: "mg-panel-text", text }),
          MOYU.el("div", { class: "mg-panel-actions" }, actions),
        );
        overlay.hidden = false;
      }

      function showWin(peak) {
        showOverlay(`达成 ${peak}！`, `本局 ${score} 分`, [
          MOYU.el("button", {
            class: "mg-btn primary",
            type: "button",
            text: "继续挑战",
            onclick: () => {
              blocked = false;
              overlay.hidden = true;
            },
          }),
          MOYU.el("button", { class: "mg-btn", type: "button", text: "再来一局", onclick: () => newGame() }),
        ]);
      }

      function showGameOver() {
        showOverlay("游戏结束", `本局 ${score} 分`, [
          MOYU.el("button", { class: "mg-btn primary", type: "button", text: "再来一局", onclick: () => newGame() }),
        ]);
      }

      // ── 输入 ─────────────────────────────────────────────────

      const offKey = ctx.key((event) => {
        const direction = KEY_DIRECTIONS[event.key];
        if (!direction) return;
        event.preventDefault();
        move(direction);
      });

      let swipeStart = null;
      board.addEventListener("pointerdown", (event) => {
        swipeStart = { x: event.clientX, y: event.clientY };
      });
      board.addEventListener("pointerup", (event) => {
        if (!swipeStart) return;
        const dx = event.clientX - swipeStart.x;
        const dy = event.clientY - swipeStart.y;
        swipeStart = null;
        if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD) return;
        if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? "right" : "left");
        else move(dy > 0 ? "down" : "up");
      });
      board.addEventListener("pointercancel", () => {
        swipeStart = null;
      });

      const observer = new ResizeObserver(() => layout());
      observer.observe(stage);

      // 先量尺寸再发牌：否则首批方块先用默认格子尺寸落位，layout() 再改一次就白动一下
      layout();
      newGame();

      return () => {
        observer.disconnect();
        offKey();
      };
    },

    hubLine(entry) {
      const best = Number(entry.best) || 0;
      return best > 0 ? `最高 ${best} 分` : "";
    },
  };

  MOYU.games.g2048._logic = { move: moveNumbers, hasMoves, spawnValue };
})();
