"use strict";

/**
 * 摸鱼小游戏 — PI-Desktop 插件主进程
 *
 * 视图: contributes.views[0] → views/index.html（右侧工作面板，宿主以 file:// 加载）
 *
 * 本插件不碰文件系统与网络，只做一件事：把每个游戏的最高分 / 设置 / 累计时长
 * 存进插件自己的 settings.json（pi.plugin.setSettings），让「摸鱼进度」跨会话保留。
 * 视图侧 window.pluginBridge.invoke(channel) → 这里 onPanelInvoke(channel, payload)。
 *
 * 通道（视图只能经这三个通道读写偏好，写操作必须过这里的清洗）：
 *   games.hello      → { ok, version, prefs, limits }
 *   games.prefs.get  → { ok, version, prefs, limits }
 *   games.prefs.set  → { partial } → { ok, prefs }
 *
 * 宿主对自定义通道的转发超时是 30s（plugin-runtime PLUGIN_PANEL_TIMEOUT_MS），
 * 这三个通道都是纯内存 + 一次同步落盘，远低于上限。
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

const CHANNELS = {
  "games.hello": handlePrefsGet,
  "games.prefs.get": handlePrefsGet,
  "games.prefs.set": handlePrefsSet,
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
  prefs = createEmptyPrefs();
}

module.exports = { onLoad, onUnload, onPanelInvoke };
