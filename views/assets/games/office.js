/**
 * 工位模拟器 — 关掉面板也自己在转的挂机局
 *
 * 循环：点「摸一下」或等工位自动产出摸鱼值 → 买工位装备抬高每秒产出 → 累计摸鱼值够数就升职，
 * 段位越高全局倍率越高。离岗期间按 40% 效率继续产出，单次最多补 4 小时，回来给一张小纸条。
 *
 * 只写 12 个偏好键：value / earned / bulk / lastSeen / lv0..lv7，全部整数——
 * main.js 的 sanitizeValue 只收整数、布尔和短字符串，小数会被四舍五入，数组与对象会被丢掉。
 */
(function () {
  "use strict";

  const MOYU = (window.MOYU = window.MOYU || {});
  MOYU.games = MOYU.games || {};

  const GAME_ID = "office";
  /** 装备等级上限：1.24^50 仍远低于 MAX_SAFE_INTEGER，成本不会溢出成非有限值。 */
  const MAX_LEVEL = 50;
  const OFFLINE_EFFICIENCY = 0.4;
  const OFFLINE_CAP_MS = 4 * 60 * 60 * 1000;
  /** 离岗不足 1 分钟算连续摸鱼：全额入账，也不弹纸条。 */
  const CONTINUOUS_MS = 60 * 1000;
  const TICK_MS = 1000;
  const PERSIST_EVERY_TICKS = 5;

  const BULK_OPTIONS = [
    { label: "×1", count: 1 },
    { label: "×10", count: 10 },
    { label: "拉满", count: Infinity },
  ];

  /** 八件工位装备：成本按 growth 复利涨，产出按等级线性涨。 */
  const FACILITIES = [
    { emoji: "☕", name: "保温杯", cost: 15, growth: 1.22, rate: 0.5 },
    { emoji: "🪴", name: "桌面绿植", cost: 54, growth: 1.22, rate: 1.8 },
    { emoji: "🪑", name: "人体工学椅", cost: 194, growth: 1.22, rate: 6.48 },
    { emoji: "🎧", name: "降噪耳机", cost: 700, growth: 1.22, rate: 23.3 },
    { emoji: "🛠️", name: "升降桌", cost: 2520, growth: 1.23, rate: 84 },
    { emoji: "🍵", name: "茶水间情报网", cost: 9070, growth: 1.23, rate: 302 },
    { emoji: "⌨️", name: "自动摸鱼脚本", cost: 32700, growth: 1.24, rate: 1090 },
    { emoji: "🐈", name: "工位猫", cost: 118000, growth: 1.24, rate: 3920 },
  ];

  /** 段位：累计摸鱼值门槛，每升一级全局产出 ×1.2。 */
  const RANKS = [
    { emoji: "🐣", name: "实习生", need: 0 },
    { emoji: "📎", name: "试用期", need: 130 },
    { emoji: "🪪", name: "正式员工", need: 12980 },
    { emoji: "🫖", name: "老员工", need: 2671100 },
    { emoji: "🐟", name: "摸鱼骨干", need: 219865250 },
    { emoji: "📋", name: "摸鱼组长", need: 1166179660 },
    { emoji: "🗂️", name: "摸鱼经理", need: 3743696750 },
    { emoji: "🕶️", name: "摸鱼总监", need: 8503253920 },
    { emoji: "🏝️", name: "摸鱼合伙人", need: 17953690130 },
  ];
  const RANK_MULT = RANKS.map((_, index) => Math.pow(1.2, index));

  // ── 纯逻辑：不碰 DOM，也不碰偏好；全部挂在 module._logic 上供单测驱动 ──

  /** 第 level 级升到 level+1 的花费；满级返回 Infinity。 */
  function costOf(index, level) {
    const facility = FACILITIES[index];
    if (!facility) return Infinity;
    if (!(level >= 0) || level >= MAX_LEVEL) return Infinity;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(facility.cost * Math.pow(facility.growth, level)));
  }

  function rateOf(levels, multiplier) {
    let sum = 0;
    for (let index = 0; index < FACILITIES.length; index += 1) {
      sum += FACILITIES[index].rate * (Number(levels?.[index]) || 0);
    }
    return sum * (Number(multiplier) || 1);
  }

  function rankIndexFor(earned) {
    const total = Number(earned) || 0;
    let index = 0;
    for (let i = 0; i < RANKS.length; i += 1) {
      if (total >= RANKS[i].need) index = i;
    }
    return index;
  }

  /** 手点一下 = 工位产出 1 秒；起手固定 1，避免开局点不动。 */
  function clickPower(rate) {
    return Math.max(1, Math.floor(Number(rate) || 0));
  }

  /** 把偏好里读到的等级夹回合法范围：设置文件可能是旧版本或被手改过。 */
  function readLevels(entry) {
    const source = entry && typeof entry === "object" ? entry : {};
    return FACILITIES.map((_, index) => {
      const raw = Number(source[`lv${index}`]);
      return Number.isFinite(raw) && raw > 0 ? Math.min(MAX_LEVEL, Math.floor(raw)) : 0;
    });
  }

  /**
   * 离岗结算：不足 1 分钟按连续摸鱼全额入账，其余按 OFFLINE_EFFICIENCY 计，单次封顶 4 小时。
   * 返回 efficiency（纸条要写清按几成算）与 countedMs / capped（说清离岗多久、按多久算）。
   */
  function settleOffline(rate, awayMs) {
    const away = Math.max(0, Math.floor(Number(awayMs) || 0));
    const countedMs = Math.min(away, OFFLINE_CAP_MS);
    const continuous = away < CONTINUOUS_MS;
    const efficiency = continuous ? 1 : OFFLINE_EFFICIENCY;
    return {
      efficiency,
      awayMs: away,
      countedMs,
      capped: away > OFFLINE_CAP_MS,
      continuous,
      gain: Math.floor((Number(rate) || 0) * (countedMs / 1000) * efficiency),
    };
  }

  /** 一次买 1 / 10 / 拉满级：{ok, bought, spent, levels, value, level} 或 {ok:false, reason}。 */
  function purchase(state, index, wanted) {
    const startLevel = Number(state?.levels?.[index]) || 0;
    if (startLevel >= MAX_LEVEL) return { ok: false, reason: "max" };
    const limit = wanted === Infinity ? MAX_LEVEL : Math.max(1, Math.floor(Number(wanted) || 1));
    let level = startLevel;
    let value = Number(state.value) || 0;
    let spent = 0;
    let bought = 0;
    while (bought < limit && level < MAX_LEVEL) {
      const cost = costOf(index, level);
      if (value < cost) break;
      value -= cost;
      spent += cost;
      level += 1;
      bought += 1;
    }
    if (bought === 0) {
      return { ok: false, reason: level >= MAX_LEVEL ? "max" : "poor", cost: costOf(index, level) };
    }
    const levels = state.levels.slice();
    levels[index] = level;
    return { ok: true, bought, spent, levels, value, level };
  }

  // ── 数字与时长格式 ──────────────────────────────────────────

  /** 去掉小数末尾的 0。整数部分原样保留：把去零用到整串上会把 420 削成 42。 */
  function trimDecimals(number) {
    if (Number.isInteger(number)) return String(number);
    if (Math.abs(number) >= 100) return String(Math.round(number));
    const text = number < 10 ? number.toFixed(2) : number.toFixed(1);
    return text.replace(/\.?0+$/, "");
  }

  /** 1.2万 / 3.4亿 / 5万亿：窄面板里比一长串数字好读。 */
  function fmtShort(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "0";
    if (number < 1e4) return trimDecimals(number);
    if (number < 1e8) return `${trimDecimals(number / 1e4)}万`;
    if (number < 1e12) return `${trimDecimals(number / 1e8)}亿`;
    return `${trimDecimals(number / 1e12)}万亿`;
  }

  function fmtDuration(ms) {
    const total = Math.max(1, Math.floor(ms / 60000));
    if (total < 60) return `${total} 分`;
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    if (hours < 24) return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest ? `${days} 天 ${rest} 小时` : `${days} 天`;
  }

  MOYU.style(
    GAME_ID,
    `
    .mg-of-wrap { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; }

    .mg-of-rank { flex: none; display: grid; gap: 4px; }
    .mg-of-rank-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .mg-of-rank-name { font-size: 12.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mg-of-rank-next { font: 500 10.5px/1 var(--mg-mono); color: var(--mg-dim); white-space: nowrap; }
    .mg-of-bar { height: 4px; border-radius: 2px; background: var(--mg-line); overflow: hidden; }
    .mg-of-bar i { display: block; width: 0; height: 100%; background: var(--mg-accent); transition: width 0.2s ease; }

    .mg-of-hero { flex: none; display: grid; gap: 3px; padding: 11px 12px 12px; border: 1.5px solid var(--mg-rule-ink); border-radius: var(--mg-r-sm); background: var(--mg-surface); }
    .mg-of-label { font-size: 10.5px; letter-spacing: 0.08em; color: var(--mg-dim); }
    .mg-of-value { font: 600 30px/1.15 var(--mg-mono); letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mg-of-sub { font: 500 11px/1.5 var(--mg-mono); color: var(--mg-dim); }
    .mg-of-sub b { font-weight: 600; color: var(--mg-accent); }
    .mg-of-tap { margin-top: 9px; appearance: none; width: 100%; padding: 14px 10px; border: 1.5px solid var(--mg-accent); border-radius: var(--mg-r-sm); background: var(--mg-surface); color: var(--mg-accent); font: 700 13.5px/1 var(--mg-font); letter-spacing: 0.02em; cursor: pointer; }
    .mg-of-tap:hover { background: var(--mg-accent-soft); }
    .mg-of-tap:active { transform: translateY(1px); }

    .mg-of-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; padding-bottom: 4px; }
    .mg-of-list { display: grid; }
    .mg-of-row { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 7px 4px; border-bottom: 1px solid var(--mg-line); }
    .mg-of-row.affordable .mg-of-buy { border-color: var(--mg-accent); color: var(--mg-accent); }
    .mg-of-glyph { display: grid; place-items: center; width: 26px; height: 26px; font-size: 13px; border: 1px solid var(--mg-line); border-radius: var(--mg-r-sm); background: var(--mg-surface-2); }
    .mg-of-body { display: grid; min-width: 0; }
    .mg-of-name { font-size: 12.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mg-of-desc { font: 500 10.5px/1.45 var(--mg-mono); color: var(--mg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mg-of-buy { appearance: none; padding: 7px 9px; border: 1px solid var(--mg-line); border-radius: var(--mg-r-sm); background: var(--mg-surface); color: var(--mg-text); font: 600 11px/1 var(--mg-mono); cursor: pointer; }
    .mg-of-buy:hover:not([disabled]) { background: var(--mg-mark); border-color: var(--mg-rule-ink); }
    .mg-of-buy:active:not([disabled]) { transform: translateY(1px); }
    .mg-of-buy[disabled] { opacity: 0.4; cursor: default; }

    .mg-of-note { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; padding: 8px 9px; border: 1px dashed var(--mg-rule-ink); border-left: 3px solid var(--mg-accent); border-radius: var(--mg-r-sm); background: var(--mg-surface-2); }
    .mg-of-note-text { flex: 1 1 auto; min-width: 0; font-size: 11px; line-height: 1.5; }
    .mg-of-note-text b { color: var(--mg-accent); }
    .mg-of-note .mg-btn { padding: 3px 7px; font-size: 13px; line-height: 1; }
    `,
  );

  /** 顶栏「重开」拿到的回调：挂载时接管，卸载时交回。 */
  let requestReset = null;

  MOYU.games[GAME_ID] = {
    id: GAME_ID,
    name: "工位模拟器",
    tagline: "关掉面板，工位自己也在摸",
    emoji: "🧑‍💻",
    order: 6,

    mount(root, ctx) {
      const id = ctx.gameId;

      const rawLevels = {};
      for (let index = 0; index < FACILITIES.length; index += 1) {
        rawLevels[`lv${index}`] = ctx.store.get(id, `lv${index}`, 0);
      }

      let levels = readLevels(rawLevels);
      let value = Math.max(0, Math.floor(Number(ctx.store.get(id, "value", 0)) || 0));
      let earned = Math.max(0, Math.floor(Number(ctx.store.get(id, "earned", 0)) || 0));
      let bulkIndex = Math.min(BULK_OPTIONS.length - 1, Math.max(0, Math.floor(Number(ctx.store.get(id, "bulk", 0)) || 0)));
      let rankIndex = rankIndexFor(earned);
      let rate = rateOf(levels, RANK_MULT[rankIndex]);

      const wrap = MOYU.el("div", { class: "mg-of-wrap" });

      // ── 段位条 ────────────────────────────────────────────────
      const rankName = MOYU.el("span", { class: "mg-of-rank-name" });
      const rankNext = MOYU.el("span", { class: "mg-of-rank-next" });
      const barFill = MOYU.el("i");
      const bar = MOYU.el("div", { class: "mg-of-bar", role: "progressbar" }, barFill);

      // ── 读数 ──────────────────────────────────────────────────
      const valueNode = MOYU.el("div", { class: "mg-of-value", text: "0" });
      const subNode = MOYU.el("div", { class: "mg-of-sub" });
      const tapBtn = MOYU.el("button", { class: "mg-of-tap", type: "button", onclick: () => tap() });
      const hero = MOYU.el(
        "div",
        { class: "mg-of-hero" },
        MOYU.el("div", { class: "mg-of-label", text: "工位产出（摸鱼值）" }),
        valueNode,
        subNode,
        tapBtn,
      );

      // ── 装备清单 ──────────────────────────────────────────────
      const bulkButtons = new Map();
      const bulkSeg = MOYU.el(
        "div",
        { class: "mg-seg", role: "group", "aria-label": "购买数量" },
        ...BULK_OPTIONS.map((option, index) => {
          const button = MOYU.el("button", {
            type: "button",
            text: option.label,
            "aria-pressed": String(index === bulkIndex),
            onclick: () => selectBulk(index),
          });
          bulkButtons.set(index, button);
          return button;
        }),
      );

      const rows = FACILITIES.map((facility, index) => {
        const name = MOYU.el("span", { class: "mg-of-name", text: facility.name });
        const desc = MOYU.el("span", { class: "mg-of-desc" });
        const buy = MOYU.el("button", { class: "mg-of-buy", type: "button", onclick: () => buyOne(index) });
        const row = MOYU.el(
          "div",
          { class: "mg-of-row" },
          MOYU.el("span", { class: "mg-of-glyph", text: facility.emoji }),
          MOYU.el("span", { class: "mg-of-body" }, name, desc),
          buy,
        );
        return { row, desc, buy };
      });

      const list = MOYU.el("div", { class: "mg-of-list" }, ...rows.map((row) => row.row));
      const scroll = MOYU.el("div", { class: "mg-of-scroll" }, list);

      const overlay = MOYU.el("div", { class: "mg-overlay", hidden: true });
      const overlayBody = MOYU.el("div", { class: "mg-panel" });
      overlay.append(overlayBody);

      wrap.append(
        MOYU.el(
          "div",
          { class: "mg-of-rank" },
          MOYU.el("div", { class: "mg-of-rank-row" }, rankName, rankNext),
          bar,
        ),
        hero,
        MOYU.el("div", { class: "mg-ledger-head" }, MOYU.el("span", { text: "工位装备" }), bulkSeg),
        scroll,
        overlay,
      );
      root.append(wrap);

      // ── 离岗结算：先算再落盘，避免这段时间被下一次结算重复计入 ──
      const lastSeen = Number(ctx.store.get(id, "lastSeen", 0)) || 0;
      const settle = settleOffline(rate, lastSeen > 0 ? Date.now() - lastSeen : 0);
      if (settle.gain > 0) {
        value += settle.gain;
        earned += settle.gain;
        rankIndex = rankIndexFor(earned);
        rate = rateOf(levels, RANK_MULT[rankIndex]);
      }
      if (!settle.continuous && settle.gain > 0) scroll.prepend(buildNote(settle));

      function buildNote(result) {
        const note = MOYU.el(
          "div",
          { class: "mg-of-note" },
          MOYU.el(
            "span",
            { class: "mg-of-note-text" },
            `离岗 ${fmtDuration(result.awayMs)}${result.capped ? "（按 4 小时上限计）" : ""}，工位自己摸了 `,
            MOYU.el("b", { text: fmtShort(result.gain) }),
            `（${Math.round(result.efficiency * 100)}% 效率）`,
          ),
        );
        note.append(
          MOYU.el("button", {
            class: "mg-btn ghost icon",
            type: "button",
            "aria-label": "知道了",
            text: "×",
            onclick: () => note.remove(),
          }),
        );
        return note;
      }

      // ── 状态写入与刷新 ────────────────────────────────────────
      function persist() {
        ctx.store.set(id, "value", Math.floor(value));
        ctx.store.set(id, "earned", Math.floor(earned));
        for (let index = 0; index < levels.length; index += 1) ctx.store.set(id, `lv${index}`, levels[index]);
        ctx.store.set(id, "bulk", bulkIndex);
        ctx.store.set(id, "lastSeen", Date.now());
      }
      persist();

      function accrue(gain) {
        if (!(gain > 0)) return;
        value += gain;
        earned += gain;
        const next = rankIndexFor(earned);
        if (next > rankIndex) {
          rankIndex = next;
          rate = rateOf(levels, RANK_MULT[rankIndex]);
          ctx.toast(`🎉 升职：${RANKS[next].emoji} ${RANKS[next].name}`);
        }
      }

      function refresh() {
        rate = rateOf(levels, RANK_MULT[rankIndex]);
        const rank = RANKS[rankIndex];
        rankName.textContent = `${rank.emoji} ${rank.name}`;

        const nextRank = RANKS[rankIndex + 1];
        if (nextRank) {
          const span = nextRank.need - rank.need;
          const done = Math.max(0, Math.min(1, (earned - rank.need) / span));
          barFill.style.width = `${(done * 100).toFixed(1)}%`;
          bar.setAttribute("aria-valuenow", String(Math.round(done * 100)));
          bar.setAttribute("aria-valuetext", `${rank.name}，距 ${nextRank.name} 还差 ${fmtShort(nextRank.need - earned)}`);
          rankNext.textContent = `距${nextRank.name} 还差 ${fmtShort(nextRank.need - earned)}`;
        } else {
          barFill.style.width = "100%";
          bar.setAttribute("aria-valuenow", "100");
          bar.setAttribute("aria-valuetext", `${rank.name}，已到顶`);
          rankNext.textContent = "已到顶";
        }

        valueNode.textContent = fmtShort(Math.floor(value));
        subNode.replaceChildren(
          "每秒 ",
          MOYU.el("b", { text: fmtShort(rate) }),
          ` · 累计 ${fmtShort(Math.floor(earned))}`,
        );
        tapBtn.textContent = `摸一下  +${fmtShort(clickPower(rate))}`;

        const bulk = BULK_OPTIONS[bulkIndex];
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index];
          const level = levels[index];
          const gainPerLevel = FACILITIES[index].rate * RANK_MULT[rankIndex];
          const cost = costOf(index, level);
          const text = `Lv.${level} · +${fmtShort(gainPerLevel)}/秒`;
          row.desc.textContent = text;
          const maxed = !Number.isFinite(cost);
          const affordable = !maxed && value >= cost;
          row.buy.textContent = maxed ? "满级" : `买 ${fmtShort(cost)}`;
          row.buy.disabled = !affordable;
          row.buy.setAttribute(
            "aria-label",
            maxed
              ? `${FACILITIES[index].name} 已满级`
              : `升级 ${FACILITIES[index].name}，当前 Lv.${level}，${bulk.label}，花费 ${fmtShort(cost)} 摸鱼值`,
          );
          row.row.classList.toggle("affordable", affordable);
        }
      }

      // ── 操作 ──────────────────────────────────────────────────
      function tap() {
        if (!overlay.hidden) return;
        accrue(clickPower(rate));
        refresh();
        valueNode.classList.remove("mg-pop");
        void valueNode.offsetWidth;
        valueNode.classList.add("mg-pop");
      }

      function buyOne(index) {
        const result = purchase({ levels, value }, index, BULK_OPTIONS[bulkIndex].count);
        if (!result.ok) {
          ctx.toast(result.reason === "max" ? "已经升满级了" : "摸鱼值不够，再等等");
          return;
        }
        levels = result.levels;
        value = result.value;
        persist();
        refresh();
        const label = FACILITIES[index].name;
        ctx.toast(result.bought > 1 ? `${label} ×${result.bought} · 花掉 ${fmtShort(result.spent)}` : `${label} 升到 Lv.${result.level}`);
      }

      function selectBulk(index) {
        if (!BULK_OPTIONS[index]) return;
        bulkIndex = index;
        for (const [key, button] of bulkButtons) {
          button.setAttribute("aria-pressed", String(key === index));
        }
        persist();
        refresh();
      }

      requestReset = showReset;

      function showReset() {
        overlayBody.replaceChildren(
          MOYU.el("div", { class: "mg-panel-title", text: "重置工位？" }),
          MOYU.el("div", { class: "mg-panel-text", text: "摸鱼值、装备等级和升职进度都会清零，只保留首页的今日摸鱼计时。" }),
          MOYU.el(
            "div",
            { class: "mg-panel-actions" },
            MOYU.el("button", { class: "mg-btn", type: "button", text: "算了", onclick: () => { overlay.hidden = true; } }),
            MOYU.el("button", { class: "mg-btn primary", type: "button", text: "清零重来", onclick: () => resetAll() }),
          ),
        );
        overlay.hidden = false;
      }

      function resetAll() {
        levels = FACILITIES.map(() => 0);
        value = 0;
        earned = 0;
        rankIndex = 0;
        overlay.hidden = true;
        persist();
        refresh();
        ctx.toast("工位已清空，重新开始");
      }

      // ── 计时：按墙钟算增量，面板被挂起也不丢产出 ────────────────
      let lastTick = Date.now();
      let ticks = 0;
      ctx.interval(() => {
        const now = Date.now();
        const delta = Math.max(0, now - lastTick);
        lastTick = now;
        accrue(rate * (delta / TICK_MS));
        ticks += 1;
        if (ticks % PERSIST_EVERY_TICKS === 0) persist();
        refresh();
      }, TICK_MS);

      const offKey = ctx.key((event) => {
        // 焦点落在按钮上时，Enter/Space 由浏览器转成点击，外壳也拦掉了这里，不会重复计数
        if (event.key !== " " && event.key !== "Enter") return;
        if (!overlay.hidden) return;
        event.preventDefault();
        tap();
      });

      refresh();

      return () => {
        requestReset = null;
        persist();
        offKey();
      };
    },

    restart() {
      if (typeof requestReset === "function") requestReset();
    },

    hubLine(entry) {
      const source = entry && typeof entry === "object" ? entry : {};
      const total = Math.max(0, Math.floor(Number(source.earned) || 0));
      if (total <= 0) return "";
      const rankIndex = rankIndexFor(total);
      return `${RANKS[rankIndex].name} · ${fmtShort(rateOf(readLevels(source), RANK_MULT[rankIndex]))}/秒`;
    },

    _logic: {
      FACILITIES,
      RANKS,
      RANK_MULT,
      BULK_OPTIONS,
      MAX_LEVEL,
      OFFLINE_CAP_MS,
      OFFLINE_EFFICIENCY,
      CONTINUOUS_MS,
      costOf,
      rateOf,
      rankIndexFor,
      clickPower,
      readLevels,
      settleOffline,
      purchase,
      fmtShort,
      fmtDuration,
    },
  };
})();
