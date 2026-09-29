"use strict";

/**
 * 局域网对局层 — 插件主进程里唯一的网络代码
 *
 * 为什么写在这里而不是视图里：面板会话放开商只允许 file: / data: / blob: / devtools: /
 * chrome-extension: / plugin-asset: 与清单里已声明的 net.domains（宿主
 * applyPluginEgressPolicy），视图连不到局域网对端；插件主进程是 Electron utilityProcess，
 * 能直接 require("node:net" / "node:dgram")。
 *
 * 这一层只管「怎么把消息送到对面」：UDP 房间发现、TCP 按行分帧、心跳、座位分配、
 * 按座位分发快照。规则不在这里 —— 每个游戏是一个规则模块（lan-gomoku.js /
 * lan-zhajinhua.js），只通过这组钩子打交道：
 *   capacity / minPlayers / intents / roomName(nickname) / create(opts)
 *   seatJoined(state, seat, name, ctx) / seatLeft(state, seat, reason, ctx)
 *   seatRenamed(state, seat, name)
 *   view(state, seat) / intent(state, seat, payload) / advertise(state) / sanitize(raw)
 *
 * 房间是「主机权威」：主机进程持有唯一一份对局状态，客户端只发意图，收到的是整份快照。
 * 客户端不重算规则，也就不会和主机分叉；暗牌这类只给本人的信息由 view(state, seat) 裁剪。
 *
 * 线格式：TCP 上按行（\n）分帧的 JSON，单行上限 MAX_LINE_BYTES；UDP 只做房间发现，
 * 不参与对局。两边来的东西都当不可信数据：超长帧、越界字段、坏快照一律拒绝或清洗。
 */

const dgram = require("node:dgram");
const net = require("node:net");
const os = require("node:os");

const GOMOKU = require("./lan-gomoku.js");
const ZHAJINHUA = require("./lan-zhajinhua.js");

/** 两个游戏各一个规则模块；新增游戏只要在这里挂上就能被开房 / 加入。 */
const GAMES = { gomoku: GOMOKU, zhajinhua: ZHAJINHUA };
const DEFAULT_GAME = "gomoku";

const PROTO = 2;
const MAGIC = "moyu-lan-1";
const DISCOVERY_PORT = 39731;
/** 主机优先占用这个端口，被占用时退到系统分配的临时端口。 */
const PREFERRED_TCP_PORT = 39732;
const ANNOUNCE_MS = 1500;
const ROOM_TTL_MS = 5000;
const PROBE_MIN_MS = 1200;
const HEARTBEAT_MS = 2000;
const PEER_TIMEOUT_MS = 7000;
const MAX_LINE_BYTES = 8192;
const MAX_BUFFER_BYTES = 64 * 1024;
const MAX_NAME_LEN = 24;
const LOG_LIMIT = 12;
const WAIT_MAX_MS = 20000;
/** 加入握手最多等这么久：TCP 的 connect 也会叫醒长轮询，不能只等第一次唤醒。 */
const JOIN_SETTLE_MS = 3000;
const JOIN_TICK_MS = 200;
const MAX_INTENT_TEXT = 32;
const MAX_INTENT_VALUE = 1000000;

/** 发现报文里除了这几个字段，其余标量字段（底注、封顶…）原样透传给房间列表。 */
const PACKET_RESERVED = new Set(["magic", "proto", "kind", "roomId", "name", "host", "port", "game", "players", "cap", "phase"]);

/** 意图里允许出现的数值字段：客户端只能报这几个数，其余一律丢掉。 */
const INTENT_FIELDS = ["x", "y", "to", "target"];

// ── 输入清洗 ─────────────────────────────────────────────────────────

function cleanName(value, fallback) {
  if (typeof value !== "string") return fallback;
  // 去掉控制字符与换行，顺便避免终端/日志里出现换行注入
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_NAME_LEN);
  return cleaned || fallback;
}

function cleanPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
}

function cleanHost(value) {
  if (typeof value !== "string") return "";
  const host = value.trim();
  return host.length > 0 && host.length <= 64 ? host : "";
}

/**
 * 只认主机名/IP 字面量：禁止把 URL、路径、空格之类塞进来当连接目标。
 * 主机名允许字母数字、点、横线、下划线；IP 字面量交给 net.connect 自己判定。
 */
