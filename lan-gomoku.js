"use strict";

/**
 * 局域网五子棋 — 纯规则内核（不碰 socket，可单独单测）
 *
 * 由 lan.js 当作「游戏规则模块」加载，和 lan-zhajinhua.js 是同一套接口：
 *   capacity / minPlayers / intents / roomName(nickname) / create(opts)
 *   seatJoined(state, seat, name, ctx) / seatLeft(state, seat, reason, ctx)
 *   seatRenamed(state, seat, name)
 *   view(state) / intent(state, seat, payload) / advertise(state) / sanitize(raw)
 *
 * 15 路棋盘，黑先白后轮流落子；五连（含长连）判胜，满盘平局。
 * 悔棋要对方同意，弹回「申请方该走」的局面；再来一局要双方各点一次。
 */

const SIZE = 15;
const CELLS = SIZE * SIZE;
const EMPTY_BOARD = "0".repeat(CELLS);
const SEATS = 2;
const MIN_PLAYERS = 2;
const MAX_LOG = 14;
const MAX_NAME_LEN = 24;

const INTENTS = ["move", "resign", "undo.request", "undo.accept", "undo.reject", "undo.cancel", "rematch"];

const DIRS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

// ── 纯逻辑（棋盘与胜负；不碰任何 socket，可直接单测） ─────────────────

function inBoard(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < SIZE && y >= 0 && y < SIZE;
}

function stoneAt(board, x, y) {
  return typeof board === "string" && board.length === CELLS ? board.charAt(y * SIZE + x) : "0";
}

/** 落子后是否成五（含长连）：返回经过该点的连线，否则 null。 */
function lineThrough(board, x, y, seat) {
  const seatChar = String(seat);
  for (const [dx, dy] of DIRS) {
    const points = [{ x, y }];
    for (const sign of [1, -1]) {
      let cx = x + dx * sign;
      let cy = y + dy * sign;
      while (inBoard(cx, cy) && stoneAt(board, cx, cy) === seatChar) {
        points.push({ x: cx, y: cy });
        cx += dx * sign;
        cy += dy * sign;
      }
    }
    if (points.length >= 5) {
      points.sort((left, right) => left.x - right.x || left.y - right.y);
      return points;
    }
  }
  return null;
}

/** 落子：返回新的棋盘与结果，不合法就返回 null（调用方负责提示）。 */
function place(board, x, y, turn) {
  if (!inBoard(x, y) || stoneAt(board, x, y) !== "0") return null;
  const next = board.slice(0, y * SIZE + x) + String(turn) + board.slice(y * SIZE + x + 1);
  const line = lineThrough(next, x, y, turn);
  const full = next.indexOf("0") === -1;
  return { board: next, line, full };
}

/**
 * 悔棋要还原到「申请方该走」的局面：弹掉申请方之后落下的对方棋子，再弹掉申请方自己那一手。
 * 返回新的棋盘与剩余的落子记录。
 */
function undoToRequester(board, moves, requester) {
  const kept = moves.slice();
  let next = board;
  const remove = (move) => {
    const at = move.y * SIZE + move.x;
    next = next.slice(0, at) + "0" + next.slice(at + 1);
  };
  while (kept.length && kept[kept.length - 1].seat !== requester) remove(kept.pop());
  if (kept.length) remove(kept.pop());
  return { board: next, moves: kept };
}

// ── 状态机 ───────────────────────────────────────────────────────────

function log(state, text, level) {
  state.logs.push({ seq: (state.logs[state.logs.length - 1]?.seq || 0) + 1, text: String(text), level: level || "info" });
  if (state.logs.length > MAX_LOG) state.logs.splice(0, state.logs.length - MAX_LOG);
}

function create() {
  return {
    phase: "waiting", // waiting | playing | over
    board: EMPTY_BOARD,
    moves: [],
    turn: 1,
    round: 1,
    startSeat: 1,
    outcome: null,
    undo: null,
    rematch: [],
    score: { 1: 0, 2: 0 },
    names: {},
    logs: [],
  };
}

function occupied(state) {
  return [1, SEATS].filter((seat) => Boolean(state.names[seat]));
}

function endRound(state, outcome) {
  state.phase = "over";
  state.outcome = outcome;
  state.undo = null;
  state.rematch = [];
  if (outcome.type === "win" || outcome.type === "resign" || outcome.type === "offline") {
    state.score[outcome.seat] = (state.score[outcome.seat] || 0) + 1;
  }
}

