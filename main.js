"use strict";

/**
 * 摸鱼小游戏 — PI-Desktop 插件主进程
 *
 * 视图: contributes.views[0] → views/index.html（右侧工作面板，宿主以 file:// 加载）
 *
 * 不碰文件系统。唯一对外的东西是偏好持久化：把每个游戏的最高分 / 设置 / 累计时长存进插件
 * 自己的 settings.json（pi.plugin.setSettings），让「摸鱼进度」跨会话保留。网络只出现在
 * 局域网对局里，而且是用户主动开房 / 加入时才开端口（见 lan.js）。
 * 视图侧 window.pluginBridge.invoke(channel) → 这里 onPanelInvoke(channel, payload)。
 *
 * 通道（视图只能经这些通道读写偏好与对局状态，入参一律在这里清洗）：
 *   games.hello      → { ok, version, prefs, limits }
 *   games.prefs.get  → { ok, version, prefs, limits }
 *   games.prefs.set  → { partial } → { ok, prefs }
 *   lan.status / lan.wait / lan.scan / lan.host / lan.join / lan.leave / lan.move /
 *   lan.action / lan.rename / lan.close   → { ok, status }，出错时带 { code, message }
 * 对局本身按游戏分模块：lan-gomoku.js / lan-zhajinhua.js 只讲规则，lan.js 只讲网络。
 *
 * 宿主对自定义通道的转发超时是 30s（plugin-runtime PLUGIN_PANEL_TIMEOUT_MS）。偏好读写是
 * 纯内存 + 一次同步落盘，远低于上限；局域网长轮询（lan.wait）是唯一故意占掉大半预算的
 * 通道，自己夹在 20s 以内。
 *
 * 局域网对局（lan.*）由 lan.js 承担：面板会话放不开局域网目标，网络只能留在这个进程里。
 */

const SETTINGS_KEY = "moyuPrefs";

/** 偏好形状的防御性上限：视图可能来自旧版本或损坏的 localStorage 回退数据。 */
const MAX_GAME_ENTRIES = 32;
const MAX_ENTRY_KEYS = 16;
const MAX_KEY_LENGTH = 40;
const MAX_STRING_LENGTH = 120;
const MAX_TOTAL_MS = 365 * 24 * 60 * 60 * 1000;
const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** 按天累计只留最近这么多天，避免 settings.json 无限增长。 */
const MAX_DAY_ENTRIES = 31;
let prefs = createEmptyPrefs();

/** 局域网会话（懒创建：没人开房就不占端口，也不建 socket）。 */
let manager = null;

/**
 * 上一次热重载留下的实例会一直占着端口与定时器：宿主重载插件只重新 require 入口模块，
 * 不会替我们调 onUnload，所以加载时就地把旧实例关掉。
 */
function adoptPreviousManager() {
  const previous = globalThis.__moyuLan;
  globalThis.__moyuLan = null;
  if (previous && typeof previous.dispose === "function") {
    try {
      previous.dispose();
    } catch {
      /* 旧实例已经不可用，端口随进程回收 */
    }
  }
}

adoptPreviousManager();

function createEmptyPrefs() {
  return { games: {}, days: {}, totalMs: 0, lastGame: "" };
}

function clampInt(value, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

/** 单个偏好值只收三种类型，其余一律丢弃——不猜、不转换。 */
function sanitizeValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return clampInt(value, -SAFE_INT_MAX, SAFE_INT_MAX);
  if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
  return undefined;
}

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entry = {};
  let kept = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= MAX_ENTRY_KEYS) break;
    if (typeof key !== "string" || !key || key.length > MAX_KEY_LENGTH) continue;
    const clean = sanitizeValue(value);
    if (clean === undefined) continue;
    entry[key] = clean;
    kept += 1;
  }
  return entry;
}

/** 按 key 合并（不是整块替换）：视图一次只提交自己那个游戏的变化。 */
function sanitizePrefs(partial) {
  const next = { ...prefs };
  if (!partial || typeof partial !== "object" || Array.isArray(partial)) return next;

  if (partial.games && typeof partial.games === "object" && !Array.isArray(partial.games)) {
    const games = { ...next.games };
    for (const [id, entry] of Object.entries(partial.games)) {
      if (typeof id !== "string" || !id || id.length > MAX_KEY_LENGTH) continue;
      const existing = games[id] && typeof games[id] === "object" ? games[id] : {};
      if (!(id in games) && Object.keys(games).length >= MAX_GAME_ENTRIES) continue;
      games[id] = { ...existing, ...sanitizeEntry(entry) };
    }
    next.games = games;
  }

  const totalMs = clampInt(partial.totalMs, 0, MAX_TOTAL_MS);
  if (totalMs !== null) next.totalMs = totalMs;
  if (typeof partial.lastGame === "string") {
    next.lastGame = partial.lastGame.slice(0, MAX_KEY_LENGTH);
  }
  // 按天累计时长：键形如 2026-09-24，只保留最近 MAX_DAY_ENTRIES 天
  if (partial.days && typeof partial.days === "object" && !Array.isArray(partial.days)) {
    const days = { ...(next.days && typeof next.days === "object" ? next.days : {}) };
    for (const [day, value] of Object.entries(partial.days)) {
      if (!DAY_KEY_PATTERN.test(day)) continue;
      const ms = clampInt(value, 0, MAX_TOTAL_MS);
      if (ms === null) continue;
      days[day] = ms;
    }
    next.days = Object.fromEntries(Object.keys(days).sort().slice(-MAX_DAY_ENTRIES).map((key) => [key, days[key]]));
  }
  return next;
}