function isConnectableHost(host) {
  return /^[A-Za-z0-9._-]+$/.test(host) || /^[0-9a-fA-F:]+$/.test(host);
}

/** 本机 IPv4：调用点（每次 status 轮询）比网卡变化频繁得多，缓存 5 秒。 */
let addressCache = { at: 0, list: [] };
function localAddresses() {
  const at = Date.now();
  if (at - addressCache.at < 5000) return addressCache.list;
  const result = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item && item.family === "IPv4" && !item.internal) result.push(item.address);
    }
  }
  addressCache = { at, list: result };
  return result;
}

// ── 快照清洗（通用闸门 + 各游戏自己的形状校验） ───────────────────────

const MAX_SNAPSHOT_DEPTH = 6;
const MAX_SNAPSHOT_KEYS = 64;
const MAX_SNAPSHOT_TEXT = 256;
const MAX_SNAPSHOT_BYTES = 16 * 1024;
/** 这几个键一旦被赋值就会改掉原型，必须挡在赋值之前。 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function sanitizeValue(value, depth) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === "boolean") return value;
  if (type === "number") return Number.isFinite(value) ? value : 0;
  if (type === "string") return value.slice(0, MAX_SNAPSHOT_TEXT);
  if (depth >= MAX_SNAPSHOT_DEPTH) return null;
  if (Array.isArray(value)) {
    const list = [];
    for (const item of value.slice(0, MAX_SNAPSHOT_KEYS)) list.push(sanitizeValue(item, depth + 1));
    return list;
  }
  if (type === "object") {
    const result = {};
    let kept = 0;
    for (const [key, item] of Object.entries(value)) {
      if (kept >= MAX_SNAPSHOT_KEYS) break;
      if (UNSAFE_KEYS.has(key) || key.length > 40) continue;
      result[key] = sanitizeValue(item, depth + 1);
      kept += 1;
    }
    return result;
  }
  return null;
}

/** 通用闸门：形状、深度、字段数、字符串长度与整包大小都压在上限内。 */
function sanitizeSnapshot(raw) {
  const clean = sanitizeValue(raw, 0);
  if (!clean || typeof clean !== "object" || Array.isArray(clean)) return null;
  let text = "";
  try {
    text = JSON.stringify(clean);
  } catch {
    return null;
  }
  return text.length > MAX_SNAPSHOT_BYTES ? null : clean;
}

function acceptSnapshot(rules, raw) {
  const clean = sanitizeSnapshot(raw);
  if (!clean) return null;
  return typeof rules.sanitize === "function" ? rules.sanitize(clean) : clean;
}

// ── 发现报文 ─────────────────────────────────────────────────────────

function parsePacket(raw) {
  const text = typeof raw === "string" ? raw : String(raw);
  if (text.length > 512 || text.charCodeAt(0) !== 0x7b) return null; // 只认 JSON 对象
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || payload.magic !== MAGIC) return null;
  if (payload.proto !== PROTO) return null;
  if (payload.kind !== "room" && payload.kind !== "who") return null;
  return payload;
}

// ── 管理器 ───────────────────────────────────────────────────────────

/**
 * deps.now / deps.discoveryPort / deps.preferredPort / deps.games 只为测试注入。
 * 视图侧只看 status()：一次拿全，长轮询比对 seq。
 */
