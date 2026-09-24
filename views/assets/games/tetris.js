/**
 * 俄罗斯方块 — canvas 方案
 *
 * 10×20 现代规则：7-bag 随机、SRS 旋转与墙踢、幽灵块、暂存、锁定延迟、消行高亮。
 * 纯判定函数（旋转/踢墙/消行/取袋/落点）挂在 _logic 上，可脱离 DOM 自测。
 */
(function () {
  "use strict";
  const MOYU = (window.MOYU = window.MOYU || {});
  MOYU.games = MOYU.games || {};

  const COLS = 10;
  const ROWS = 20;
  const LOCK_DELAY_MS = 500;
  const MAX_LOCK_RESETS = 15;
  const CLEAR_FLASH_MS = 120;
  const PREVIEW_COUNT = 3;
  const MINI_CELL = 11;
  const LINE_SCORES = [0, 100, 300, 500, 800];
  // 等级 1 起每行重力间隔，最后一级封顶 80ms
  const GRAVITY_MS = [800, 720, 630, 550, 470, 380, 300, 230, 170, 130, 100, 90, 80];
  const SIDE_W = 70;
  const SIDE_H = 84;
  const FALLBACK_COLORS = {
    I: "#22d3ee",
    O: "#f5c518",
    T: "#a78bfa",
    S: "#34d399",
    Z: "#f87171",
    J: "#60a5fa",
    L: "#fb923c",
  };

  const TYPES = ["I", "O", "T", "S", "Z", "J", "L"];
  // 只写出生朝向，其余朝向由矩阵顺时针旋转推导（对 JLSTZ/I 与 SRS 一致）
  const SPAWN = {
    I: ["....", "XXXX", "....", "...."],
    O: ["XX", "XX"],
    T: [".X.", "XXX", "..."],
    S: [".XX", "XX.", "..."],
    Z: ["XX.", ".XX", "..."],
    J: ["X..", "XXX", "..."],
    L: ["..X", "XXX", "..."],
  };

  function rotateMatrix(matrix) {
    const size = matrix.length;
    const next = [];
    for (let y = 0; y < size; y += 1) {
      let row = "";
      for (let x = 0; x < size; x += 1) row += matrix[size - 1 - x][y];
      next.push(row);
    }
    return next;
  }

  const STATES = {};
  for (const type of TYPES) {
    const states = [SPAWN[type]];
    for (let i = 1; i < 4; i += 1) states.push(rotateMatrix(states[i - 1]));
    STATES[type] = states;
  }

  // SRS 墙踢表按 y 向上记录，落到画布（y 向下）时取反
  const KICKS = {
    JLSTZ: {
      "0>1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
      "1>0": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
      "1>2": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
      "2>1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
      "2>3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
      "3>2": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
      "3>0": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
      "0>3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    },
    I: {
      "0>1": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
      "1>0": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
      "1>2": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
      "2>1": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
      "2>3": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
      "3>2": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
      "3>0": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
      "0>3": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
    },
  };

  // ── 纯判定 ───────────────────────────────────────────────────

  function cellsOf(type, rot) {
    const matrix = STATES[type][((rot % 4) + 4) % 4];
    const cells = [];
    for (let y = 0; y < matrix.length; y += 1) {
      for (let x = 0; x < matrix[y].length; x += 1) {
        if (matrix[y][x] === "X") cells.push([x, y]);
      }
    }
    return cells;
  }

  function collides(board, cells, offsetX, offsetY) {
    for (const [x, y] of cells) {
      const px = offsetX + x;
      const py = offsetY + y;
      if (px < 0 || px >= COLS || py >= ROWS) return true;
      if (py >= 0 && board[py][px]) return true;
    }
    return false;
  }

  function kickOffsets(type, from, to) {
    if (type === "O") return [[0, 0]];
    const table = type === "I" ? KICKS.I : KICKS.JLSTZ;
    const entries = table[`${from}>${to}`] || [[0, 0]];
    return entries.map(([dx, dy]) => [dx, -dy]);
  }

  /** 依次尝试踢墙偏移，全部失败返回 null（不静默穿墙）。 */
  function rotate(board, piece, dir) {
    const rot = (piece.rot + (dir < 0 ? 3 : 1)) % 4;
    const cells = cellsOf(piece.type, rot);
    for (const [dx, dy] of kickOffsets(piece.type, piece.rot, rot)) {
      const x = piece.x + dx;
      const y = piece.y + dy;
      if (!collides(board, cells, x, y)) return { type: piece.type, rot, x, y };
    }
    return null;
  }

  function fullRows(board) {
    const rows = [];
    for (let y = 0; y < board.length; y += 1) {
      if (board[y].every((cell) => cell)) rows.push(y);
    }
    return rows;
  }

  /** 消除满行，返回新棋盘与消除行数；上方方块随之下落。 */
  function clearLines(board) {
    const kept = [];
    let cleared = 0;
    for (const row of board) {
      if (row.every((cell) => cell)) cleared += 1;
      else kept.push(row);
    }
    const fresh = [];
    for (let i = 0; i < cleared; i += 1) fresh.push(new Array(COLS).fill(0));
    return { board: fresh.concat(kept), cleared };
  }

  /** 7-bag：每袋 7 种各一枚，袋内 Fisher-Yates 打乱。 */
  function createQueue(rng) {
    const random = typeof rng === "function" ? rng : Math.random;
    let bag = [];
    function next() {
      if (!bag.length) {
        bag = TYPES.slice();
        for (let i = bag.length - 1; i > 0; i -= 1) {
          const j = Math.floor(random() * (i + 1));
          const swap = bag[i];
          bag[i] = bag[j];
          bag[j] = swap;
        }
      }
      return bag.pop();
    }
    return { next };
  }

  function gravityFor(level) {
    const index = Math.min(Math.max(Math.floor(level), 1), GRAVITY_MS.length) - 1;
    return GRAVITY_MS[index];
  }

  function levelFor(lines) {
    return Math.floor(lines / 10) + 1;
  }

  function dropY(board, piece) {
    let y = piece.y;
    while (!collides(board, cellsOf(piece.type, piece.rot), piece.x, y + 1)) y += 1;
    return y;
  }

  MOYU.games.tetris = {
    id: "tetris",
    name: "俄罗斯方块",
    tagline: "消行升级，攒个暂存位",
    emoji: "🧱",
    order: 4,

    _logic: {
      COLS,
      ROWS,
      TYPES,
      cellsOf,
      collides,
      rotate,
      fullRows,
      clearLines,
      createQueue,
      gravityFor,
      levelFor,
      dropY,
    },

    mount(root, ctx) {
      const id = ctx.gameId;
      let colors = readColors();
      let board = createBoard();
      let piece = null;
      let queue = [];
      let bag = createQueue();
      let holdType = null;
      let canHold = true;
      let score = 0;
      let lines = 0;
      let level = 1;
      let state = "playing"; // playing | clearing | paused | over
      let gravityAcc = 0;
      let lockAcc = 0;
      let lockResets = 0;
      let clearingRows = [];
      let runId = 0;
      let cell = 20;

      const scoreChip = MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: "分数" }), "0");
      const linesChip = MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: "消行" }), "0");
      const levelChip = MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: "等级" }), "1");
      const bestChip = MOYU.el("span", { class: "mg-chip good" }, MOYU.el("span", { class: "k", text: "最高" }), "0");

      const overlay = MOYU.el("div", { class: "mg-overlay", hidden: true });
      const overlayBody = MOYU.el("div", { class: "mg-panel" });
      overlay.append(overlayBody);

      const pauseBtn = MOYU.el("button", {
        class: "mg-btn",
        type: "button",
        text: "暂停",
        onclick: () => togglePause(),
      });

      const canvas = MOYU.el("canvas", { class: "mg-tetris-canvas" });
      const boardWrap = MOYU.el("div", { class: "mg-tetris-boardwrap" }, canvas, overlay);

      const previewNodes = [];
      for (let i = 0; i < PREVIEW_COUNT; i += 1) {
        const node = MOYU.el("canvas", { class: "mg-tetris-mini" });
        previewNodes.push(node);
        sizeMini(node);
      }
      const holdNode = MOYU.el("canvas", { class: "mg-tetris-mini" });
      sizeMini(holdNode);

      const side = MOYU.el(
        "div",
        { class: "mg-tetris-side" },
        MOYU.el(
          "div",
          { class: "mg-tetris-group" },
          MOYU.el("div", { class: "mg-tetris-label", text: "下一个" }),
          MOYU.el("div", { class: "mg-tetris-previews" }, previewNodes),
        ),
        MOYU.el(
          "div",
          { class: "mg-tetris-group" },
          MOYU.el("div", { class: "mg-tetris-label", text: "暂存" }),
          holdNode,
        ),
      );

      const main = MOYU.el("div", { class: "mg-tetris-main" }, boardWrap, side);

      const pad = MOYU.el(
        "div",
        { class: "mg-tetris-pad" },
        padButton("←", "左移", () => move(-1)),
        padButton("→", "右移", () => move(1)),
        padButton("↓", "软降", () => softDrop()),
        padButton("↻", "旋转", () => rotatePiece(1)),
        padButton("硬降", "直接落底", () => hardDrop()),
        padButton("暂存", "暂存（C）", () => holdPiece()),
      );

      const help = MOYU.el(
        "div",
        { class: "mg-tetris-help mg-help" },
        MOYU.el("kbd", { text: "←→" }), " 移动 ",
        MOYU.el("kbd", { text: "↑" }), "/", MOYU.el("kbd", { text: "X" }), " 旋转 ",
        MOYU.el("kbd", { text: "Z" }), " 反转 ",
        MOYU.el("kbd", { text: "↓" }), " 软降 ",
        MOYU.el("kbd", { text: "空格" }), " 硬降 ",
        MOYU.el("kbd", { text: "C" }), " 暂存 ",
        MOYU.el("kbd", { text: "P" }), " 暂停",
      );

      const bar = MOYU.el(
        "div",
        { class: "mg-game-bar" },
        MOYU.el("div", { class: "mg-chips" }, scoreChip, linesChip, levelChip, bestChip),
        MOYU.el("div", { class: "mg-spacer" }),
        pauseBtn,
      );

      root.append(MOYU.el("div", { class: "mg-tetris" }, bar, main, pad, help));

      // ── 局面 ─────────────────────────────────────────────────

      function createBoard() {
        return Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
      }

      function takeType() {
        const type = queue.shift();
        queue.push(bag.next());
        return type;
      }

      function spawn(type, keepHoldLocked) {
        const width = STATES[type][0].length;
        let top = STATES[type][0].length;
        for (const [, y] of cellsOf(type, 0)) top = Math.min(top, y);
        piece = { type, rot: 0, x: Math.floor((COLS - width) / 2), y: -top };
        gravityAcc = 0;
        lockAcc = 0;
        lockResets = 0;
        canHold = !keepHoldLocked;
        refreshSide();
        if (collides(board, cellsOf(type, 0), piece.x, piece.y)) gameOver();
      }

      function reset() {
        runId += 1;
        board = createBoard();
        bag = createQueue();
        queue = [];
        for (let i = 0; i < PREVIEW_COUNT + 1; i += 1) queue.push(bag.next());
        holdType = null;
        score = 0;
        lines = 0;
        level = 1;
        state = "playing";
        gravityAcc = 0;
        lockAcc = 0;
        lockResets = 0;
        clearingRows = [];
        pauseBtn.textContent = "暂停";
        overlay.hidden = true;
        refreshBest();
        spawn(takeType(), false);
        refreshChips();
        draw();
      }

      function gameOver() {
        state = "over";
        piece = null;
        const broke = ctx.store.record(id, "best", score);
        ctx.store.record(id, "bestLines", lines);
        refreshBest();
        const best = Number(ctx.store.get(id, "best", 0)) || 0;
        overlayBody.replaceChildren(
          MOYU.el("div", { class: "mg-panel-title", text: broke ? "新纪录！" : "游戏结束" }),
          MOYU.el("div", { class: "mg-panel-text", text: `本局 ${score} 分 · 消行 ${lines} 行 · 最高 ${best} 分` }),
          MOYU.el(
            "div",
            { class: "mg-panel-actions" },
            MOYU.el("button", { class: "mg-btn primary", type: "button", text: "再来一局", onclick: () => reset() }),
          ),
        );
        overlay.hidden = false;
        draw();
      }

      function togglePause() {
        if (state === "paused") {
          state = "playing";
          pauseBtn.textContent = "暂停";
          overlay.hidden = true;
        } else if (state === "playing") {
          state = "paused";
          pauseBtn.textContent = "继续";
          overlayBody.replaceChildren(
            MOYU.el("div", { class: "mg-panel-title", text: "已暂停" }),
            MOYU.el("div", { class: "mg-panel-text", text: "按 P 或 Esc 继续" }),
          );
          overlay.hidden = false;
        } else {
          return;
        }
        draw();
      }

      // ── 操作 ─────────────────────────────────────────────────

      function move(dx) {
        if (state !== "playing" || !piece) return;
        if (collides(board, cellsOf(piece.type, piece.rot), piece.x + dx, piece.y)) return;
        piece.x += dx;
        touchLock();
        draw();
      }

      function stepDown() {
        if (collides(board, cellsOf(piece.type, piece.rot), piece.x, piece.y + 1)) return false;
        piece.y += 1;
        return true;
      }

      function softDrop() {
        if (state !== "playing" || !piece) return;
        if (stepDown()) {
          score += 1;
          gravityAcc = 0;
          lockAcc = 0;
          refreshChips();
        }
        draw();
      }

      function hardDrop() {
        if (state !== "playing" || !piece) return;
        const target = dropY(board, piece);
        score += (target - piece.y) * 2;
        piece.y = target;
        refreshChips();
        lockPiece();
      }

      function rotatePiece(dir) {
        if (state !== "playing" || !piece) return;
        const next = rotate(board, piece, dir);
        if (!next) return;
        piece = next;
        touchLock();
        draw();
      }

      function holdPiece() {
        if (state !== "playing" || !piece) return;
        if (!canHold) {
          ctx.toast("每块只能暂存一次");
          return;
        }
        const previous = holdType;
        holdType = piece.type;
        spawn(previous || takeType(), true);

        draw();
      }

      /** 落地前移动/旋转可续锁，但有次数上限，防止无限拖延。 */
      function touchLock() {
        if (lockResets >= MAX_LOCK_RESETS) return;
        lockAcc = 0;
        if (collides(board, cellsOf(piece.type, piece.rot), piece.x, piece.y + 1)) lockResets += 1;
      }

      function lockPiece() {
        const type = piece.type;
        let lockedOut = true;
        for (const [x, y] of cellsOf(type, piece.rot)) {
          const px = piece.x + x;
          const py = piece.y + y;
          if (py < 0) continue;
          board[py][px] = type;
          lockedOut = false;
        }
        piece = null;

        const rows = fullRows(board);
        if (rows.length) {
          state = "clearing";
          clearingRows = rows;
          const generation = runId;
          ctx.timeout(() => {
            if (runId !== generation || state !== "clearing") return;
            finishClear();
          }, CLEAR_FLASH_MS);
          draw();
          return;
        }
        if (lockedOut) {
          gameOver();
          return;
        }
        spawn(takeType(), false);
        draw();
      }

      function finishClear() {
        const result = clearLines(board);
        board = result.board;
        lines += result.cleared;
        score += LINE_SCORES[result.cleared] * level;
        const nextLevel = levelFor(lines);
        if (nextLevel > level) {
          level = nextLevel;
          ctx.toast(`升到 ${level} 级`);
        }
        clearingRows = [];
        state = "playing";
        refreshChips();
        spawn(takeType(), false);
        draw();
      }

      function tick(delta) {
        if (state !== "playing" || !piece) return;
        const interval = gravityFor(level);
        gravityAcc += delta;
        let dropped = false;
        while (gravityAcc >= interval) {
          gravityAcc -= interval;
          if (stepDown()) dropped = true;
          else break;
        }
        // 落子重置续锁计数：只有真正下行才算「有进展」
        if (dropped) {
          lockAcc = 0;
          lockResets = 0;
        }
        if (collides(board, cellsOf(piece.type, piece.rot), piece.x, piece.y + 1)) {
          lockAcc += delta;
          if (lockAcc >= LOCK_DELAY_MS) {
            lockPiece();
            return;
          }
        } else {
          lockAcc = 0;
        }
        draw();
      }

      // ── 渲染 ─────────────────────────────────────────────────

      function colorOf(type) {
        return colors[type] || FALLBACK_COLORS[type];
      }

      function draw() {
        const context = canvas.getContext("2d");
        const width = cell * COLS;
        const height = cell * ROWS;
        context.clearRect(0, 0, width, height);
        context.fillStyle = colors.surface;
        context.fillRect(0, 0, width, height);
        drawGrid(context, width, height);

        for (let y = 0; y < ROWS; y += 1) {
          for (let x = 0; x < COLS; x += 1) {
            if (board[y][x]) drawCell(context, x, y, colorOf(board[y][x]));
          }
        }

        if (piece && (state === "playing" || state === "paused")) {
          const ghostY = dropY(board, piece);
          if (ghostY > piece.y) {
            context.globalAlpha = 0.22;
            for (const [x, y] of cellsOf(piece.type, piece.rot)) {
              if (ghostY + y >= 0) drawCell(context, piece.x + x, ghostY + y, colorOf(piece.type));
            }
            context.globalAlpha = 1;
          }
          for (const [x, y] of cellsOf(piece.type, piece.rot)) {
            if (piece.y + y >= 0) drawCell(context, piece.x + x, piece.y + y, colorOf(piece.type));
          }
        }

        if (state === "clearing") {
          context.fillStyle = colors.warn;
          context.globalAlpha = 0.55;
          for (const y of clearingRows) context.fillRect(0, y * cell, width, cell);
          context.globalAlpha = 1;
        }
      }

      function drawGrid(context, width, height) {
        context.strokeStyle = colors.line;
        context.lineWidth = 1;
        context.beginPath();
        for (let x = 1; x < COLS; x += 1) {
          const position = Math.round(x * cell) + 0.5;
          context.moveTo(position, 0);
          context.lineTo(position, height);
        }
        for (let y = 1; y < ROWS; y += 1) {
          const position = Math.round(y * cell) + 0.5;
          context.moveTo(0, position);
          context.lineTo(width, position);
        }
        context.stroke();
      }

      function drawCell(context, x, y, color) {
        const px = x * cell;
        const py = y * cell;
        const inset = Math.max(1, cell * 0.08);
        context.fillStyle = color;
        context.fillRect(px + inset, py + inset, cell - inset * 2, cell - inset * 2);
        context.fillStyle = "rgba(255, 255, 255, 0.22)";
        context.fillRect(px + inset, py + inset, cell - inset * 2, Math.max(1, cell * 0.16));
      }

      function drawPreview(node, type) {
        const context = node.getContext("2d");
        const box = MINI_CELL * 4;
        context.clearRect(0, 0, box, box);
        if (!type) return;
        const cells = cellsOf(type, 0);
        let minX = 4;
        let maxX = -1;
        let minY = 4;
        let maxY = -1;
        for (const [x, y] of cells) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
        const offsetX = Math.floor((4 - (maxX - minX + 1)) / 2) - minX;
        const offsetY = Math.floor((4 - (maxY - minY + 1)) / 2) - minY;
        context.fillStyle = colorOf(type);
        for (const [x, y] of cells) {
          context.fillRect((x + offsetX) * MINI_CELL, (y + offsetY) * MINI_CELL, MINI_CELL - 1, MINI_CELL - 1);
        }
      }

      function refreshSide() {
        for (let i = 0; i < previewNodes.length; i += 1) drawPreview(previewNodes[i], queue[i]);
        drawPreview(holdNode, holdType);
      }

      function refreshChips() {
        scoreChip.lastChild.textContent = String(score);
        linesChip.lastChild.textContent = String(lines);
        levelChip.lastChild.textContent = String(level);
      }

      function refreshBest() {
        bestChip.lastChild.textContent = String(Number(ctx.store.get(id, "best", 0)) || 0);
      }

      // ── 尺寸 ─────────────────────────────────────────────────

      function sizeMini(node) {
        const ratio = window.devicePixelRatio || 1;
        const box = MINI_CELL * 4;
        node.style.width = `${box}px`;
        node.style.height = `${box}px`;
        node.width = Math.round(box * ratio);
        node.height = Math.round(box * ratio);
        node.getContext("2d").setTransform(ratio, 0, 0, ratio, 0, 0);
      }

      function sizeCanvas() {
        const ratio = window.devicePixelRatio || 1;
        const width = cell * COLS;
        const height = cell * ROWS;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        canvas.getContext("2d").setTransform(ratio, 0, 0, ratio, 0, 0);
      }

      /** 侧栏放右侧还是棋盘下方，取决于哪种布局能拿到更大的格子。 */
      function relayout() {
        const width = main.clientWidth;
        const height = main.clientHeight;
        if (!width || !height) return;
        const asRow = Math.min((width - SIDE_W) / COLS, height / ROWS);
        const asColumn = Math.min(width / COLS, (height - SIDE_H) / ROWS);
        main.classList.toggle("stacked", asColumn > asRow * 1.06);
        cell = Math.max(10, Math.floor(Math.min(boardWrap.clientWidth / COLS, boardWrap.clientHeight / ROWS)));
        sizeCanvas();
        draw();
      }

      // ── 输入 ─────────────────────────────────────────────────

      function padButton(label, title, action) {
        return MOYU.el("button", {
          type: "button",
          text: label,
          title,
          onclick: (event) => {
            // 交还焦点，随后的空格才会落在游戏（硬降）而不是再点一次按钮
            event.currentTarget.blur();
            action();
          },
        });
      }

      const offKey = ctx.key((event) => {
        const key = event.key;
        if (event.repeat && (key === " " || key === "Shift" || key === "c" || key === "C" || key === "p" || key === "P" || key === "Escape")) {
          return;
        }
        if (key === "ArrowLeft" || key === "a" || key === "A") move(-1);
        else if (key === "ArrowRight" || key === "d" || key === "D") move(1);
        else if (key === "ArrowDown" || key === "s" || key === "S") softDrop();
        else if (key === "ArrowUp" || key === "w" || key === "W" || key === "x" || key === "X") rotatePiece(1);
        else if (key === "z" || key === "Z") rotatePiece(-1);
        else if (key === " ") hardDrop();
        else if (key === "c" || key === "C" || key === "Shift") holdPiece();
        else if (key === "p" || key === "P" || key === "Escape") togglePause();
        else return;
        event.preventDefault();
      });

      const offTheme = ctx.onThemeChange(() => {
        colors = readColors();
        refreshSide();
        draw();
      });

      const observer = new ResizeObserver(() => relayout());
      observer.observe(main);

      const cancelFrame = ctx.frame(tick);

      reset();
      relayout();

      return () => {
        cancelFrame();
        offKey();
        offTheme();
        observer.disconnect();
      };
    },

    hubLine(entry) {
      const best = Number(entry.best) || 0;
      return best > 0 ? `最高 ${best} 分` : "";
    },
  };

  function readColors() {
    const style = getComputedStyle(document.documentElement);
    const value = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    const colors = {
      surface: value("--mg-surface", "#171b22"),
      line: value("--mg-line", "#2a313d"),
      warn: value("--mg-warn", "#f5a524"),
    };
    for (const type of TYPES) colors[type] = value(`--mg-tetris-${type}`, FALLBACK_COLORS[type]);
    return colors;
  }

  MOYU.style(
    "tetris",
    `
    .mg-tetris { flex: 1 1 auto; min-height: 0; width: 100%; display: flex; flex-direction: column; gap: 10px; }
    .mg-tetris-main { flex: 1 1 auto; min-height: 0; display: flex; gap: 10px; align-items: stretch; justify-content: center; }
    .mg-tetris-main.stacked { flex-direction: column; }
    .mg-tetris-boardwrap { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; display: grid; place-items: center; }
    .mg-tetris-canvas {
      display: block;
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-md);
      background: var(--mg-surface);
      touch-action: none;
    }
    .mg-tetris-side { flex: 0 0 auto; min-width: 0; display: flex; flex-direction: column; gap: 10px; align-items: center; }
    .mg-tetris-main.stacked .mg-tetris-side { flex-direction: row; align-items: flex-start; justify-content: center; gap: 16px; }
    .mg-tetris-group { display: grid; gap: 4px; justify-items: center; }
    .mg-tetris-label { font-size: 11px; color: var(--mg-dim); }
    .mg-tetris-previews { display: flex; gap: 6px; }
    .mg-tetris-mini {
      display: block;
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-sm);
      background: var(--mg-surface-2);
    }
    .mg-tetris-pad { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; }
    .mg-tetris-pad button {
      appearance: none;
      min-height: 34px;
      border: 1px solid var(--mg-line);
      background: var(--mg-surface-2);
      color: var(--mg-text);
      border-radius: var(--mg-r-sm);
      font-size: 12px;
      cursor: pointer;
    }
    .mg-tetris-pad button:active { background: var(--mg-accent-soft); }
    .mg-tetris-help { text-align: center; }
    html[data-theme="dark"] {
      --mg-tetris-I: #22d3ee;
      --mg-tetris-O: #f5c518;
      --mg-tetris-T: #a78bfa;
      --mg-tetris-S: #34d399;
      --mg-tetris-Z: #f87171;
      --mg-tetris-J: #60a5fa;
      --mg-tetris-L: #fb923c;
    }
    html[data-theme="light"] {
      --mg-tetris-I: #0e7490;
      --mg-tetris-O: #a16207;
      --mg-tetris-T: #7c3aed;
      --mg-tetris-S: #047857;
      --mg-tetris-Z: #dc2626;
      --mg-tetris-J: #2563eb;
      --mg-tetris-L: #c2410c;
    }
    `,
  );
})();