async function handlePrefsSet(payload) {
  prefs = sanitizePrefs(payload?.partial ?? payload ?? {});
  await pi.plugin.setSettings({ [SETTINGS_KEY]: prefs });
  return { ok: true, prefs };
}

function handlePrefsGet() {
  return {
    ok: true,
    version: pi.plugin.getManifest?.()?.version ?? "",
    prefs,
    limits: { maxGameEntries: MAX_GAME_ENTRIES, maxEntryKeys: MAX_ENTRY_KEYS },
  };
}

// ── 局域网对局（lan.*） ──────────────────────────────────────────────

/** 局域网模块与它带的两个规则模块一起重读，改完存盘就能看到效果。 */
const LAN_MODULES = ["./lan.js", "./lan-gomoku.js", "./lan-zhajinhua.js"];
/** 昵称按游戏各存一份；开房前视图总会先 setName，这里只给个初值。 */
const LAN_GAME_IDS = ["gomoku", "zhajinhua"];

function loadLanModule() {
  for (const name of LAN_MODULES) delete require.cache[require.resolve(name)];
  return require("./lan.js");
}

function nicknameFromPrefs() {
  for (const id of LAN_GAME_IDS) {
    const entry = prefs.games && typeof prefs.games[id] === "object" ? prefs.games[id] : null;
    const stored = entry && typeof entry.nickname === "string" ? entry.nickname : "";
    if (stored) return stored;
  }
  return "摸鱼同事";
}

/** 开房参数只收已知字段，游戏 id 必须是字符串，数字必须是有限数。 */
function hostOptions(payload) {
  const options = {};
  if (typeof payload?.game === "string" && payload.game.length <= 32) options.game = payload.game;
  for (const field of ["ante", "cap", "stack"]) {
    if (typeof payload?.[field] === "number" && Number.isFinite(payload[field])) options[field] = payload[field];
  }
  return options;
}

function lanManager() {
  if (!manager) {
    const mod = loadLanModule();
    manager = mod.createLanManager({
      nickname: nicknameFromPrefs(),
      discoveryPort: mod.DISCOVERY_PORT,
      preferredPort: mod.PREFERRED_TCP_PORT,
    });
    globalThis.__moyuLan = manager;
  }
  return manager;
}

/** 视图把昵称和动作放在同一条通道里，省一次往返。 */
function lanWithName(payload) {
  const active = lanManager();
  if (payload && typeof payload.name === "string") active.setName(payload.name);
  return active;
}

/** 每个动作都回带一份最新状态：界面只认 status，不必自己拼中间态。 */
function withStatus(result) {
  return { ...(result && typeof result === "object" ? result : {}), status: lanManager().status() };
}

const LAN_CHANNELS = {
  "lan.status": () => withStatus({ ok: true }),
  "lan.wait": (payload) =>
    lanManager()
      .wait(payload?.since, payload?.timeoutMs)
      .then((status) => ({ ok: true, status })),
  "lan.scan": async (payload) => withStatus(await lanWithName(payload).scan()),
  "lan.host": async (payload) => withStatus(await lanWithName(payload).host(hostOptions(payload))),
  "lan.join": async (payload) =>
    withStatus(await lanWithName(payload).join(payload?.host, payload?.port, payload?.game)),
  "lan.leave": () => withStatus(lanManager().leave()),
  // 离开游戏界面就彻底收摊：发现端口与定时器一并放掉，不留在后台占端口
  "lan.close": () => {
    if (manager) {
      try {
        manager.dispose();
      } catch {
        /* 已经释放过 */
      }
      manager = null;
      globalThis.__moyuLan = null;
    }
    return { ok: true };
  },
  "lan.move": (payload) => withStatus(lanManager().move(payload?.x, payload?.y)),
  "lan.action": (payload) => withStatus(lanManager().intent(payload?.kind, payload)),
  "lan.rename": (payload) => {
    lanManager().setName(payload?.name);
    return withStatus({ ok: true });
  },
};

const CHANNELS = {
  "games.hello": handlePrefsGet,
  "games.prefs.get": handlePrefsGet,
  "games.prefs.set": handlePrefsSet,
  ...LAN_CHANNELS,
};

async function onPanelInvoke(channel, payload) {
  const handler = CHANNELS[channel];
  if (!handler) {
    return { ok: false, code: "UNSUPPORTED", message: `unknown channel: ${channel}` };
  }
  try {
    return await handler(payload ?? {});
  } catch (error) {
    return { ok: false, code: "PANEL_FAILED", message: String(error?.message ?? error) };
  }
}

async function onLoad() {
  try {
    const settings = await pi.plugin.getSettings();
    prefs = sanitizePrefs({ ...createEmptyPrefs(), ...(settings?.[SETTINGS_KEY] ?? {}) });
  } catch {
    /* 读不到设置就保持空偏好：游戏照玩，只是没有历史记录 */
  }
}

function onUnload() {
  if (manager) {
    try {
      manager.dispose();
    } catch {
      /* 进程正在退出，端口和定时器随进程回收 */
    }
    manager = null;
  }
  globalThis.__moyuLan = null;
  prefs = createEmptyPrefs();
}

module.exports = { onLoad, onUnload, onPanelInvoke };
