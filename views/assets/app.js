/**
 * 摸鱼小游戏 — 面板外壳
 *
 * 职责：游戏库首页、路由、主题、偏好持久化，以及给每个游戏模块的运行时(ctx)。
 * 游戏逻辑全部在 assets/games/*.js 里，各自是一个自包含模块：
 *
 *   MOYU.games.<id> = {
 *     id, name, tagline, emoji,
 *     mount(root, ctx) {},        // 把 DOM 挂进 root；可返回 dispose()
 *     unmount() {},               // 可选，ctx 资源释放后再调
 *     restart() {},               // 可选，顶栏「重开」按钮调用
 *     hubLine(entry) {},          // 可选，游戏库卡片上的最佳战绩行
 *   }
 *
 * ctx（外壳保证在 unmount 时全部回收）：
 *   store.get(id,key,fallback) / store.set(id,key,value) / store.bump(id,key,by)
 *   store.record(id, key, value)  // 仅当 value 大于旧值时才写入（最高分类）
 *   store.addTotal(ms) / store.last(id)
 *   toast(text, ms?)
 *   key(handler) -> off           // window keydown；返回退订函数
 *   interval(fn, ms) / timeout(fn, ms) / frame(fn)  // 全部自动清理
 *   theme / gameId
 *
 * 约束（宿主面板是 file:// + CSP script-src 'self' 'unsafe-inline'）：
 * 不能用 ES module、不能引外链资源；因此这里是经典脚本 + 全局 MOYU 命名空间。
 */