function startRound(state) {
  state.phase = "playing";
  state.board = EMPTY_BOARD;
  state.moves = [];
  state.outcome = null;
  state.undo = null;
  state.rematch = [];
  state.turn = state.startSeat;
}

function rematchReady(state) {
  const seats = occupied(state);
  return seats.length === SEATS && seats.every((seat) => state.rematch.includes(seat));
}

function seatJoined(state, seat, name, ctx) {
  state.names[seat] = String(name || `同事${seat}`).slice(0, MAX_NAME_LEN);
  log(state, `${state.names[seat]} 入座`, "good");
  const seated = ctx && Array.isArray(ctx.occupied) ? ctx.occupied.length : occupied(state).length;
  // 两边都坐齐就开局；打完一局后不自动重开，等双方各点一次「下一局」
  if (seated >= SEATS && state.phase === "waiting") {
    startRound(state);
    log(state, `第 ${state.round} 局开始，${state.names[state.startSeat] || "黑方"} 先手`, "good");
  }
  return null;
}

function seatLeft(state, seat, reason) {
  const name = state.names[seat];
  if (!name) return null;
  log(state, `${name} 离开（${reason || "连接断开"}）`, "warn");
  // 对局中走人＝认输，保留结果让留下来的人看到「对手掉线，你赢了」
  if (state.phase === "playing") {
    endRound(state, { type: "offline", seat: seat === 1 ? 2 : 1, by: seat, reason: reason || "closed" });
  }
  delete state.names[seat];
  return null;
}

function seatRenamed(state, seat, name) {
  if (!state.names[seat]) return null;
  state.names[seat] = String(name || state.names[seat]).slice(0, MAX_NAME_LEN);
  return null;
}

/** 处理一次意图。返回 null 表示已生效，返回字符串表示给界面看的拒绝原因。 */
function intent(state, seat, payload) {
  const kind = typeof payload?.kind === "string" ? payload.kind : "";
  if (!state.names[seat]) return "你不在这个房间里";

  if (kind === "move") {
    if (state.phase !== "playing") return "现在不能落子";
    if (seat !== state.turn) return "还没轮到你";
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!inBoard(x, y)) return "落子位置不对";
    const placed = place(state.board, x, y, seat);
    if (!placed) return "这个点不能落子";
    state.board = placed.board;
    state.moves.push({ x, y, seat });
    if (placed.line) endRound(state, { type: "win", seat, line: placed.line });
    else if (placed.full) endRound(state, { type: "draw" });
    else state.turn = seat === 1 ? 2 : 1;
    return null;
  }

  if (kind === "resign") {
    if (state.phase !== "playing") return "现在不能认输";
    endRound(state, { type: "resign", seat: seat === 1 ? 2 : 1, by: seat });
    log(state, `${state.names[seat]} 认输`, "warn");
    return null;
  }

  if (kind === "undo.request") {
    if (state.phase !== "playing") return "现在不能悔棋";
    if (state.undo) return "已经有一个悔棋请求在等回复";
    const last = state.moves[state.moves.length - 1];
    if (!last || last.seat !== seat) return "等对方落子之后才能悔棋";
    state.undo = { by: seat };
    log(state, `${state.names[seat]} 请求悔棋`, "info");
    return null;
  }

  if (kind === "undo.accept" || kind === "undo.reject") {
    if (!state.undo) return "没有待回复的悔棋请求";
    if (state.undo.by === seat) return "这是你自己提的悔棋";
    if (kind === "undo.accept") {
      const restored = undoToRequester(state.board, state.moves, state.undo.by);
      state.board = restored.board;
      state.moves = restored.moves;
      state.turn = state.undo.by;
      log(state, `${state.names[seat]} 同意了悔棋`, "info");
    } else {
      log(state, `${state.names[seat]} 不同意悔棋`, "warn");
    }
    state.undo = null;
    return null;
  }

  if (kind === "undo.cancel") {
    if (state.undo && state.undo.by === seat) {
      state.undo = null;
      log(state, `${state.names[seat]} 撤回了悔棋请求`, "info");
    }
    return null;
  }

  if (kind === "rematch") {
    if (state.phase !== "over") return "这局还没结束";
    if (!state.rematch.includes(seat)) state.rematch.push(seat);
    if (rematchReady(state)) {
      state.round += 1;
      state.startSeat = state.startSeat === 1 ? 2 : 1;
      startRound(state);
      log(state, `第 ${state.round} 局开始，${state.names[state.startSeat] || "黑方"} 先手`, "good");
    }
    return null;
  }

  return "不认识的操作";
}

