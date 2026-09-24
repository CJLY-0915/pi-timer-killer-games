/**
 * 扫雷 — DOM 网格方案范例
 *
 * 首击必安全（点击后再布雷，并排除点击点及其八邻域，保证第一下一定能展开一片）。
 * 左键展开、右键循环 插旗 → 问号 → 空、数字格上中键/双击 = 周围插旗数足够时一并展开。
 * 计时器在首次展开时启动；只有胜利才记最佳用时（按难度分别记）。
 */
(function () {
  "use strict";
  const MOYU = (window.MOYU = window.MOYU || {});
  MOYU.games = MOYU.games || {};

  const LEVELS = {
    beginner: { label: "初级", cols: 9, rows: 9, mines: 10 },
    intermediate: { label: "中级", cols: 16, rows: 16, mines: 40 },
    expert: { label: "高级", cols: 30, rows: 16, mines: 99 },
  };

  MOYU.style(
    "minesweeper",
    `
    .mg-ms { display: grid; gap: 10px; width: 100%; }
    .mg-ms-board {
      overflow: auto;
      max-width: 100%;
      padding: 6px;
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-md);
      background: var(--mg-surface);
    }
    .mg-ms-grid {
      display: grid;
      grid-template-columns: repeat(var(--ms-cols), var(--ms-cell));
      gap: 2px;
      margin: 0 auto;
      width: max-content;
    }
    .mg-ms-cell {
      appearance: none;
      width: var(--ms-cell);
      height: var(--ms-cell);
      padding: 0;
      border: 1px solid var(--mg-line);
      border-radius: 3px;
      background: var(--mg-surface-2);
      color: var(--mg-text);
      font: 600 calc(var(--ms-cell) * 0.56)/1 var(--mg-mono);
      display: grid;
      place-items: center;
      cursor: pointer;
      user-select: none;
    }
    .mg-ms-cell:hover:not(.open) { border-color: var(--mg-accent); }
    .mg-ms-cell.open {
      background: color-mix(in oklab, var(--mg-bg) 70%, var(--mg-surface));
      border-color: color-mix(in oklab, var(--mg-line) 60%, transparent);
      cursor: default;
    }
    .mg-ms-cell.boom { background: var(--mg-bad); border-color: var(--mg-bad); color: #fff; }
    .mg-ms-cell.flag { color: var(--mg-bad); }
    .mg-ms-cell.unsure { color: var(--mg-warn); }
    .mg-ms-cell.wrong { color: var(--mg-bad); }
    .mg-ms-cell.n1 { color: #3b82f6; }
    .mg-ms-cell.n2 { color: #22a06b; }
    .mg-ms-cell.n3 { color: #e5484d; }
    .mg-ms-cell.n4 { color: #8e6bd8; }
    .mg-ms-cell.n5 { color: #d97706; }
    .mg-ms-cell.n6 { color: #0ea5a5; }
    .mg-ms-cell.n7 { color: var(--mg-ms-n7); }
    .mg-ms-cell.n8 { color: var(--mg-dim); }
    html[data-theme="dark"] { --mg-ms-n7: #d5dbe3; }
    html[data-theme="light"] { --mg-ms-n7: #243040; }
    `,
  );

  MOYU.games.minesweeper = {
    id: "minesweeper",
    name: "扫雷",
    tagline: "数字是身边的雷数",
    emoji: "💣",
    order: 1,

    mount(root, ctx) {
      const id = ctx.gameId;
      let levelId = String(ctx.store.get(id, "level", "beginner"));
      const level = LEVELS[levelId] ? levelId : "beginner";

      let cells = [];
      let buttons = [];
      let started = false;
      let over = false;
      let unmounted = false;
      let flags = 0;
      let opened = 0;
      let startedAt = 0;
      let elapsed = 0;

      const mineChip = MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: "剩余" }), "0");
      const timeChip = MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: "用时" }), "0″");
      const faceBtn = MOYU.el("button", { class: "mg-btn icon", type: "button", text: "🙂", title: "重新开始" });
      const overlay = MOYU.el("div", { class: "mg-overlay", hidden: true });
      const overlayBody = MOYU.el("div", { class: "mg-panel" });
      overlay.append(overlayBody);

      const levelSeg = MOYU.el(
        "div",
        { class: "mg-seg", role: "group", "aria-label": "难度" },
        ...Object.entries(LEVELS).map(([key, entry]) =>
          MOYU.el("button", {
            type: "button",
            "aria-pressed": String(key === level),
            text: entry.label,
            onclick: () => {
              ctx.store.set(id, "level", key);
              for (const button of levelSeg.querySelectorAll("button")) {
                button.setAttribute("aria-pressed", String(button.textContent === entry.label));
              }
              reset(key);
            },
          }),
        ),
      );

      const board = MOYU.el("div", { class: "mg-ms-board" });
      const grid = MOYU.el("div", { class: "mg-ms-grid", role: "grid", "aria-label": "扫雷棋盘" });
      board.append(grid);

      const bar = MOYU.el(
        "div",
        { class: "mg-game-bar" },
        faceBtn,
        MOYU.el("div", { class: "mg-chips" }, mineChip, timeChip),
        MOYU.el("div", { class: "mg-spacer" }),
        levelSeg,
      );

      const shell = MOYU.el("div", { class: "mg-ms" });
      shell.append(bar, board);
      root.append(shell, overlay);

      faceBtn.addEventListener("click", () => reset(levelId));

      // ── 局面 ─────────────────────────────────────────────────

      function currentLevel() {
        return LEVELS[String(ctx.store.get(id, "level", "beginner"))] || LEVELS.beginner;
      }

      function reset(nextLevelId) {
        const config = LEVELS[nextLevelId] || currentLevel();
        levelId = nextLevelId && LEVELS[nextLevelId] ? nextLevelId : levelId;
        const total = config.cols * config.rows;
        cells = new Array(total).fill(null).map(() => ({
          mine: false,
          open: false,
          flag: 0, // 0 无 / 1 旗 / 2 问号
          count: 0,
        }));
        buttons = new Array(total).fill(null);
        flags = 0;
        opened = 0;
        started = false;
        over = false;

        elapsed = 0;
        startedAt = 0;
        faceBtn.textContent = "🙂";
        overlay.hidden = true;
        buildGrid(config);
        refreshChips();
      }

      function buildGrid(config) {
        grid.style.setProperty("--ms-cols", String(config.cols));
        MOYU.clear(grid);
        const available = Math.max(160, board.clientWidth - 16);
        const cell = Math.max(16, Math.min(34, Math.floor(available / config.cols)));
        grid.style.setProperty("--ms-cell", `${cell}px`);

        for (let index = 0; index < cells.length; index += 1) {
          const button = MOYU.el("button", {
            class: "mg-ms-cell",
            type: "button",
            dataset: { index: String(index) },
            "aria-label": "未翻开",
          });
          button.addEventListener("click", (event) => {
            event.preventDefault();
            onPrimary(index);
          });
          button.addEventListener("dblclick", (event) => {
            event.preventDefault();
            onChord(index);
          });
          button.addEventListener("auxclick", (event) => {
            if (event.button === 1) {
              event.preventDefault();
              onChord(index);
            }
          });
          button.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            onSecondary(index);
          });
          attachLongPress(button, index);
          buttons[index] = button;
          grid.append(button);
        }
      }

      function fitBoard() {
        const config = currentLevel();
        const available = Math.max(160, board.clientWidth - 16);
        const cell = Math.max(16, Math.min(34, Math.floor(available / config.cols)));
        grid.style.setProperty("--ms-cell", `${cell}px`);
      }

      // ── 交互 ─────────────────────────────────────────────────

      function neighbors(index) {
        const config = currentLevel();
        const x = index % config.cols;
        const y = Math.floor(index / config.cols);
        const result = [];
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= config.cols || ny >= config.rows) continue;
            result.push(ny * config.cols + nx);
          }
        }
        return result;
      }

      function plant(safeIndex) {
        const config = currentLevel();
        const forbidden = new Set([safeIndex, ...neighbors(safeIndex)]);
        const candidates = [];
        for (let index = 0; index < cells.length; index += 1) {
          if (!forbidden.has(index)) candidates.push(index);
        }
        // Fisher-Yates：只取前 mines 个，避免整表打乱的额外开销
        for (let i = 0; i < config.mines && i < candidates.length; i += 1) {
          const pick = i + Math.floor(Math.random() * (candidates.length - i));
          const tmp = candidates[i];
          candidates[i] = candidates[pick];
          candidates[pick] = tmp;
          cells[candidates[i]].mine = true;
        }
        for (let index = 0; index < cells.length; index += 1) {
          cells[index].count = neighbors(index).filter((n) => cells[n].mine).length;
        }
      }

      function onPrimary(index) {
        if (over) return;
        const cell = cells[index];
        if (cell.flag === 1) return;
        if (cell.open) {
          onChord(index);
          return;
        }
        if (!started) {
          started = true;
          startedAt = Date.now();
          plant(index);
          startTimer();
        }
        if (cell.mine) {
          lose(index);
          return;
        }
        flood(index);
        paintAll();
        checkWin();
      }

      function onSecondary(index) {
        if (over) return;
        const cell = cells[index];
        if (cell.open) return;
        cell.flag = (cell.flag + 1) % 3;
        if (cell.flag === 1) flags += 1;
        if (cell.flag === 2) flags -= 1;
        paintCell(index);
        refreshChips();
      }

      function onChord(index) {
        if (over || !started) return;
        const cell = cells[index];
        if (!cell.open || cell.count === 0) return;
        const around = neighbors(index);
        const marked = around.filter((n) => cells[n].flag === 1).length;
        if (marked !== cell.count) return;
        for (const n of around) {
          if (cells[n].flag === 1 || cells[n].open) continue;
          if (cells[n].mine) {
            lose(n);
            return;
          }
          flood(n);
        }
        paintAll();
        checkWin();
      }

      function flood(start) {
        const stack = [start];
        while (stack.length) {
          const index = stack.pop();
          const cell = cells[index];
          if (cell.open || cell.flag === 1) continue;
          cell.open = true;
          cell.flag = 0;
          opened += 1;
          if (cell.count === 0) {
            for (const n of neighbors(index)) {
              if (!cells[n].open && !cells[n].mine) stack.push(n);
            }
          }
        }
      }

      function lose(boomIndex) {
        over = true;

        faceBtn.textContent = "😵";
        stopTimer();
        for (let index = 0; index < cells.length; index += 1) {
          const cell = cells[index];
          if (cell.mine && cell.flag !== 1) cell.open = true;
          // 插错的旗单独标记成 ✗，让玩家看见自己错在哪
          if (!cell.mine && cell.flag === 1) cell.flag = 3;
        }
        paintAll();
        const button = buttons[boomIndex];
        if (button) button.classList.add("boom");
        showOverlay("踩雷了", "再试一次，第一下永远安全");
      }

      function checkWin() {
        const config = currentLevel();
        if (opened < config.cols * config.rows - config.mines) return;
        over = true;

        faceBtn.textContent = "😎";
        stopTimer();
        const key = `best.${levelId}`;
        const previous = Number(ctx.store.get(id, key, 0)) || 0;
        const broke = previous === 0 || elapsed < previous;
        if (broke) ctx.store.set(id, key, elapsed);
        ctx.store.bump(id, "wins");
        paintAll();
        showOverlay(
          broke ? "新纪录！" : "全部扫清",
          `用时 ${Math.round(elapsed / 1000)} 秒${broke ? "" : ` · 历史最佳 ${Math.round(previous / 1000)} 秒`}`,
        );
      }

      function showOverlay(title, text) {
        overlayBody.replaceChildren(
          MOYU.el("div", { class: "mg-panel-title", text: title }),
          MOYU.el("div", { class: "mg-panel-text", text }),
          MOYU.el(
            "div",
            { class: "mg-panel-actions" },
            MOYU.el("button", { class: "mg-btn primary", type: "button", text: "再来一局", onclick: () => reset() }),
          ),
        );
        overlay.hidden = false;
      }

      // ── 渲染 ─────────────────────────────────────────────────

      function paintCell(index) {
        const cell = cells[index];
        const button = buttons[index];
        if (!button) return;
        button.className = "mg-ms-cell";
        button.textContent = "";
        if (cell.open) {
          button.classList.add("open");
          if (cell.mine) {
            button.textContent = "💥";
            button.setAttribute("aria-label", "地雷");
          } else if (cell.count > 0) {
            button.textContent = String(cell.count);
            button.classList.add(`n${cell.count}`);
            button.setAttribute("aria-label", `${cell.count} 颗雷相邻`);
          } else {
            button.setAttribute("aria-label", "空白");
          }
          return;
        }
        if (cell.flag === 1) {
          button.classList.add("flag");
          button.textContent = "🚩";
          button.setAttribute("aria-label", "已插旗");
        } else if (cell.flag === 2) {
          button.classList.add("unsure");
          button.textContent = "?";
          button.setAttribute("aria-label", "问号标记");
        } else if (cell.flag === 3) {
          button.classList.add("wrong");
          button.textContent = "✗";
          button.setAttribute("aria-label", "插错的旗");
        } else {
          button.setAttribute("aria-label", "未翻开");
        }
      }

      function paintAll() {
        for (let index = 0; index < cells.length; index += 1) paintCell(index);
      }

      function refreshChips() {
        const config = currentLevel();
        mineChip.lastChild.textContent = String(config.mines - flags);
      }

      let timer = null;
      function startTimer() {
        stopTimer();
        timer = ctx.interval(() => {
          elapsed = Date.now() - startedAt;
          timeChip.lastChild.textContent = `${Math.floor(elapsed / 1000)}″`;
        }, 250);
      }
      function stopTimer() {
        if (timer !== null) {
          window.clearInterval(timer);
          timer = null;
        }
      }

      // 触屏长按 = 插旗
      function attachLongPress(button, index) {
        let timerId = 0;
        let fired = false;
        button.addEventListener("pointerdown", (event) => {
          if (event.pointerType === "mouse") return;
          fired = false;
          timerId = window.setTimeout(() => {
            fired = true;
            if (!unmounted) onSecondary(index);
          }, 350);
        });
        const cancel = () => {
          if (timerId) window.clearTimeout(timerId);
          timerId = 0;
        };
        button.addEventListener("pointerup", cancel);
        button.addEventListener("pointercancel", cancel);
        button.addEventListener("pointerleave", cancel);
        button.addEventListener("click", (event) => {
          if (fired) {
            event.preventDefault();
            event.stopPropagation();
            fired = false;
          }
        }, true);
      }

      // 键盘：f 给当前焦点的格子插旗
      const offKey = ctx.key((event) => {
        if (event.key !== "f" && event.key !== "F") return;
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return;
        const index = Number(active.dataset.index);
        if (!Number.isInteger(index)) return;
        event.preventDefault();
        onSecondary(index);
      });

      const observer = new ResizeObserver(() => fitBoard());
      observer.observe(board);

      reset(levelId);

      return () => {
        unmounted = true;
        stopTimer();
        offKey();
        observer.disconnect();
      };
    },

    hubLine(entry) {
      const wins = Number(entry.wins) || 0;
      if (wins <= 0) return "";
      const best = Number(entry[`best.${String(entry.level || "beginner")}`]) || 0;
      return best > 0 ? `${wins} 胜 · 最佳 ${Math.round(best / 1000)} 秒` : `${wins} 胜`;
    },
  };
})();