(function () {
  "use strict";

  const MOYU = (window.MOYU = window.MOYU || {});
  MOYU.games = MOYU.games || {};

  const LS_KEY = "moyu-games.prefs.v1";
  const SAVE_DEBOUNCE_MS = 400;

  // ── DOM 小工具 ────────────────────────────────────────────────

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
        else if (key === "dataset") Object.assign(node.dataset, value);
        else if (key.startsWith("on") && typeof value === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (value === true) node.setAttribute(key, "");
        else node.setAttribute(key, String(value));
      }
    }
    appendAll(node, children);
    return node;
  }

  function appendAll(node, children) {
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) {
        appendAll(node, child);
      } else if (child instanceof Node) {
        node.append(child);
      } else {
        node.append(document.createTextNode(String(child)));
      }
    }
  }

  /** 注入一段只属于某个游戏的样式；同一 id 重复注入会先移除旧的那份。 */
  function injectStyle(gameId, css) {
    const selector = `style[data-moyu-game="${gameId}"]`;
    document.head.querySelector(selector)?.remove();
    const style = document.createElement("style");
    style.dataset.moyuGame = gameId;
    style.textContent = css;
    document.head.append(style);
  }

  MOYU.el = el;
  MOYU.style = injectStyle;
  MOYU.clear = function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  // ── 主题 ──────────────────────────────────────────────────────

  let theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const themeListeners = new Set();

  function applyTheme(next) {
    if (next !== "light" && next !== "dark") return;
    if (theme === next) return;
    theme = next;
    document.documentElement.dataset.theme = next;
    for (const listener of [...themeListeners]) listener(next);
  }

  function watchTheme() {
    const bridge = window.pluginBridge;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    media.addEventListener?.("change", (event) => {
      applyTheme(event.matches ? "light" : "dark");
    });
    if (bridge && typeof bridge.invoke === "function") {
      bridge
        .invoke("app.getAppearance")
        .then((appearance) => {
          const base = appearance && typeof appearance === "object" ? appearance.base : null;
          applyTheme(base === "light" || base === "dark" ? base : media.matches ? "light" : "dark");
        })
        .catch(() => {});
    }
    if (bridge && typeof bridge.on === "function") {
      bridge.on("appearance:changed", (appearance) => {
        const base = appearance && typeof appearance === "object" ? appearance.base : null;
        if (base === "light" || base === "dark") applyTheme(base);
      });
    }
  }

  // ── 偏好持久化 ────────────────────────────────────────────────

  const bridge = typeof window.pluginBridge === "object" ? window.pluginBridge : null;
  /** 按天累计只认 YYYY-MM-DD 键和非负整数毫秒；来源可能是宿主回包，也可能是 localStorage。 */
  const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
  const MAX_DAY_ENTRIES = 31;

  function normalizePrefs(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const rawDays = source.days && typeof source.days === "object" ? source.days : {};
    const days = {};
    for (const [day, value] of Object.entries(rawDays)) {
      const ms = Number(value);
      if (DAY_KEY.test(day) && Number.isFinite(ms) && ms > 0) days[day] = Math.round(ms);
    }
    return {
      games: source.games && typeof source.games === "object" ? source.games : {},
      days,
      totalMs: Number(source.totalMs) || 0,
      lastGame: typeof source.lastGame === "string" ? source.lastGame : "",
    };
  }

  /** "bridge" 走插件进程（跨会话权威）；"local" 是 file:// 预览 / 桥不可用时的回退。 */
  let persistMode = bridge && typeof bridge.invoke === "function" ? "bridge" : "local";
  let prefs = normalizePrefs(null);
  let saveTimer = 0;

  function gameEntry(id) {
    if (!prefs.games[id] || typeof prefs.games[id] !== "object") prefs.games[id] = {};
    return prefs.games[id];
  }

  function readLocal() {
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object") {
        prefs = normalizePrefs(parsed);
      }
    } catch {
      /* 本地回退数据损坏就当作没有历史，不影响玩游戏 */
    }
  }

  function writeLocal() {
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(prefs));
    } catch {
      /* 隐私模式下 localStorage 可能不可写，忽略 */
    }
  }

  function flushSave() {
    if (persistMode === "local") {
      writeLocal();
      return;
    }
    bridge
      .invoke("games.prefs.set", { partial: prefs })
      .then((result) => {
        if (!result || result.ok !== true) throw new Error("prefs.set rejected");
      })
      .catch(() => {
        // 桥不可用（例如在浏览器里单独打开视图）：转为本地存储，别再反复失败
        persistMode = "local";
        writeLocal();
      });
  }

  function scheduleSave() {
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  async function loadPrefs() {
    if (persistMode === "local") {
      readLocal();
      return;
    }
    try {
      const result = await bridge.invoke("games.prefs.get");
      if (result && result.ok === true && result.prefs && typeof result.prefs === "object") {
        prefs = normalizePrefs(result.prefs);
        return;
      }
      throw new Error("prefs.get rejected");
    } catch {
      persistMode = "local";
      readLocal();
    }
  }

  const store = {
    get(id, key, fallback) {
      const value = gameEntry(id)[key];
      return value === undefined ? fallback : value;
    },
    set(id, key, value) {
      gameEntry(id)[key] = value;
      scheduleSave();
    },
    bump(id, key, by) {
      const entry = gameEntry(id);
      entry[key] = (Number(entry[key]) || 0) + (by === undefined ? 1 : by);
      scheduleSave();
    },
    /** 最高分类成绩：只有破纪录才写，返回是否破纪录。 */
    record(id, key, value) {
      const entry = gameEntry(id);
      const current = Number(entry[key]) || 0;
      if (!(Number(value) > current)) return false;
      entry[key] = Number(value);
      scheduleSave();
      return true;
    },
    addTotal(ms) {
      const delta = Math.max(0, Math.round(ms));
      prefs.totalMs = (Number(prefs.totalMs) || 0) + delta;
      if (!prefs.days || typeof prefs.days !== "object") prefs.days = {};
      const key = todayKey();
      prefs.days[key] = (Number(prefs.days[key]) || 0) + delta;
      // localStorage 回退路径不过 main.js，天数上限只能在这里自己守
      prefs.days = Object.fromEntries(
        Object.keys(prefs.days).sort().slice(-MAX_DAY_ENTRIES).map((day) => [day, prefs.days[day]]),
      );
      scheduleSave();
    },
    last(id) {
      prefs.lastGame = id;
      scheduleSave();
    },
    snapshot() {
      return prefs;
    },
  };

  // ── Toast ─────────────────────────────────────────────────────

  let toastTimer = 0;
  function toast(text, ms) {
    let node = document.querySelector(".mg-toast");
    if (!node) {
      node = el("div", { class: "mg-toast", role: "status", "aria-live": "polite" });
      document.body.append(node);
    }
    node.textContent = String(text);
    node.classList.add("show");
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => node.classList.remove("show"), ms || 1600);
  }

  // ── 外壳框架 ──────────────────────────────────────────────────

  const root = document.getElementById("root");
  const topbar = el("header", { class: "mg-top" });
  const stage = el("main", { class: "mg-stage" });
  root.append(topbar, stage);

  // ── 今日计时 ──────────────────────────────────────────────────

  function todayKey() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  /**
   * 翻页时钟：唯一一处「自己会动」的视觉元素，只在本页加载和数值变化时翻动。
   * 每个数字由上下两半 + 两片翻页片组成，翻动时先落上半片（旧数字）、再落下半片（新数字）。
   */
  function createClock() {
    const track = el("div", { class: "mg-clock-track", "aria-hidden": "true" });
    const node = el("div", { class: "mg-clock", role: "timer" }, track, el("span", { class: "mg-clock-unit", text: "分" }));
    const digits = [];

    function makeDigit() {
      const topVal = el("span", { text: "0" });
      const bottomVal = el("span", { text: "0" });
      const leafTop = el("span", { class: "mg-digit-leaf t" }, el("span", { text: "0" }));
      const leafBottom = el("span", { class: "mg-digit-leaf b" }, el("span", { text: "0" }));
      const element = el("span", { class: "mg-digit" },
        el("span", { class: "mg-digit-half t" }, topVal),
        el("span", { class: "mg-digit-half b" }, bottomVal),
        leafTop,
        leafBottom,
      );
      return { element, topVal, bottomVal, leafTop, leafBottom, value: "0" };
    }

    function set(value) {
      const total = Math.max(0, Math.min(9999, Math.round(Number(value) || 0)));
      const text = String(total).padStart(2, "0");
      node.setAttribute("aria-label", `${total} 分`);
      while (digits.length < text.length) {
        const digit = makeDigit();
        digits.push(digit);
        track.append(digit.element);
      }
      while (digits.length > text.length) track.removeChild(digits.pop().element);

      for (let index = 0; index < text.length; index += 1) {
        const next = text[index];
        const digit = digits[index];
        if (digit.value === next) continue;
        const from = digit.value;
        digit.value = next;
        digit.element.style.setProperty("--flip-delay", `${index * 55}ms`);
        // 上半片仍是旧数字（被同时翻落的叶片盖住），下半片等叶片落定后再换
        digit.topVal.textContent = next;
        digit.leafTop.firstChild.textContent = from;
        digit.leafBottom.firstChild.textContent = next;
        digit.element.classList.remove("flip");
        void digit.element.offsetWidth;
        digit.element.classList.add("flip");
        window.setTimeout(() => {
          digit.bottomVal.textContent = next;
        }, 180 + index * 55);
      }
    }

    return { node, set };
  }

  let active = null; // { module, ctx, dispose, startedAt }

  function setTopbar(content) {
    MOYU.clear(topbar);
    topbar.append(content);
  }

  function renderHub() {
    teardownActive();
    const games = Object.values(MOYU.games).sort((a, b) => (a.order || 99) - (b.order || 99));
    const todayMs = Number(prefs.days?.[todayKey()]) || 0;
    const plays = games.reduce((sum, game) => sum + (Number(prefs.games[game.id]?.plays) || 0), 0);
    const lastGame = prefs.lastGame && MOYU.games[prefs.lastGame] ? MOYU.games[prefs.lastGame] : null;

    setTopbar(
      el(
        "div",
        { class: "mg-top-titles" },
        el("div", { class: "mg-top-title", text: "摸鱼小游戏" }),
        el("div", { class: "mg-top-sub", text: `${games.length} 款 · 随开随玩` }),
      ),
    );

    const scroll = el("div", { class: "mg-scroll" });
    const hub = el("section", { class: "mg-hub" });

    const clock = createClock();
    hub.append(
      el(
        "section",
        { class: "mg-hero" },
        el("div", { class: "mg-hero-label", text: "今日已摸" }),
        clock.node,
        el("div", {
          class: "mg-hero-note",
          text: plays > 0
            ? `开过 ${plays} 局${lastGame ? `，上次在玩${lastGame.name}` : ""}`
            : "还没开过局，选一个开始",
        }),
        lastGame
          ? el(
              "button",
              { class: "mg-btn mg-hero-cta", type: "button", onclick: () => navigate(lastGame.id) },
              `接着摸${lastGame.name}`,
            )
          : null,
      ),
    );
    clock.set(Math.floor(todayMs / 60000));

    hub.append(
      el(
        "div",
        { class: "mg-ledger-head" },
        el("span", { text: "打卡开始" }),
        el("span", { class: "mg-ledger-head-side", text: "战绩" }),
      ),
    );

    const ledger = el("div", { class: "mg-ledger" });
    for (const game of games) {
      const entry = prefs.games[game.id] || {};
      const best = typeof game.hubLine === "function" ? game.hubLine(entry) : defaultHubLine(game, entry);
      ledger.append(
        el(
          "button",
          { class: "mg-row", type: "button", onclick: () => navigate(game.id) },
          el("span", { class: "mg-row-glyph", text: game.emoji || "🎮" }),
          el(
            "span",
            { class: "mg-row-body" },
            el("span", { class: "mg-row-name", text: game.name }),
            el("span", { class: "mg-row-tag", text: game.tagline || "" }),
          ),
          el("span", { class: "mg-row-stat", text: best || "未开局" }),
        ),
      );
    }
    hub.append(ledger);

    hub.append(
      el("div", {
        class: "mg-foot",
        text: "全部本地运行，不联网、不读文件；战绩存在本机。",
      }),
    );

    scroll.append(hub);
    MOYU.clear(stage);
    stage.append(scroll);
  }

  function defaultHubLine(game, entry) {
    if (Number(entry.plays) > 0) return `已玩 ${entry.plays} 局`;
    return "还没玩过";
  }

  function renderGame(id) {
    const module = MOYU.games[id];
    if (!module) {
      navigate("");
      return;
    }
    teardownActive();
    store.last(id);
    store.bump(id, "plays");

    setTopbar(
      el(
        "button",
        { class: "mg-btn ghost icon", onclick: () => navigate(""), title: "返回游戏库", "aria-label": "返回游戏库" },
        "‹",
      ),
      el(
        "div",
        { class: "mg-top-titles" },
        el("div", { class: "mg-top-title", text: `${module.emoji || "🎮"} ${module.name}` }),
      ),
      el("div", { class: "mg-spacer" }),
      el(
        "button",
        {
          class: "mg-btn",
          onclick: () => {
            if (typeof module.restart === "function") module.restart();
            else renderGame(id);
          },
        },
        "重开",
      ),
    );

    const gameRoot = el("div", { class: "mg-game" });
    MOYU.clear(stage);
    stage.append(gameRoot);

    const ctx = createCtx(id);
    active = { module, ctx, dispose: null, startedAt: Date.now() };
    let dispose = null;
    try {
      dispose = module.mount(gameRoot, ctx) || null;
    } catch (error) {
      MOYU.clear(gameRoot);
      gameRoot.append(
        el(
          "div",
          { class: "mg-panel" },
          el("div", { class: "mg-panel-title", text: "游戏启动失败" }),
          el("div", { class: "mg-panel-text", text: String(error?.message || error) }),
        ),
      );
      console.error(`[moyu] ${id} mount failed`, error);
      return;
    }
    active.dispose = typeof dispose === "function" ? dispose : null;
  }

  // ── ctx：所有可泄漏资源都在这里登记，切走时统一释放 ─────────────

  function createCtx(gameId) {
    const cleanups = [];
    let disposed = false;

    const ctx = {
      gameId,
      get theme() {
        return theme;
      },
      store,
      toast,
      key(handler) {
        const listener = (event) => {
          if (disposed) return;
          const target = event.target;
          // 焦点在按钮上时，Enter/Space 归浏览器（否则会「点按钮」和「游戏操作」各触发一次）
          if (
            target instanceof Element &&
            target.closest("button, input, select, textarea, a[href]") &&
            (event.key === "Enter" || event.key === " ")
          ) {
            return;
          }
          handler(event);
        };
        window.addEventListener("keydown", listener);
        cleanups.push(() => window.removeEventListener("keydown", listener));
        return () => {
          const index = cleanups.indexOf(listener);
          if (index >= 0) cleanups.splice(index, 1);
          window.removeEventListener("keydown", listener);
        };
      },
      interval(fn, ms) {
        const id = window.setInterval(() => {
          if (!disposed) fn();
        }, ms);
        cleanups.push(() => window.clearInterval(id));
        return id;
      },
      timeout(fn, ms) {
        const id = window.setTimeout(() => {
          if (!disposed) fn();
        }, ms);
        cleanups.push(() => window.clearTimeout(id));
        return id;
      },
      frame(fn) {
        let raf = 0;
        let previous = performance.now();
        const tick = (now) => {
          if (disposed) return;
          const delta = Math.min(64, now - previous);
          previous = now;
          fn(delta, now);
          raf = window.requestAnimationFrame(tick);
        };
        raf = window.requestAnimationFrame(tick);
        cleanups.push(() => window.cancelAnimationFrame(raf));
        return () => window.cancelAnimationFrame(raf);
      },
      onThemeChange(listener) {
        themeListeners.add(listener);
        const off = () => themeListeners.delete(listener);
        cleanups.push(off);
        return off;
      },
    };
    ctx._cleanups = cleanups;
    ctx._dispose = () => {
      disposed = true;
    };
    return ctx;
  }

  function teardownActive() {
    if (!active) return;
    const { ctx, module, dispose, startedAt } = active;
    active = null;
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
      flushSave();
    }
    store.addTotal(Date.now() - startedAt);
    if (typeof dispose === "function") {
      try {
        dispose();
      } catch (error) {
        console.error("[moyu] dispose failed", error);
      }
    }
    if (typeof module.unmount === "function") {
      try {
        module.unmount();
      } catch (error) {
        console.error("[moyu] unmount failed", error);
      }
    }
    ctx._dispose();
    for (const cleanup of ctx._cleanups.splice(0)) {
      try {
        cleanup();
      } catch (error) {
        console.error("[moyu] cleanup failed", error);
      }
    }
  }

  // ── 路由 ──────────────────────────────────────────────────────

  function currentRoute() {
    return location.hash.replace(/^#\/?/, "").split("?")[0].trim();
  }

  function navigate(id) {
    const target = id ? `#/${id}` : "#/";
    if (location.hash === target) render();
    else location.hash = target;
  }

  function render() {
    const route = currentRoute();
    if (route && MOYU.games[route]) renderGame(route);
    else renderHub();
  }

  window.addEventListener("hashchange", render);

  /** 宿主可以把视图「打开」到某个位置：?piViewOpen= 或 view:open 推送。 */
  function watchHostNavigation() {
    const param = new URLSearchParams(location.search).get("piViewOpen");
    if (param) {
      const id = String(param).replace(/^[#/]+/, "");
      if (MOYU.games[id]) {
        location.replace(`#/${id}`);
        return;
      }
    }
    if (bridge && typeof bridge.on === "function") {
      bridge.on("view:open", (payload) => {
        const id = String(payload?.path ?? "").replace(/^[#/]+/, "");
        if (MOYU.games[id]) navigate(id);
      });
    }
  }

  // ── 启动 ──────────────────────────────────────────────────────

  async function boot() {
    watchTheme();
    await loadPrefs();
    watchHostNavigation();
    render();
    // defer 脚本按文档顺序在 DOMContentLoaded 前跑完，正常情况下这里已能看见全部
    // 游戏。但宿主若以「文档已 complete」的方式注入页面（预览 / 热重载），app.js 会
    // 早于游戏脚本执行，首屏就一个卡片都没有——那时再等一个宏任务补渲染一次。
    if (Object.keys(MOYU.games).length === 0) {
      window.setTimeout(() => {
        if (!active) render();
      }, 0);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  MOYU.navigate = navigate;
  MOYU.store = store;
})();