// ── 视图 ─────────────────────────────────────────────────────────────

/** 五子棋没有暗信息：同一份快照发给两边，座位号只是留给界面对照。 */
function view(state) {
  return {
    game: "gomoku",
    phase: state.phase,
    board: state.board,
    turn: state.turn,
    round: state.round,
    startSeat: state.startSeat,
    score: { 1: state.score[1] || 0, 2: state.score[2] || 0 },
    outcome: state.outcome,
    undo: state.undo ? { by: state.undo.by } : null,
    rematch: state.rematch.slice(),
    lastMove: state.moves.length ? state.moves[state.moves.length - 1] : null,
    moves: state.moves.length,
    names: { 1: state.names[1] || "", 2: state.names[2] || "" },
    log: state.logs.slice(-6),
  };
}

function advertise(state) {
  return {
    game: "gomoku",
    players: occupied(state).length,
    cap: SEATS,
    phase: state.phase,
  };
}

function roomName(nickname) {
  return `${nickname} 的棋桌`;
}

/** 对端发来的快照只当数据看：棋盘形状不对就退回空盘，其余字段夹到合法范围。 */
function seatOf(value) {
  return value === 2 ? 2 : 1;
}

function countOf(value, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const rounded = Math.round(num);
  return rounded < 0 || rounded > max ? 0 : rounded;
}

function sanitize(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const board =
    typeof raw.board === "string" && raw.board.length === CELLS && /^[0-2]+$/.test(raw.board) ? raw.board : EMPTY_BOARD;
  const source = raw.outcome && typeof raw.outcome === "object" && !Array.isArray(raw.outcome) ? raw.outcome : null;
  const undo = raw.undo && typeof raw.undo === "object" && !Array.isArray(raw.undo) ? { by: seatOf(raw.undo.by) } : null;
  const last = raw.lastMove && Number.isFinite(Number(raw.lastMove.x)) ? raw.lastMove : null;
  return {
    ...raw,
    game: "gomoku",
    phase: raw.phase === "playing" || raw.phase === "over" ? raw.phase : "waiting",
    board,
    turn: seatOf(raw.turn),
    round: Math.max(1, countOf(raw.round, 100000)),
    startSeat: seatOf(raw.startSeat),
    score: { 1: countOf(raw.score?.[1], CELLS), 2: countOf(raw.score?.[2], CELLS) },
    // 连线只留坐标，坏点直接丢掉
    outcome: source
      ? {
          type: String(source.type ?? "").slice(0, 12),
          seat: countOf(source.seat, SEATS),
          by: countOf(source.by, SEATS),
          reason: String(source.reason ?? "").slice(0, 24),
          line: Array.isArray(source.line)
            ? source.line
                .filter((point) => inBoard(Number(point?.x), Number(point?.y)))
                .slice(0, CELLS)
                .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
            : null,
        }
      : null,
    undo,
    rematch: (Array.isArray(raw.rematch) ? raw.rematch : []).filter((seat) => seat === 1 || seat === 2).slice(0, SEATS),
    lastMove: last ? { x: Number(last.x), y: Number(last.y), seat: seatOf(last.seat) } : null,
    moves: countOf(raw.moves, CELLS),
    names: { 1: String(raw.names?.[1] ?? "").slice(0, MAX_NAME_LEN), 2: String(raw.names?.[2] ?? "").slice(0, MAX_NAME_LEN) },
    log: (Array.isArray(raw.log) ? raw.log : []).slice(-6).map((line) => ({
      text: String(line?.text ?? "").slice(0, 80),
      level: ["info", "good", "warn", "error"].includes(line?.level) ? line.level : "info",
    })),
  };
}

module.exports = {
  id: "gomoku",
  title: "局域网五子棋",
  capacity: SEATS,
  minPlayers: MIN_PLAYERS,
  intents: INTENTS,
  roomName,
  create,
  seatJoined,
  seatLeft,
  seatRenamed,
  view,
  intent,
  advertise,
  sanitize,
  _logic: {
    SIZE,
    CELLS,
    SEATS,
    EMPTY_BOARD,
    INTENTS,
    inBoard,
    stoneAt,
    place,
    lineThrough,
    undoToRequester,
    create,
    occupied,
    startRound,
    intent,
    view,
    advertise,
    sanitize,
  },
};
