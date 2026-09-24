/**
 * 贪吃蛇 — canvas 方案范例
 *
 * 网格 15×15，转向禁止掉头；吃到食物 +10 分并加速一档（有下限）。
 * 速度档位持久化；最高分用 store.record（只破纪录才写盘）。
 */
(function () {
  "use strict";
  const MOYU = (window.MOYU = window.MOYU || {});
  MOYU.games = MOYU.games || {};

  const COLS = 15;
  const ROWS = 15;
  const SPEEDS = [
    { id: "chill", label: "悠闲", ms: 170 },
    { id: "normal", label: "正常", ms: 120 },
    { id: "fast", label: "竞速", ms: 80 },
  ];
  MOYU.style(
    "snake",
    `
    .mg-snake-wrap { display: grid; gap: 10px; justify-items: center; width: 100%; }
    .mg-snake-canvas {
      display: block;
      border: 1px solid var(--mg-line);
      border-radius: var(--mg-r-md);
      background: var(--mg-surface);
      touch-action: none;
    }
    .mg-pad { display: grid; grid-template-columns: repeat(3, 44px); grid-template-rows: repeat(2, 38px); gap: 6px; justify-content: center; }
    .mg-pad button { appearance: none; border: 1px solid var(--mg-line); background: var(--mg-surface-2); color: var(--mg-text); border-radius: var(--mg-r-sm); font-size: 15px; cursor: pointer; }
    .mg-pad button:active { background: var(--mg-accent-soft); }
    .mg-pad .up { grid-column: 2; }
    `,
  );

  function readColors() {
    const style = getComputedStyle(document.documentElement);
    const value = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    return {
      accent: value("--mg-accent", "#35d07f"),
      line: value("--mg-line", "#2a313d"),
      surface: value("--mg-surface", "#171b22"),
      surface2: value("--mg-surface-2", "#1f242e"),
      text: value("--mg-text", "#e8ebf0"),
      bad: value("--mg-bad", "#f2555a"),
    };
  }

  MOYU.games.snake = {
    id: "snake",
    name: "贪吃蛇",
    tagline: "越吃越长，别咬自己",
    emoji: "🐍",
    order: 5,

    mount(root, ctx) {
      const id = ctx.gameId;
      const speedId = String(ctx.store.get(id, "speed", "normal"));
      const speed = SPEEDS.find((item) => item.id === speedId) || SPEEDS[1];
      let colors = readColors();

      let snake = [];
      let direction = { x: 1, y: 0 };
      let queued = [];
      let food = { x: 0, y: 0 };
      let score = 0;
      let eaten = 0;
      let alive = false;
      let paused = false;
      let accumulator = 0;
      const canvas = MOYU.el("canvas", { class: "mg-snake-canvas" });
      const scoreChip = MOYU.el("span", { class: "mg-chip" }, MOYU.el("span", { class: "k", text: "分数" }), "0");
      const bestChip = MOYU.el("span", { class: "mg-chip good" }, MOYU.el("span", { class: "k", text: "最高" }), "0");
      const overlay = MOYU.el("div", { class: "mg-overlay", hidden: true });
      const overlayBody = MOYU.el("div", { class: "mg-panel" });
      overlay.append(overlayBody);

      const speedButtons = new Map();
      const speedSeg = MOYU.el(
        "div",
        { class: "mg-seg", role: "group", "aria-label": "速度" },
        ...SPEEDS.map((item) => {
          const button = MOYU.el("button", {
            type: "button",
            "aria-pressed": String(item.id === speed.id),
            text: item.label,
            onclick: () => selectSpeed(item.id),
          });
          speedButtons.set(item.id, button);
          return button;
        }),
      );

      const pauseBtn = MOYU.el("button", { class: "mg-btn", type: "button", text: "暂停" });
      const board = MOYU.el("div", { class: "mg-snake-wrap" });
      const bar = MOYU.el(
        "div",
        { class: "mg-game-bar" },
        MOYU.el("div", { class: "mg-chips" }, scoreChip, bestChip),
        MOYU.el("div", { class: "mg-spacer" }),
        speedSeg,
        pauseBtn,
      );

      root.append(bar, board);
      board.append(canvas, overlay);

      const pad = MOYU.el(
        "div",
        { class: "mg-pad" },
        MOYU.el("button", { class: "up", type: "button", text: "↑", onclick: () => turn(0, -1) }),
        MOYU.el("button", { type: "button", text: "←", onclick: () => turn(-1, 0) }),
        MOYU.el("button", { type: "button", text: "→", onclick: () => turn(1, 0) }),
      );
      board.append(pad);

      function currentSpeed() {
        const stored = String(ctx.store.get(id, "speed", "normal"));
        return SPEEDS.find((item) => item.id === stored) || SPEEDS[1];
      }

      function refreshBest() {
        bestChip.lastChild.textContent = String(Number(ctx.store.get(id, "best", 0)) || 0);
      }

      function refreshScore() {
        scoreChip.lastChild.textContent = String(score);
      }

      function placeFood() {
        const free = [];
        for (let y = 0; y < ROWS; y += 1) {
          for (let x = 0; x < COLS; x += 1) {
            if (!snake.some((part) => part.x === x && part.y === y)) free.push({ x, y });
          }
        }
        food = free.length ? free[Math.floor(Math.random() * free.length)] : { x: 0, y: 0 };
      }

      function reset() {
        const midY = Math.floor(ROWS / 2);
        snake = [
          { x: 4, y: midY },
          { x: 3, y: midY },
          { x: 2, y: midY },
        ];
        direction = { x: 1, y: 0 };

        queued = [];
        score = 0;
        eaten = 0;
        accumulator = 0;
        alive = true;
        paused = false;
        pauseBtn.textContent = "暂停";
        placeFood();
        refreshScore();
        overlay.hidden = true;
      }

      /** 换档即重开一局：旧速度下半场的蛇不该按新速度续命。 */
      function selectSpeed(nextId) {
        if (!SPEEDS.some((item) => item.id === nextId)) return;
        ctx.store.set(id, "speed", nextId);
        for (const [key, button] of speedButtons) {
          button.setAttribute("aria-pressed", String(key === nextId));
        }
        reset();
      }
      function turn(x, y) {
        const last = queued.length ? queued[queued.length - 1] : direction;
        if (last.x === -x && last.y === -y) return; // 禁止 180° 掉头
        if (last.x === x && last.y === y) return;
        if (queued.length < 2) queued.push({ x, y });
      }

      function step() {
        if (queued.length) direction = queued.shift();
        const head = { x: snake[0].x + direction.x, y: snake[0].y + direction.y };
        const hitWall = head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS;
        const hitSelf = snake.some((part) => part.x === head.x && part.y === head.y);
        if (hitWall || hitSelf) {
          alive = false;
          gameOver();
          return;
        }
        snake.unshift(head);
        if (head.x === food.x && head.y === food.y) {
          score += 10;
          eaten += 1;
          placeFood();
          refreshScore();
        } else {
          snake.pop();
        }
      }

      function gameOver() {
        const broke = ctx.store.record(id, "best", score);
        refreshBest();
        overlayBody.replaceChildren(
          MOYU.el("div", { class: "mg-panel-title", text: broke ? "新纪录！" : "游戏结束" }),
          MOYU.el("div", { class: "mg-panel-text", text: `本局 ${score} 分 · 长度 ${snake.length}` }),
          MOYU.el(
            "div",
            { class: "mg-panel-actions" },
            MOYU.el("button", { class: "mg-btn primary", type: "button", text: "再来一局", onclick: () => reset() }),
          ),
        );
        overlay.hidden = false;
      }

      function togglePause() {
        if (!alive) return;
        paused = !paused;
        pauseBtn.textContent = paused ? "继续" : "暂停";
        if (paused) {
          overlayBody.replaceChildren(
            MOYU.el("div", { class: "mg-panel-title", text: "已暂停" }),
            MOYU.el("div", { class: "mg-panel-text", text: "按空格或点「继续」恢复" }),
          );
          overlay.hidden = false;
        } else {
          overlay.hidden = true;
        }
      }

      function sizeCanvas() {
        const width = board.clientWidth || 320;
        const side = Math.max(200, Math.min(width, 460));
        const ratio = window.devicePixelRatio || 1;
        canvas.style.width = `${side}px`;
        canvas.style.height = `${side}px`;
        canvas.width = Math.round(side * ratio);
        canvas.height = Math.round(side * ratio);
        const context = canvas.getContext("2d");
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        cell = side / COLS;
        draw();
      }

      let cell = 20;

      function draw() {
        const context = canvas.getContext("2d");
        const side = cell * COLS;
        context.clearRect(0, 0, side, side);
        context.fillStyle = colors.surface;
        context.fillRect(0, 0, side, side);

        context.strokeStyle = colors.line;
        context.lineWidth = 1;
        for (let i = 1; i < COLS; i += 1) {
          const position = Math.round(i * cell) + 0.5;
          context.beginPath();
          context.moveTo(position, 0);
          context.lineTo(position, side);
          context.moveTo(0, position);
          context.lineTo(side, position);
          context.stroke();
        }

        context.fillStyle = colors.bad;
        context.beginPath();
        context.arc(food.x * cell + cell / 2, food.y * cell + cell / 2, cell * 0.32, 0, Math.PI * 2);
        context.fill();

        snake.forEach((part, index) => {
          const inset = index === 0 ? 1 : 2;
          context.fillStyle = index === 0 ? colors.accent : colors.surface2;
          context.strokeStyle = colors.accent;
          context.lineWidth = 1;
          const x = part.x * cell + inset;
          const y = part.y * cell + inset;
          const size = cell - inset * 2;
          context.beginPath();
          context.roundRect ? context.roundRect(x, y, size, size, 4) : context.rect(x, y, size, size);
          context.fill();
          if (index > 0) context.stroke();
        });

        // 蛇头眼睛，让朝向一眼可辨
        const head = snake[0];
        if (head) {
          const cx = head.x * cell + cell / 2;
          const cy = head.y * cell + cell / 2;
          const offset = cell * 0.18;
          const px = direction.y !== 0 ? offset : 0;
          const py = direction.x !== 0 ? offset : 0;
          context.fillStyle = colors.surface;
          for (const sign of [-1, 1]) {
            context.beginPath();
            context.arc(cx + px * sign, cy + py * sign, Math.max(1.2, cell * 0.07), 0, Math.PI * 2);
            context.fill();
          }
        }
      }

      function tick(delta) {
        if (!alive || paused) return;
        // 吃得越多越快，最快到当前档位的 65%
        const boost = Math.min(0.35, eaten * 0.01);
        const interval = currentSpeed().ms * (1 - boost);
        accumulator += delta;
        while (accumulator >= interval) {
          accumulator -= interval;
          step();
          if (!alive) break;
        }
        draw();
      }

      const offKey = ctx.key((event) => {
        const key = event.key;
        if (key === "ArrowUp" || key === "w" || key === "W") turn(0, -1);
        else if (key === "ArrowDown" || key === "s" || key === "S") turn(0, 1);
        else if (key === "ArrowLeft" || key === "a" || key === "A") turn(-1, 0);
        else if (key === "ArrowRight" || key === "d" || key === "D") turn(1, 0);
        else if (key === " ") {
          if (!alive) reset();
          else togglePause();
        } else return;
        event.preventDefault();
      });

      pauseBtn.addEventListener("click", togglePause);

      // 触屏滑动
      let swipeStart = null;
      canvas.addEventListener("pointerdown", (event) => {
        swipeStart = { x: event.clientX, y: event.clientY };
      });
      canvas.addEventListener("pointerup", (event) => {
        if (!swipeStart) return;
        const dx = event.clientX - swipeStart.x;
        const dy = event.clientY - swipeStart.y;
        swipeStart = null;
        if (Math.abs(dx) < 18 && Math.abs(dy) < 18) return;
        if (Math.abs(dx) > Math.abs(dy)) turn(dx > 0 ? 1 : -1, 0);
        else turn(0, dy > 0 ? 1 : -1);
      });

      const offTheme = ctx.onThemeChange(() => {
        colors = readColors();
        draw();
      });

      const observer = new ResizeObserver(() => sizeCanvas());
      observer.observe(board);

      const cancelFrame = ctx.frame(tick);

      refreshBest();
      refreshScore();
      reset();
      sizeCanvas();

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
})();