function createLanManager(deps) {
  const options = deps || {};
  const registry = options.games && typeof options.games === "object" ? options.games : GAMES;
  const clock = typeof options.now === "function" ? options.now : () => Date.now();
  const discoveryPort = cleanPort(options.discoveryPort) || DISCOVERY_PORT;
  const preferredPort = cleanPort(options.preferredPort) || PREFERRED_TCP_PORT;

  let nickname = cleanName(options.nickname, "摸鱼同事");
  let seq = 0;
  let mode = "idle";
  let seat = 0;
  let room = null;
  let tcpPort = 0;
  let lastError = null;
  let udpState = "off";
  let lastPacketAt = 0;
  let lastProbeAt = 0;
  const rooms = new Map();
  const logLines = [];
  const waiters = new Set();
  const conns = new Map(); // 主机侧：连接 id → 连接
  let server = null;
  let udp = null;
  let client = null; // 加入方只有一条连接
  let timers = [];
  let connSeq = 0;

  function log(text, level) {
    logLines.push({ seq: (logLines[logLines.length - 1]?.seq || 0) + 1, text: String(text), level: level || "info" });
    if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT);
  }

  function bump() {
    seq += 1;
    for (const waiter of [...waiters]) waiter();
    waiters.clear();
  }

  function note(text, level) {
    log(text, level);
    bump();
  }

  function setError(code, message) {
    lastError = { code, message };
    log(`${message}`, "error");
    bump();
  }

  function rulesFor(id) {
    return registry[id] || null;
  }

  function currentRules() {
    return room ? rulesFor(room.game) : null;
  }

  // ── 房间与座位（主机侧） ─────────────────────────────────────

  function occupiedSeats() {
    if (!room) return [];
    const list = [];
    for (let index = 1; index <= room.rules.capacity; index += 1) {
      if (room.seats[index]) list.push(index);
    }
    return list;
  }

  function nextFreeSeat() {
    if (!room) return 0;
    for (let index = 1; index <= room.rules.capacity; index += 1) {
      if (!room.seats[index]) return index;
    }
    return 0;
  }

  function seatContext() {
    return { occupied: occupiedSeats(), capacity: room ? room.rules.capacity : 0 };
  }

  /** 每个座位一份快照：主机自己是 seat 1，其余按连接座位裁。 */
  function snapshotFor(target) {
    if (!room) return null;
    const clean = room.rules.sanitize(room.rules.view(room.state, target));
    return clean ? { ...clean, roomId: room.id } : null;
  }

  function advert() {
    if (!room) return {};
    const raw = room.rules.advertise(room.state);
    return raw && typeof raw === "object" ? raw : {};
  }

  function roomPacket() {
    const packet = {
      magic: MAGIC,
      proto: PROTO,
      kind: "room",
      roomId: room.id,
      name: room.name,
      host: nickname,
      port: tcpPort,
    };
    // 游戏自定义的标量（底注 / 封顶 / 筹码）一起广播，房间列表里就能直接看到
    for (const [field, value] of Object.entries(advert())) {
      if (typeof value === "number" && Number.isFinite(value)) packet[field] = value;
      else if (typeof value === "string") packet[field] = cleanName(value, "");
    }
    return packet;
  }

  function broadcastState() {
    if (mode !== "hosting" || !room) return;
    room.match = snapshotFor(1);
    for (const conn of conns.values()) send(conn.socket, { t: "state", seq, state: snapshotFor(conn.seat) });
    bump();
  }

  // ── UDP：房间发现 ────────────────────────────────────────────

  function ensureUdp() {
    if (udp) return;
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", (error) => {
      udpState = `error:${error.code || error.message}`;
      setError("UDP_FAILED", `局域网发现不可用（${error.code || error.message}）`);
      try {
        socket.close();
      } catch {
        /* 已经关了 */
      }
      if (udp === socket) udp = null;
    });
    socket.on("message", (buffer, rinfo) => {
      lastPacketAt = clock();
      const packet = parsePacket(buffer.toString("utf8"));
      if (!packet) return;
      if (packet.kind === "who") {
        if (mode === "hosting" && room && server) {
          const reply = Buffer.from(JSON.stringify(roomPacket()));
          socket.send(reply, 0, reply.length, rinfo.port, rinfo.address, () => {});
        }
        return;
      }
      if (mode === "hosting" && room && packet.roomId === room.id) return;
      rememberRoom(packet, rinfo);
    });
    socket.bind({ port: discoveryPort, address: "0.0.0.0", exclusive: false }, () => {
      try {
        socket.setBroadcast(true);
      } catch (error) {
        udpState = `error:${error.code || error.message}`;
      }
      udpState = udpState === "off" ? "ok" : udpState;
      bump();
    });
    udp = socket;
  }

  function rememberRoom(packet, rinfo) {
    const port = cleanPort(packet.port);
    if (!port || !rinfo || !rinfo.address) return;
    const key = `${rinfo.address}:${port}`;
    const game = typeof packet.game === "string" && rulesFor(packet.game) ? packet.game : "";
    const entry = {
      key,
      addr: rinfo.address,
      port,
      roomId: cleanName(packet.roomId, ""),
      name: cleanName(packet.name, "局域网房间"),
      host: cleanName(packet.host, "摸鱼同事"),
      game,
      players: Number(packet.players) || 0,
      cap: Number(packet.cap) || 0,
      phase: typeof packet.phase === "string" ? packet.phase : "waiting",
      extra: {},
      seenAt: clock(),
    };
    for (const [field, value] of Object.entries(packet)) {
      if (PACKET_RESERVED.has(field)) continue;
      if (typeof value === "number" && Number.isFinite(value)) entry.extra[field] = value;
      else if (typeof value === "string") entry.extra[field] = cleanName(value, "");
    }
    rooms.set(key, entry);
    bump();
  }

  function broadcastPacket(packet) {
    if (!udp) return;
    const payload = Buffer.from(JSON.stringify(packet));
    try {
      udp.setBroadcast(true);
    } catch {
      /* 某些网卡不支持广播：下面还有手动 IP 兜底 */
    }
    udp.send(payload, 0, payload.length, discoveryPort, "255.255.255.255", () => {});
  }

  function announce() {
    if (mode !== "hosting" || !room || !server || !udp) return;
    broadcastPacket(roomPacket());
  }

  function probe(force) {
    if (!udp) return;
    const at = clock();
    if (!force && at - lastProbeAt < PROBE_MIN_MS) return;
    lastProbeAt = at;
    broadcastPacket({ magic: MAGIC, proto: PROTO, kind: "who" });
  }

  function pruneRooms() {
    const at = clock();
    let removed = false;
    for (const [key, entry] of rooms) {
      if (at - entry.seenAt > ROOM_TTL_MS) {
        rooms.delete(key);
        removed = true;
      }
    }
    if (removed) bump();
  }

  // ── TCP：对局通道 ────────────────────────────────────────────

  /** 按行分帧读取；超长帧直接断开，避免内存被拖垮。每个数据块都回调 onActivity 供心跳使用。 */
  function attachReader(socket, onMessage, onClose, onActivity) {
    let buffer = "";
    socket.setEncoding("utf8");
    const fail = (reason) => {
      socket.destroy();
      onClose(reason);
    };
    socket.on("data", (chunk) => {
      if (onActivity) onActivity();
      buffer += chunk;
      if (buffer.length > MAX_BUFFER_BYTES) {
        fail("too_much_data");
        return;
      }
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.length > MAX_LINE_BYTES) {
          fail("line_too_long");
          return;
        }
        if (line) {
          let message = null;
          try {
            message = JSON.parse(line);
          } catch {
            message = null;
          }
          if (message && typeof message === "object") onMessage(message);
        }
        index = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => fail("socket_error"));
    socket.on("close", () => onClose("closed"));
  }

  function send(socket, message) {
    if (!socket || socket.destroyed || !socket.writable) return;
    try {
      socket.write(`${JSON.stringify(message)}\n`);
    } catch {
      /* 对端已断：交给 close 事件收尾 */
    }
  }

  /** 意图只留白名单里的字段，而且必须是有限数；NaN 过 JSON 会变成 null，绝不能放过去。 */
  function cleanIntent(kind, payload) {
    const body = { kind };
    if (!payload || typeof payload !== "object") return body;
    for (const field of INTENT_FIELDS) {
      if (payload[field] === undefined) continue;
      const value = Number(payload[field]);
      if (!Number.isFinite(value)) continue;
      body[field] = Math.max(-MAX_INTENT_VALUE, Math.min(MAX_INTENT_VALUE, Math.round(value)));
    }
    return body;
  }

  /** 主机处理一次意图；返回给界面看的提示文本（可为 null）。 */
  function applyIntent(target, payload) {
    if (mode !== "hosting" || !room) return "你还没在房间里";
    if (!room.seats[target]) return "你不在这个房间里";
    const kind = typeof payload?.kind === "string" ? payload.kind.slice(0, MAX_INTENT_TEXT) : "";
    if (!room.rules.intents.includes(kind)) return "不认识的操作";
    return room.rules.intent(room.state, target, payload);
  }

  function hostConnClosed(conn, reason) {
    if (!conns.has(conn.id)) return;
    conns.delete(conn.id);
    const seatIndex = conn.seat;
    if (!seatIndex || !room) return;
    room.seats[seatIndex] = null;
    room.online[seatIndex] = false;
    const text = reason === "closed" || !reason ? "连接断开" : String(reason);
    room.rules.seatLeft(room.state, seatIndex, text, seatContext());
    note(`第 ${seatIndex} 位的连接结束（${text}）`, "warn");
    broadcastState();
  }

  function handleHostMessage(conn, message) {
    if (!room) return;
    const type = String(message.t || "");
    if (type === "ping") {
      send(conn.socket, { t: "pong" });
      return;
    }
    if (type !== "intent") return;
    const problem = applyIntent(conn.seat, cleanIntent(message.intent?.kind, message.intent));
    if (problem) send(conn.socket, { t: "reject", reason: problem });
    else broadcastState();
  }

  function handleHostConnection(socket) {
    connSeq += 1;
    const conn = { id: `c${connSeq}`, socket, seat: 0, lastSeen: clock() };
    let greeted = false;
    const onClose = (reason) => {
      if (!conns.has(conn.id)) return;
      hostConnClosed(conn, reason);
    };
    attachReader(
      socket,
      (message) => {
        if (!greeted) {
          greeted = true;
          if (String(message.t) !== "hello" || Number(message.proto) !== PROTO) {
            send(socket, { t: "bye", reason: Number(message.proto) === PROTO ? "bad_hello" : "proto_mismatch" });
            socket.end();
            return;
          }
          if (typeof message.game === "string" && message.game && message.game !== room.game) {
            send(socket, { t: "bye", reason: "game_mismatch" });
            socket.end();
            return;
          }
          const free = nextFreeSeat();
          if (!free) {
            send(socket, { t: "bye", reason: "room_full" });
            socket.end();
            return;
          }
          conn.seat = free;
          conns.set(conn.id, conn);
          room.seats[free] = { id: cleanName(message.id, "peer"), name: cleanName(message.name, `同事${free}`) };
          room.online[free] = true;
          room.rules.seatJoined(room.state, free, room.seats[free].name, seatContext());
          send(socket, {
            t: "welcome",
            proto: PROTO,
            game: room.game,
            seat: free,
            roomId: room.id,
            name: room.name,
            state: snapshotFor(free),
          });
          broadcastState();
          return;
        }
        handleHostMessage(conn, message);
      },
      onClose,
      () => {
        conn.lastSeen = clock();
      },
    );
  }

  function teardownHosting() {
    for (const conn of conns.values()) {
      send(conn.socket, { t: "bye", reason: "host_left" });
      conn.socket.destroy();
    }
    conns.clear();
    if (server) {
      try {
        server.close();
      } catch {
        /* 已经关了 */
      }
      server = null;
    }
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function startHosting(request) {
    if (mode !== "idle") return { ok: false, code: "BUSY", message: "已经在房间里了" };
    const wanted = typeof request?.game === "string" && registry[request.game] ? request.game : DEFAULT_GAME;
    const rules = registry[wanted];
    ensureUdp();
    room = {
      id: `r${clock().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
      name: rules.roomName(nickname),
      game: wanted,
      rules,
      state: rules.create(request || {}),
      seats: {},
      online: {},
      match: null,
    };
    seat = 1;
    room.seats[1] = { id: selfId(), name: nickname };
    room.online[1] = true;
    rules.seatJoined(room.state, 1, nickname, seatContext());
    mode = "hosting";
    room.match = snapshotFor(1);

    server = net.createServer(handleHostConnection);
    /** 先试固定端口（方便对方手动填写 IP:端口），被占用就退到系统分配。 */
    const startListening = (port, allowFallback) => {
      const onError = (error) => {
        if (allowFallback && error.code === "EADDRINUSE") {
          startListening(0, false);
          return;
        }
        setError("TCP_FAILED", `开房失败（${error.code || error.message}）`);
      };
      server.once("error", onError);
      server.once("listening", () => {
        server.removeListener("error", onError);
        server.on("error", (error) => setError("TCP_FAILED", `房间连接出错（${error.code || error.message}）`));
        tcpPort = server.address().port;
        announce();
        note(`${rules.title}房间已开：本机 ${localAddresses().join(" / ") || "127.0.0.1"}:${tcpPort}`, "good");
        bump();
      });
      server.listen(port, "0.0.0.0");
    };
    startListening(preferredPort, true);
    // 监听是异步的：等端口真的起来（或失败）再回话，房主才能立刻看到 IP:端口
    if (!tcpPort && !lastError) await wait(3000);
    if (tcpPort) return { ok: true };
    const failure = lastError || { code: "TCP_TIMEOUT", message: "开房超时：端口没有起来" };
    // 端口没起来就彻底收摊，别留一个没有端口的「房间中」
    leave();
    return { ok: false, ...failure };
  }

  function selfId() {
    return options.id || "self";
  }

  // ── 加入方 ──────────────────────────────────────────────────

  function adoptWelcome(message) {
    const gameId = typeof message.game === "string" ? message.game : "";
    const rules = rulesFor(gameId);
    if (!rules) {
      setError("UNKNOWN_GAME", `对方开的游戏这个版本的插件还不认识（${cleanName(gameId, "未知")}），两边都更新一下再试`);
      return false;
    }
    const target = Number(message.seat);
    if (!Number.isInteger(target) || target < 1 || target > rules.capacity) {
      setError("BAD_SEAT", "对方给的座位号不对，无法入座");
      return false;
    }
    seat = target;
    room = {
      id: cleanName(message.roomId, ""),
      name: cleanName(message.name, "局域网房间"),
      game: gameId,
      rules,
      seats: {},
      online: {},
      match: acceptSnapshot(rules, message.state),
    };
    lastError = null;
    note(`已加入「${room.name}」（第 ${seat} 位）`, "good");
    return true;
  }

  function handleClientMessage(session, message) {
    // 旧连接的迟到消息不能动新连接的状态
    if (client !== session) return;
    const type = String(message.t || "");
    if (type === "ping") {
      send(session.socket, { t: "pong" });
      return;
    }
    if (type === "welcome") {
      if (Number(message.proto) !== PROTO) {
        setError("PROTO_MISMATCH", "对方的插件版本和这里不一致，无法对局");
        stopClient();
        mode = "idle";
        seat = 0;
        room = null;
        return;
      }
      if (adoptWelcome(message) && mode === "joining") mode = "joined";
      return;
    }
    if (type === "state") {
      if (!room) return;
      const next = acceptSnapshot(room.rules, message.state);
      if (next) {
        room.match = next;
        bump();
      }
      return;
    }
    if (type === "reject") {
      note(String(message.reason || "操作被拒绝"), "warn");
      return;
    }
    if (type === "bye") {
      const reason = String(message.reason || "closed");
      stopClient();
      mode = "idle";
      seat = 0;
      room = null;
      if (reason === "host_left") note("房主关闭了房间", "warn");
      else if (reason === "room_full") setError("ROOM_FULL", "房间已经坐满了");
      else if (reason === "proto_mismatch") setError("PROTO_MISMATCH", "对方的插件版本和这里不一致，无法对局");
      else if (reason === "game_mismatch") setError("GAME_MISMATCH", "对方开的是别的游戏，去那个游戏里加入");
      else setError("PEER_BYE", `连接被对方结束（${reason}）`);
    }
  }

  function stopClient() {
    const session = client;
    if (!session) return;
    client = null;
    session.closed = true;
    try {
      session.socket.destroy();
    } catch {
      /* 已经断了 */
    }
  }

  /** 加入房间：等握手结果（欢迎 / 被拒 / 连不上）再回话，界面不用自己猜。 */
  async function join(targetHost, targetPort, wantGame) {
    if (mode !== "idle") return { ok: false, code: "BUSY", message: "已经在房间里了" };
    const host = cleanHost(targetHost);
    const port = cleanPort(targetPort);
    if (!host || !isConnectableHost(host)) return { ok: false, code: "BAD_HOST", message: "填一个对方的 IP 或主机名" };
    if (!port) return { ok: false, code: "BAD_PORT", message: "端口要在 1-65535 之间" };
    const game = typeof wantGame === "string" && registry[wantGame] ? wantGame : "";
    ensureUdp();
    mode = "joining";
    seat = 0;
    room = null;
    lastError = null;
    const socket = net.createConnection({ host, port });
    const session = { socket, host, port, lastSeen: clock(), closed: false };
    client = session;
    const onClose = (reason) => {
      // 这个 socket 的 close 可能比下一次 join 还晚到，所以只认自己那一次会话
      if (session.closed) return;
      session.closed = true;
      if (client !== session) return;
      client = null;
      const wasJoined = seat > 0;
      if (mode === "joining") {
        mode = "idle";
        seat = 0;
        setError("JOIN_FAILED", `连不上 ${host}:${port}（${reason}）`);
        return;
      }
      if (wasJoined) {
        mode = "idle";
        seat = 0;
        room = null;
        setError("PEER_GONE", `与房主的连接断了（${reason}）`);
      }
    };
    socket.on("connect", () => {
      if (client !== session) return;
      session.lastSeen = clock();
      send(session.socket, { t: "hello", proto: PROTO, name: nickname, id: selfId(), game });
      bump();
    });
    attachReader(
      socket,
      (message) => handleClientMessage(session, message),
      onClose,
      () => {
        session.lastSeen = clock();
      },
    );
    const deadline = clock() + JOIN_SETTLE_MS;
    while (mode === "joining" && !lastError && clock() < deadline) await waitFor(seq, JOIN_TICK_MS);
    if (mode === "joined") return { ok: true };
    if (lastError) return { ok: false, ...lastError };
    return { ok: true, pending: true };
  }

  // ── 心跳与清理 ───────────────────────────────────────────────

  function heartbeat() {
    const at = clock();
    if (mode === "hosting" && room) {
      for (const conn of [...conns.values()]) {
        if (at - conn.lastSeen > PEER_TIMEOUT_MS) {
          hostConnClosed(conn, "对端超过 7 秒没有响应");
          continue;
        }
        send(conn.socket, { t: "ping" });
      }
    }
    if ((mode === "joined" || mode === "joining") && client) {
      if (at - client.lastSeen > PEER_TIMEOUT_MS) {
        const closing = client;
        client = null;
        try {
          closing.socket.destroy();
        } catch {
          /* 已经断了 */
        }
        mode = "idle";
        seat = 0;
        room = null;
        setError("PEER_TIMEOUT", "和房主失联了（超过 7 秒没有响应）");
        return;
      }
      send(client.socket, { t: "ping" });
    }
  }

  function startTimers() {
    stopTimers();
    timers = [
      setInterval(() => {
        if (mode === "hosting") announce();
        if (mode === "idle") probe(false);
        pruneRooms();
      }, ANNOUNCE_MS),
      setInterval(heartbeat, HEARTBEAT_MS),
    ];
  }

  function stopTimers() {
    for (const timer of timers) clearInterval(timer);
    timers = [];
  }

  // ── 对外的视图接口 ───────────────────────────────────────────

  function roomInfo() {
    if (!room) return null;
    const snapshot = room.match || {};
    const names = snapshot.names && typeof snapshot.names === "object" ? snapshot.names : {};
    const seated = Object.keys(names).filter((key) => names[key]).length;
    return {
      id: room.id,
      name: room.name,
      game: room.game,
      players: mode === "hosting" ? occupiedSeats().length : seated,
      cap: room.rules.capacity,
      phase: typeof snapshot.phase === "string" ? snapshot.phase : "waiting",
    };
  }

  function status() {
    return {
      ok: true,
      seq,
      proto: PROTO,
      mode,
      seat,
      game: room ? room.game : "",
      self: {
        name: nickname,
        addrs: localAddresses(),
        discoveryPort,
        tcpPort: mode === "hosting" ? tcpPort : 0,
      },
      room: roomInfo(),
      rooms: [...rooms.values()]
        .sort((left, right) => right.seenAt - left.seenAt)
        .slice(0, 12)
        .map((entry) => ({
          key: entry.key,
          addr: entry.addr,
          port: entry.port,
          roomId: entry.roomId,
          name: entry.name,
          host: entry.host,
          game: entry.game,
          players: entry.players,
          cap: entry.cap,
          phase: entry.phase,
          extra: entry.extra,
          ageMs: Math.max(0, clock() - entry.seenAt),
        })),
      match: room ? room.match : null,
      log: logLines.slice(-6),
      error: lastError,
      diag: {
        udp: udpState,
        tcp:
          mode === "hosting"
            ? tcpPort
              ? `listening:${tcpPort}`
              : "starting"
            : mode === "joining"
              ? "connecting"
              : mode === "joined"
                ? "connected"
                : "off",
        lastPacketAt,
        lastProbeAt,
      },
    };
  }

  function waitFor(since, timeoutMs) {
    const sinceSeq = Number(since);
    const budget = Math.max(200, Math.min(WAIT_MAX_MS, Number(timeoutMs) || 8000));
    if (!Number.isFinite(sinceSeq) || seq > sinceSeq) return Promise.resolve(status());
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        waiters.delete(finish);
        clearTimeout(timer);
        resolve(status());
      };
      const timer = setTimeout(finish, budget);
      waiters.add(finish);
    });
  }

  function intent(kind, payload) {
    const clean = typeof kind === "string" ? kind.slice(0, MAX_INTENT_TEXT) : "";
    if (!room) return { ok: false, code: "NOT_IN_ROOM", message: "你还没在房间里" };
    if (!room.rules.intents.includes(clean)) return { ok: false, code: "BAD_INTENT", message: "不认识的操作" };
    const body = cleanIntent(clean, payload);
    if (mode === "hosting") {
      const problem = applyIntent(1, body);
      if (problem) return { ok: false, code: "REJECTED", message: problem };
      broadcastState();
      return { ok: true };
    }
    if (mode === "joined" && client) {
      send(client.socket, { t: "intent", intent: body });
      return { ok: true };
    }
    return { ok: false, code: "NOT_IN_ROOM", message: "你还没在房间里" };
  }

  /** 落子走的是通用意图通道，只是先挡掉明显不是坐标的入参。 */
  function move(x, y) {
    const cx = Number(x);
    const cy = Number(y);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return { ok: false, code: "BAD_MOVE", message: "落子位置不对" };
    return intent("move", { x: cx, y: cy });
  }

  function setName(value) {
    nickname = cleanName(value, nickname);
    if (room && mode === "hosting" && room.seats[1]) {
      room.seats[1].name = nickname;
      room.rules.seatRenamed(room.state, 1, nickname);
      broadcastState();
    }
    bump();
    return { ok: true, name: nickname };
  }

  function leave() {
    const wasHost = mode === "hosting";
    teardownHosting();
    stopClient();
    mode = "idle";
    seat = 0;
    room = null;
    tcpPort = 0;
    lastError = null;
    if (wasHost) note("房间已关闭", "info");
    bump();
    return { ok: true };
  }

  function dispose() {
    stopTimers();
    stopHosting();
    stopClient();
    if (udp) {
      try {
        udp.close();
      } catch {
        /* 已经关了 */
      }
      udp = null;
    }
    udpState = "off";
    mode = "idle";
    room = null;
    tcpPort = 0;
    rooms.clear();
    waiters.clear();
    return { ok: true };
  }

  function stopHosting() {
    teardownHosting();
    mode = "idle";
    room = null;
    tcpPort = 0;
  }

  /** 发现端口的绑定是异步的：等它落地（或失败）再回话，界面一进来就能看到房间列表。 */
  async function scan() {
    ensureUdp();
    probe(true);
    if (udpState === "off") await waitFor(seq, 1500);
    return status();
  }

  if (options.autoStart !== false) startTimers();

  return {
    status,
    wait: waitFor,
    scan,
    host: startHosting,
    join,
    leave,
    dispose,
    move,
    intent,
    setName,
    localAddresses,
    /** 规则模块的 id → 标题，视图用来在房间列表里标注是哪个游戏。 */
    gameTitle: (id) => (rulesFor(id) ? rulesFor(id).title : ""),
  };
}

module.exports = {
  PROTO,
  MAGIC,
  DISCOVERY_PORT,
  PREFERRED_TCP_PORT,
  GAMES,
  DEFAULT_GAME,
  createLanManager,
  // 纯逻辑，供单测与复用
  _logic: {
    cleanName,
    cleanPort,
    cleanHost,
    isConnectableHost,
    parsePacket,
    sanitizeSnapshot,
    acceptSnapshot,
    localAddresses,
  },
};
