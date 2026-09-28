/**
 * 数独 — DOM 网格 + 键盘方案
 *
 * 谜面在本地生成：先随机构造一个合法终盘，再按 180° 对称逐对挖空，每挖一次都重新数解，
 * 保证唯一解；三档难度只差目标题面数（44 / 34 / 26），挖不动就停在能挖到的题面数。
 *
 * 整局进度按两个 81 字符的串存进偏好（`saved.given` 是题面兼掩码、`saved.cells` 是当前盘面），
 * 换视图、关面板、重启宿主都能接着下；一盘下完就把存档清掉。候选数是即时算的视图，不落盘。
 *
 * 只写 8 个偏好键：level / wins / best.easy / best.medium / best.hard / saved.given / saved.cells / saved.level。
 */
(function () {
  "use strict";

  const MOYU = (window.MOYU = window.MOYU || {});
  MOYU.games = MOYU.games || {};

  const GAME_ID = "sudoku";
  const SIZE = 9;
  const CELLS = SIZE * SIZE;
  const ALL_DIGITS = 0b111111111;
  const MAX_UNDO = 100;
  const MIN_CELL_PX = 14;
  const GRID_BORDER_PX = 2;

  /** 目标题面数：数越小越难。挖空受唯一解约束，实际可能略高于目标。 */
  const LEVELS = {
    easy: { label: "简单", givens: 44 },
    medium: { label: "中等", givens: 34 },
    hard: { label: "困难", givens: 26 },
  };
  const LEVEL_IDS = Object.keys(LEVELS);
  const DEFAULT_LEVEL = "easy";

  const BIT_DIGIT = { 1: 1, 2: 2, 4: 3, 8: 4, 16: 5, 32: 6, 64: 7, 128: 8, 256: 9 };

  // ── 格子拓扑（一次算好，之后全是常数） ────────────────────────

  const ROW_OF = new Uint8Array(CELLS);
  const COL_OF = new Uint8Array(CELLS);
  const BOX_OF = new Uint8Array(CELLS);
  const PEER_MATRIX = new Uint8Array(CELLS * CELLS);
  const UNITS = [];

  for (let index = 0; index < CELLS; index += 1) {
    const row = Math.floor(index / SIZE);
    const col = index % SIZE;
    ROW_OF[index] = row;
    COL_OF[index] = col;
    BOX_OF[index] = Math.floor(row / 3) * 3 + Math.floor(col / 3);
  }
  for (let index = 0; index < CELLS; index += 1) {
    for (let other = 0; other < CELLS; other += 1) {
      if (other === index) continue;
      if (ROW_OF[other] === ROW_OF[index] || COL_OF[other] === COL_OF[index] || BOX_OF[other] === BOX_OF[index]) {
        PEER_MATRIX[index * CELLS + other] = 1;
      }
    }
  }
  for (let row = 0; row < SIZE; row += 1) {
    UNITS.push(Array.from({ length: SIZE }, (_, col) => row * SIZE + col));
  }
  for (let col = 0; col < SIZE; col += 1) {
    UNITS.push(Array.from({ length: SIZE }, (_, row) => row * SIZE + col));
  }
  for (let box = 0; box < SIZE; box += 1) {
    const startRow = Math.floor(box / 3) * 3;
    const startCol = (box % 3) * 3;
    const cells = [];
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) cells.push((startRow + row) * SIZE + startCol + col);
    }
    UNITS.push(cells);
  }

  // ── 纯逻辑：不碰 DOM、不碰偏好 ────────────────────────────────

  function shuffle(list, random) {
    for (let index = list.length - 1; index > 0; index -= 1) {
      const pick = Math.floor(random() * (index + 1));
      const temporary = list[index];
      list[index] = list[pick];
      list[pick] = temporary;
    }
    return list;
  }

  function digitCount(mask) {
    let bits = 0;
    for (let rest = mask; rest; rest &= rest - 1) bits += 1;
    return bits;
  }

  /**
   * 数解：最多数到 limit 就收手（判唯一解只需要 limit = 2）。
   * 返回 { count, solution }，solution 是找到的第一个解（没有则为 null）。
   */
  function countSolutions(grid, limit, random) {
    const rows = new Uint16Array(SIZE);
    const cols = new Uint16Array(SIZE);
    const boxes = new Uint16Array(SIZE);
    const work = new Uint8Array(CELLS);

    for (let index = 0; index < CELLS; index += 1) {
      const digit = Number(grid[index]) || 0;
      if (digit < 1 || digit > 9) continue;
      const bit = 1 << (digit - 1);
      if ((rows[ROW_OF[index]] & bit) || (cols[COL_OF[index]] & bit) || (boxes[BOX_OF[index]] & bit)) {
        return { count: 0, solution: null }; // 题面自相矛盾
      }
      rows[ROW_OF[index]] |= bit;
      cols[COL_OF[index]] |= bit;
      boxes[BOX_OF[index]] |= bit;
      work[index] = digit;
    }

    let count = 0;
    let solution = null;

    function search() {
      // MRV：挑候选最少的空格先试，数解速度差在这里
      let target = -1;
      let targetMask = 0;
      let fewest = 10;
      for (let index = 0; index < CELLS; index += 1) {
        if (work[index]) continue;
        const mask = ALL_DIGITS & ~(rows[ROW_OF[index]] | cols[COL_OF[index]] | boxes[BOX_OF[index]]);
        const bits = digitCount(mask);
        if (bits === 0) return; // 这条分支死了
        if (bits < fewest) {
          fewest = bits;
          target = index;
          targetMask = mask;
          if (bits === 1) break;
        }
      }
      if (target < 0) {
        count += 1;
        if (!solution) solution = Array.from(work);
        return;
      }
      const choices = [];
      for (let mask = targetMask; mask; mask &= mask - 1) {
        const bit = mask & -mask;
        choices.push(BIT_DIGIT[bit]);
      }
      if (typeof random === "function") shuffle(choices, random);
      for (const digit of choices) {
        const bit = 1 << (digit - 1);
        work[target] = digit;
        rows[ROW_OF[target]] |= bit;
        cols[COL_OF[target]] |= bit;
        boxes[BOX_OF[target]] |= bit;
        search();
        rows[ROW_OF[target]] &= ~bit;
        cols[COL_OF[target]] &= ~bit;
        boxes[BOX_OF[target]] &= ~bit;
        work[target] = 0;
        if (count >= limit) return;
      }
    }

    search();
    return { count, solution };
  }

  /** 随机构造一个合法终盘（按格子顺序回溯，只把候选顺序打乱）。 */
  function generateSolution(random) {
    const grid = new Array(CELLS).fill(0);
    const rows = new Uint16Array(SIZE);
    const cols = new Uint16Array(SIZE);
    const boxes = new Uint16Array(SIZE);

    function fill(index) {
      if (index === CELLS) return true;
      const row = ROW_OF[index];
      const col = COL_OF[index];
      const box = BOX_OF[index];
      const mask = ALL_DIGITS & ~(rows[row] | cols[col] | boxes[box]);
      const choices = [];
      for (let bit = 1; bit <= 256; bit <<= 1) {
        if (mask & bit) choices.push(BIT_DIGIT[bit]);
      }
      shuffle(choices, random);
      for (const digit of choices) {
        const bit = 1 << (digit - 1);
        grid[index] = digit;
        rows[row] |= bit;
        cols[col] |= bit;
        boxes[box] |= bit;
        if (fill(index + 1)) return true;
        grid[index] = 0;
        rows[row] &= ~bit;
        cols[col] &= ~bit;
        boxes[box] &= ~bit;
      }
      return false;
    }

    fill(0);
    return grid;
  }

  /**
   * 生成一局：终盘 + 180° 对称挖空，每对挖完都要唯一解才留下。
   * 一轮挖不到目标题面数就再扫一轮（最多 3 轮），还挖不动就停。
   */
  function generatePuzzle(levelId, random = Math.random) {
    const config = LEVELS[levelId] || LEVELS[DEFAULT_LEVEL];
    const solution = generateSolution(random);
    const puzzle = solution.slice();
    let givens = CELLS;

    for (let pass = 0; pass < 3 && givens > config.givens; pass += 1) {
      const order = shuffle(Array.from({ length: CELLS }, (_, index) => index), random);
      let removed = 0;
      for (const index of order) {
        if (givens - 2 < config.givens) break;
        const mirror = CELLS - 1 - index;
        const targets = index === mirror ? [index] : [index, mirror];
        if (targets.some((cell) => puzzle[cell] === 0)) continue;
        const backup = targets.map((cell) => puzzle[cell]);
        for (const cell of targets) puzzle[cell] = 0;
        if (countSolutions(puzzle, 2).count !== 1) {
          targets.forEach((cell, position) => {
            puzzle[cell] = backup[position];
          });
          continue;
        }
        givens -= targets.length;
        removed += targets.length;
      }
      if (removed === 0) break;
    }

    return { puzzle, solution, givens };
  }

  /** 与同行/同列/同宫重复的格子（重复的两边都会标记）。 */
  function conflictsOf(grid) {
    const flags = new Uint8Array(CELLS);
    for (const unit of UNITS) {
      const seen = new Map();
      for (const index of unit) {
        const digit = grid[index];
        if (!digit) continue;
        const list = seen.get(digit);
        if (list) list.push(index);
        else seen.set(digit, [index]);
      }
      for (const list of seen.values()) {
        if (list.length < 2) continue;
        for (const index of list) flags[index] = 1;
      }
    }
    return flags;
  }

  function candidatesOf(grid, index) {
    if (grid[index]) return [];
    let used = 0;
    for (let other = 0; other < CELLS; other += 1) {
      if (!PEER_MATRIX[index * CELLS + other]) continue;
      const digit = grid[other];
      if (digit) used |= 1 << (digit - 1);
    }
    const list = [];
    for (let bit = 1; bit <= 256; bit <<= 1) {
      if (!(used & bit)) list.push(BIT_DIGIT[bit]);
    }
    return list;
  }

  function isSolved(grid, conflicts) {
    const flags = conflicts || conflictsOf(grid);
    for (let index = 0; index < CELLS; index += 1) {
      if (!grid[index] || flags[index]) return false;
    }
    return true;
  }

  function serialize(grid) {
    let text = "";
    for (let index = 0; index < CELLS; index += 1) text += String(Number(grid[index]) || 0);
    return text;
  }

  function parseBoard(text) {
    if (typeof text !== "string" || text.length !== CELLS) return null;
    const grid = new Array(CELLS).fill(0);
    for (let index = 0; index < CELLS; index += 1) {
      const code = text.charCodeAt(index) - 48;
      if (code < 0 || code > 9) return null;
      grid[index] = code;
    }
    return grid;
  }

  function fmtTime(ms) {
    const total = Math.max(0, Math.floor(Number(ms) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  // ── 样式 ────────────────────────────────────────────────────

  MOYU.style(
    GAME_ID,
    `
    .mg-sd-wrap { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; width: 100%; }
    .mg-sd-bar { flex: none; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .mg-sd-tools { flex: none; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .mg-sd-tools .mg-btn { justify-content: center; }
    .mg-sd-board { flex: 1 1 auto; min-height: 0; display: grid; place-items: center; overflow: auto; overscroll-behavior: contain; }

    .mg-sd-grid {
      display: grid;
      grid-template-columns: repeat(9, var(--mg-sd-cell));
      width: max-content;
      border: 2px solid var(--mg-rule-ink);
      border-radius: var(--mg-r-sm);
      background: var(--mg-surface);
    }
    .mg-sd-cell {
      appearance: none;
      box-sizing: border-box;
      width: var(--mg-sd-cell);
      height: var(--mg-sd-cell);
      margin: 0;
      padding: 0;
      display: grid;
      place-items: center;
      border: 0;
      border-right: 1px solid var(--mg-line);
      border-bottom: 1px solid var(--mg-line);
      background: var(--mg-surface);
      color: var(--mg-accent);
      font: 600 calc(var(--mg-sd-cell) * 0.52)/1 var(--mg-mono);
      cursor: pointer;
      user-select: none;
    }
    .mg-sd-cell.box-r { border-right: 2px solid var(--mg-rule-ink); }
    .mg-sd-cell.box-b { border-bottom: 2px solid var(--mg-rule-ink); }
    .mg-sd-cell.edge-r { border-right: 0; }
    .mg-sd-cell.edge-b { border-bottom: 0; }
    .mg-sd-cell.given { background: var(--mg-surface-2); color: var(--mg-text); font-weight: 650; }
    .mg-sd-cell.peer { background: var(--mg-accent-soft); }
    .mg-sd-cell.same { background: var(--mg-accent-soft); box-shadow: inset 0 0 0 1px var(--mg-accent); }
    .mg-sd-cell.is-selected { background: var(--mg-accent-soft); box-shadow: inset 0 0 0 2px var(--mg-accent); }
    .mg-sd-cell.clash { color: var(--mg-sd-clash); }
    .mg-sd-cands { display: grid; grid-template-columns: repeat(3, 1fr); width: 100%; height: 100%; color: var(--mg-sd-ghost); font: 500 calc(var(--mg-sd-cell) * 0.27)/1 var(--mg-mono); }
    .mg-sd-cands i { display: grid; place-items: center; font-style: normal; }

    .mg-sd-pad { flex: none; display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px; }
    .mg-sd-key { appearance: none; display: grid; gap: 1px; place-items: center; padding: 6px 2px; border: 1px solid var(--mg-line); border-radius: var(--mg-r-sm); background: var(--mg-surface); color: var(--mg-text); font: 600 15px/1 var(--mg-mono); cursor: pointer; }
    .mg-sd-key small { font: 500 9.5px/1 var(--mg-mono); color: var(--mg-dim); }
    .mg-sd-key.spent { background: var(--mg-surface-2); border-style: dashed; border-color: var(--mg-dim); }
    .mg-sd-key.spent small { color: var(--mg-text); }
    .mg-sd-key:hover { background: var(--mg-mark); border-color: var(--mg-rule-ink); }
    .mg-sd-key:active { transform: translateY(1px); }
    `,
  );

  /** 顶栏「重开」拿到的回调：挂载时接管，卸载时交回。 */
  let requestNewPuzzle = null;

  MOYU.games[GAME_ID] = {
    id: GAME_ID,
    name: "数独",
    tagline: "每行每列每宫都是 1-9",
    emoji: "🧩",
    order: 7,

    mount(root, ctx) {
      const id = ctx.gameId;
      const storedLevel = String(ctx.store.get(id, "level", DEFAULT_LEVEL));
      let levelId = LEVELS[storedLevel] ? storedLevel : DEFAULT_LEVEL;

      let puzzle = [];
      let board = [];
      let solution = [];
      let selected = -1;
      let candidatesOn = false;
      let hints = 0;
      let started = false;
      let startedAt = 0;
      let elapsed = 0;
      let over = false;
      let timerHooked = false;
      const undoStack = [];

      // ── DOM ──────────────────────────────────────────────────
      const timeChip = MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: "用时" }), "0:00");
      const levelButtons = new Map();
      const levelSeg = MOYU.el(
        "div",
        { class: "mg-seg", role: "group", "aria-label": "难度" },
        ...LEVEL_IDS.map((key) => {
          const button = MOYU.el("button", {
            type: "button",
            text: LEVELS[key].label,
            "aria-pressed": String(key === levelId),
            onclick: () => selectLevel(key),
          });
          levelButtons.set(key, button);
          return button;
        }),
      );

      const hintBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "提示", onclick: () => useHint() });
      const undoBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "撤销", onclick: () => undo() });
      const candidatesBtn = MOYU.el("button", {
        class: "mg-btn",
        type: "button",
        text: "候选",
        title: "显示每格的候选数",
        "aria-pressed": "false",
        onclick: () => toggleCandidates(),
      });

      const grid = MOYU.el("div", { class: "mg-sd-grid", role: "grid", "aria-label": "数独盘面" });
      const buttons = [];
      for (let index = 0; index < CELLS; index += 1) {
        const classes = ["mg-sd-cell"];
        if (COL_OF[index] % 3 === 2 && COL_OF[index] !== SIZE - 1) classes.push("box-r");
        if (ROW_OF[index] % 3 === 2 && ROW_OF[index] !== SIZE - 1) classes.push("box-b");
        if (COL_OF[index] === SIZE - 1) classes.push("edge-r");
        if (ROW_OF[index] === SIZE - 1) classes.push("edge-b");
        const button = MOYU.el("button", {
          class: classes.join(" "),
          type: "button",
          dataset: { index: String(index) },
          "aria-label": "空格",
          onclick: () => select(index),
        });
        buttons.push(button);
        grid.append(button);
      }
      const boardWrap = MOYU.el("div", { class: "mg-sd-board" }, grid);

      const padKeys = [];
      for (let digit = 1; digit <= 9; digit += 1) {
        const label = MOYU.el("span", { text: String(digit) });
        const rest = MOYU.el("small", { text: "9" });
        const key = MOYU.el(
          "button",
          { class: "mg-sd-key", type: "button", "aria-label": `填入 ${digit}`, onclick: () => putDigit(digit) },
          label,
          rest,
        );
        padKeys.push({ digit, key, rest });
      }
      const eraseKey = MOYU.el(
        "button",
        { class: "mg-sd-key", type: "button", "aria-label": "擦掉这一格", onclick: () => putDigit(0) },
        MOYU.el("span", { text: "⌫" }),
        MOYU.el("small", { text: "擦掉" }),
      );
      const pad = MOYU.el("div", { class: "mg-sd-pad" }, ...padKeys.map((entry) => entry.key), eraseKey);

      const overlay = MOYU.el("div", { class: "mg-overlay", hidden: true });
      const overlayBody = MOYU.el("div", { class: "mg-panel" });
      overlay.append(overlayBody);

      const wrap = MOYU.el("div", { class: "mg-sd-wrap" });
      wrap.append(
        MOYU.el(
          "div",
          { class: "mg-sd-bar" },
          levelSeg,
          MOYU.el("div", { class: "mg-spacer" }),
          timeChip,
        ),
        MOYU.el("div", { class: "mg-sd-tools" }, hintBtn, undoBtn, candidatesBtn),
        boardWrap,
        pad,
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
        ctx.store.set(id, "level", levelId);
        ctx.store.set(id, "saved.given", serialize(puzzle));
        ctx.store.set(id, "saved.cells", serialize(board));
        ctx.store.set(id, "saved.level", levelId);
      }

      function clearSave() {
        ctx.store.set(id, "saved.given", "");
        ctx.store.set(id, "saved.cells", "");
        ctx.store.set(id, "saved.level", levelId);
      }

      function install(fresh) {
        puzzle = fresh.puzzle;
        board = fresh.puzzle.slice();
        solution = fresh.solution;
        selected = -1;
        hints = 0;
        started = false;
        over = false;
        elapsed = 0;
        undoStack.length = 0;
        timeChip.lastChild.textContent = "0:00";
        overlay.hidden = true;
        for (const [key, button] of levelButtons) {
          button.setAttribute("aria-pressed", String(key === levelId));
        }
        save();
        commit();
      }

      function newPuzzle(nextLevelId) {
        if (nextLevelId && LEVELS[nextLevelId]) levelId = nextLevelId;
        install(generatePuzzle(levelId));
      }

      /** 读回上次的存档：题面唯一解 + 题面与盘面自洽，否则当作没有。 */
      function restore() {
        const savedPuzzle = parseBoard(String(ctx.store.get(id, "saved.given", "")));
        const savedBoard = parseBoard(String(ctx.store.get(id, "saved.cells", "")));
        if (!savedPuzzle || !savedBoard) return false;
        if (!savedPuzzle.some((digit) => digit !== 0)) return false;
        for (let index = 0; index < CELLS; index += 1) {
          if (savedPuzzle[index] !== 0 && savedBoard[index] !== savedPuzzle[index]) savedBoard[index] = savedPuzzle[index];
        }
        if (isSolved(savedBoard)) return false;
        const counted = countSolutions(savedPuzzle, 2);
        if (counted.count !== 1 || !counted.solution) return false;
        const savedLevel = String(ctx.store.get(id, "saved.level", ""));
        levelId = LEVELS[savedLevel] ? savedLevel : levelId;
        puzzle = savedPuzzle;
        board = savedBoard;
        solution = counted.solution;
        selected = -1;
        hints = 0;
        started = false;
        over = false;
        elapsed = 0;
        undoStack.length = 0;
        timeChip.lastChild.textContent = "0:00";
        for (const [key, button] of levelButtons) {
          button.setAttribute("aria-pressed", String(key === levelId));
        }
        save();
        commit();
        ctx.toast("接着上次的局");
        return true;
      }

      // ── 操作 ─────────────────────────────────────────────────

      function selectLevel(nextLevelId) {
        if (!LEVELS[nextLevelId] || nextLevelId === levelId) return;
        newPuzzle(nextLevelId);
      }

      function select(index) {
        if (over) return;
        selected = index;
        paint();
      }

      function putDigit(digit) {
        if (over) return;
        if (selected < 0) {
          ctx.toast("先点一格");
          return;
        }
        if (puzzle[selected] !== 0) {
          ctx.toast("题面的数字不能改");
          return;
        }
        if (board[selected] === digit) return;
        const previous = board[selected];
        board[selected] = digit;
        undoStack.push({ index: selected, previous });
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        if (!started && digit !== 0) startTimer();
        save();
        commit();
      }

      function undo() {
        if (over) return;
        const move = undoStack.pop();
        if (!move) {
          ctx.toast("没有可撤销的步骤");
          return;
        }
        board[move.index] = move.previous;
        selected = move.index;
        save();
        commit();
      }

      function toggleCandidates() {
        candidatesOn = !candidatesOn;
        candidatesBtn.setAttribute("aria-pressed", String(candidatesOn));
        paint();
      }

      /** 提示：优先填当前选中格，否则挑候选最少的空格（最难的那一格）。 */
      function useHint() {
        if (over) return;
        let target = selected >= 0 && board[selected] === 0 ? selected : -1;
        if (target < 0) {
          let fewest = 10;
          for (let index = 0; index < CELLS; index += 1) {
            if (board[index]) continue;
            const count = candidatesOf(board, index).length;
            if (count < fewest) {
              fewest = count;
              target = index;
            }
          }
        }
        if (target < 0) {
          ctx.toast("盘面已经填满");
          return;
        }
        const digit = solution[target];
        if (!digit) return;
        if (!started) startTimer();
        undoStack.push({ index: target, previous: board[target] });
        board[target] = digit;
        hints += 1;
        selected = target;
        save();
        commit();
        ctx.toast(`提示：这里填 ${digit}`);
      }

      function showOverlay(title, text) {
        overlayBody.replaceChildren(
          MOYU.el("div", { class: "mg-panel-title", text: title }),
          MOYU.el("div", { class: "mg-panel-text", text }),
          MOYU.el(
            "div",
            { class: "mg-panel-actions" },
            MOYU.el("button", { class: "mg-btn primary", type: "button", text: "再来一局", onclick: () => newPuzzle() }),
            MOYU.el("button", { class: "mg-btn", type: "button", text: "看看盘面", onclick: () => { overlay.hidden = true; } }),
          ),
        );
        overlay.hidden = false;
      }

      function checkWin(conflicts) {
        if (over || !isSolved(board, conflicts)) return;
        stopTimer();
        timeChip.lastChild.textContent = fmtTime(elapsed);
        const key = `best.${levelId}`;
        const previous = Number(ctx.store.get(id, key, 0)) || 0;
        const broke = previous === 0 || elapsed < previous;
        if (broke) ctx.store.set(id, key, elapsed);
        ctx.store.bump(id, "wins");
        clearSave();
        paint();
        showOverlay(
          broke ? "新纪录！" : "完成",
          `用时 ${fmtTime(elapsed)} · ${LEVELS[levelId].label}${hints > 0 ? ` · 提示 ${hints} 次` : ""}${broke ? "" : ` · 历史最佳 ${fmtTime(previous)}`}`,
        );
      }

      // ── 渲染 ─────────────────────────────────────────────────

      function commit() {
        const conflicts = paint();
        refreshPad();
        checkWin(conflicts);
      }

      function paint() {
        const conflicts = conflictsOf(board);
        const selectedDigit = selected >= 0 ? board[selected] : 0;
        for (let index = 0; index < CELLS; index += 1) {
          const button = buttons[index];
          const value = board[index];
          const isGiven = puzzle[index] !== 0;
          let classes = button.dataset.base;
          if (isGiven) classes += " given";
          if (selected >= 0 && !over) {
            if (index === selected) classes += " is-selected";
            else if (PEER_MATRIX[selected * CELLS + index]) classes += " peer";
            if (selectedDigit && value === selectedDigit && index !== selected) classes += " same";
          }
          if (conflicts[index]) classes += " clash";
          button.className = classes;

          if (value) {
            button.textContent = String(value);
            button.setAttribute(
              "aria-label",
              `${isGiven ? "题面" : "填入"} ${value}，第 ${ROW_OF[index] + 1} 行第 ${COL_OF[index] + 1} 列${conflicts[index] ? "，与同行同列或同宫重复" : ""}`,
            );
          } else if (candidatesOn) {
            const list = candidatesOf(board, index);
            const marks = [];
            for (let digit = 1; digit <= 9; digit += 1) {
              marks.push(MOYU.el("i", { text: list.includes(digit) ? String(digit) : "" }));
            }
            button.replaceChildren(MOYU.el("span", { class: "mg-sd-cands" }, ...marks));
            button.setAttribute("aria-label", `空格，候选 ${list.length ? list.join(" ") : "无"}`);
          } else {
            button.textContent = "";
            button.setAttribute("aria-label", "空格");
          }
        }
        return conflicts;
      }

      function refreshPad() {
        const counts = new Array(10).fill(0);
        for (let index = 0; index < CELLS; index += 1) {
          const digit = board[index];
          if (digit) counts[digit] += 1;
        }
        for (const entry of padKeys) {
          const rest = Math.max(0, 9 - counts[entry.digit]);
          entry.rest.textContent = String(rest);
          entry.key.classList.toggle("spent", rest === 0);
        }
      }

      /** 盘面越大越好，但要在面板里同时容下工具条与数字键，所以宽高取小者。 */
      function fitGrid() {
        const width = Math.max(120, boardWrap.clientWidth);
        const height = Math.max(120, boardWrap.clientHeight);
        const inner = Math.min(width, height) - GRID_BORDER_PX * 2;
        grid.style.setProperty("--mg-sd-cell", `${Math.max(MIN_CELL_PX, Math.floor(inner / SIZE))}px`);
      }

      // 每格的「底座」类名（含宫线），重绘时在它后面追加状态类
      for (let index = 0; index < CELLS; index += 1) {
        buttons[index].dataset.base = buttons[index].className;
      }

      const offKey = ctx.key((event) => {
        if (event.ctrlKey || event.metaKey) {
          if (event.key === "z" || event.key === "Z") {
            event.preventDefault();
            undo();
          }
          return;
        }
        const key = event.key;
        if (key >= "1" && key <= "9") {
          event.preventDefault();
          putDigit(Number(key));
          return;
        }
        if (key === "0" || key === "Backspace" || key === "Delete") {
          event.preventDefault();
          putDigit(0);
          return;
        }
        if (key === "h" || key === "H") {
          event.preventDefault();
          useHint();
          return;
        }
        let row = selected >= 0 ? ROW_OF[selected] : 0;
        let col = selected >= 0 ? COL_OF[selected] : 0;
        let moved = false;
        if (key === "ArrowUp" || key === "w" || key === "W") {
          row = Math.max(0, row - 1);
          moved = true;
        } else if (key === "ArrowDown" || key === "s" || key === "S") {
          row = Math.min(SIZE - 1, row + 1);
          moved = true;
        } else if (key === "ArrowLeft" || key === "a" || key === "A") {
          col = Math.max(0, col - 1);
          moved = true;
        } else if (key === "ArrowRight" || key === "d" || key === "D") {
          col = Math.min(SIZE - 1, col + 1);
          moved = true;
        }
        if (!moved) return;
        event.preventDefault();
        select(row * SIZE + col);
      });

      const observer = new ResizeObserver(() => fitGrid());
      observer.observe(boardWrap);

      requestNewPuzzle = () => newPuzzle();

      fitGrid();
      if (!restore()) install(generatePuzzle(levelId));

      return () => {
        requestNewPuzzle = null;
        offKey();
        observer.disconnect();
      };
    },

    restart() {
      if (typeof requestNewPuzzle === "function") requestNewPuzzle();
    },

    hubLine(entry) {
      const source = entry && typeof entry === "object" ? entry : {};
      const wins = Math.max(0, Math.floor(Number(source.wins) || 0));
      if (wins <= 0) return "";
      const levelId = LEVELS[String(source.level)] ? String(source.level) : DEFAULT_LEVEL;
      const best = Math.max(0, Math.floor(Number(source[`best.${levelId}`]) || 0));
      return best > 0 ? `${wins} 胜 · ${LEVELS[levelId].label} ${fmtTime(best)}` : `${wins} 胜`;
    },

    _logic: {
      LEVELS,
      LEVEL_IDS,
      SIZE,
      CELLS,
      countSolutions,
      generateSolution,
      generatePuzzle,
      conflictsOf,
      candidatesOf,
      isSolved,
      serialize,
      parseBoard,
      fmtTime,
      shuffle,
      ROW_OF,
      COL_OF,
      BOX_OF,
    },
  };
})();
