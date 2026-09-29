"use strict";

/**
 * 局域网炸金花 — 纯规则内核（不碰 socket，可单独单测）
 *
 * 被 lan.js 当作「游戏规则模块」加载：lan.js 只负责发现、分帧、心跳与长轮询，
 * 桌面状态与全部判定都在这里。房主权威：只有房主跑这份状态机，客户端只发意图。
 *
 * 本文件实现的口径（README 里对玩家写的是同一套）：
 *   · 牌型大小：豹子 > 顺金 > 金花 > 顺子 > 对子 > 散牌；同档逐张比，完全相同比花色（♠ > ♥ > ♣ > ♦）。
 *   · A23 是最小的顺子（按 1-2-3 算，最大牌记作 3）；QKA 是最大的顺子。
 *   · 「235 吃豹子」：2-3-5 三张**不同花色**时算特殊牌，赢豹子；对其他牌型按普通散牌比（而它本来就是最小的散牌，所以只会输）。同花 235 是金花，不享受特殊。
 *   · 下注不是「一次性补齐」而是**按轮**：每一轮每个还在场的人都要按当前注额再下一次，直到只剩一人、或封顶后全员跟到、或到达轮数上限，然后摊牌。
 *   · 闷牌（没看牌）每次只出明牌的一半，但按「明牌等效额」计数，所以闷牌跟注和明牌是同一个进度。
 *
 * 全下与边池：筹码不够跟注时可以全下，差额进边池；结算按每人实际投入分层，
 * 每层只由「投入不少于该层门槛」的人参与比牌。
 */

const SUITS = ["d", "c", "h", "s"]; // ♦ ♣ ♥ ♠ —— 下标越大越强，用于同档比花色
const SUIT_LABEL = { d: "♦", c: "♣", h: "♥", s: "♠" };
const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };
const CARD_BACK = { r: 0, s: -1 };

const CAPACITY = 5;
const MIN_PLAYERS = 2;
/** 轮数上限：防止大家都在低注额上一直跟下去，保证每局一定会结束。 */
const MAX_ROUNDS = 8;
const MAX_LOG = 14;
const MAX_NAME_LEN = 24;
const MAX_MONEY = 100000000;

const DEFAULTS = { ante: 10, cap: 200, stack: 2000 };

const INTENTS = ["look", "fold", "call", "raise", "compare", "next"];

const HAND_TYPES = [
  { key: "high", label: "散牌", rank: 0 },
  { key: "pair", label: "对子", rank: 1 },
  { key: "straight", label: "顺子", rank: 2 },
  { key: "flush", label: "金花", rank: 3 },
  { key: "straightflush", label: "顺金", rank: 4 },
  { key: "trips", label: "豹子", rank: 5 },
];

const TYPE_BY_RANK = HAND_TYPES.reduce((map, item) => {
  map[item.rank] = item;
  return map;
}, {});

// ── 牌与牌型 ─────────────────────────────────────────────────────────

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.round(num);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

function cardRank(card) {
  return card && Number.isInteger(card.r) ? card.r : 0;
}

function cardSuit(card) {
  return card && Number.isInteger(card.s) ? card.s : 0;
}

function makeDeck() {
  const deck = [];
  for (let suit = 0; suit < SUITS.length; suit += 1) {
    for (let rank = 2; rank <= 14; rank += 1) deck.push({ r: rank, s: suit });
  }
  return deck;
}

/** Fisher–Yates；`random` 可注入以便测试复现。 */
function shuffle(deck, random) {
  const rnd = typeof random === "function" ? random : Math.random;
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}

/**
 * 顺子的最大牌：A23 按 1-2-3 算，返回 3；其余返回最大的那张。
 * 不是顺子返回 0。
 */
function straightHigh(ranks) {
  const sorted = ranks.slice().sort((left, right) => left - right);
  if (sorted[0] === 2 && sorted[1] === 3 && sorted[2] === 14) return 3; // A 当 1
  if (sorted[1] === sorted[0] + 1 && sorted[2] === sorted[1] + 1) return sorted[2];
  return 0;
}

/**
 * 评估三张牌的牌型。返回可比较的分值对象：
 *   { rank, label, tiebreak: [..], suitOrder, special235, cards }
 * 比较顺序：先 rank，再 tiebreak 数组，最后按牌面从大到小逐张比花色（♠ > ♥ > ♣ > ♦）。
 */
function evaluate(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) return null;
  const ranks = cards.map(cardRank).sort((left, right) => right - left); // 降序
  const suits = cards.map(cardSuit);
  const flush = suits[0] === suits[1] && suits[1] === suits[2];
  // 同档比花色时按牌面从大到小逐张比，先比最大的那张
  const suitOrder = cards
    .slice()
    .sort((left, right) => cardRank(right) - cardRank(left) || cardSuit(right) - cardSuit(left))
    .map(cardSuit);
  const high = straightHigh(ranks);

  const base = (type, tiebreak) => ({
    rank: type.rank,
    label: type.label,
    tiebreak,
    suitOrder,
    special235: false,
    cards: cards.map((card) => ({ r: card.r, s: card.s })),
  });

  // 豹子
  if (ranks[0] === ranks[1] && ranks[1] === ranks[2]) {
    return base(HAND_TYPES[5], [ranks[0]]);
  }
  // 同花顺
  if (flush && high) return base(HAND_TYPES[4], [high]);
  // 金花
  if (flush) return base(HAND_TYPES[3], ranks.slice());
  // 顺子
  if (high) return base(HAND_TYPES[2], [high]);
  // 对子
  if (ranks[0] === ranks[1] || ranks[1] === ranks[2]) {
    const pairRank = ranks[0] === ranks[1] ? ranks[0] : ranks[1];
    const kicker = ranks[0] === ranks[1] ? ranks[2] : ranks[0];
    return base(HAND_TYPES[1], [pairRank, kicker]);
  }
  // 散牌；2-3-5 不同花色是「吃豹子」的特殊牌
  const value = base(HAND_TYPES[0], ranks.slice());
  const ascending = ranks.slice().sort((left, right) => left - right);
  if (ascending[0] === 2 && ascending[1] === 3 && ascending[2] === 5) {
    value.special235 = true;
  }
  return value;
}

/**
 * 比较两手牌：a 大返回 1，b 大返回 -1，完全相同（含花色）返回 0。
 * 特殊牌只改「对豹子」这一条：其余照常比，而 235 本身就是最小的散牌。
 */
function compareValues(a, b) {
  if (!a || !b) return 0;
  if (a.special235 && b.rank === HAND_TYPES[5].rank) return 1;
  if (b.special235 && a.rank === HAND_TYPES[5].rank) return -1;

  if (a.rank !== b.rank) return a.rank > b.rank ? 1 : -1;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i += 1) {
    const left = a.tiebreak[i] || 0;
    const right = b.tiebreak[i] || 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  for (let i = 0; i < a.suitOrder.length; i += 1) {
    if (a.suitOrder[i] !== b.suitOrder[i]) return a.suitOrder[i] > b.suitOrder[i] ? 1 : -1;
  }
  return 0;
}

function compareHands(cardsA, cardsB) {
  return compareValues(evaluate(cardsA), evaluate(cardsB));
}

// ── 边池 ─────────────────────────────────────────────────────────────

/**
 * 按每人实际投入分层，返回 [{ amount, eligible: [seat…] }]，从主池到最外层。
 * 全下的人只参与到自己投入额度那一层。
 */
function buildPots(entries) {
  const rows = entries
    .filter((row) => row.committed > 0)
    .map((row) => ({ seat: row.seat, committed: row.committed, folded: Boolean(row.folded) }));
  const levels = [...new Set(rows.map((row) => row.committed))].sort((left, right) => left - right);
  const pots = [];
  let previous = 0;
  for (const level of levels) {
    const step = level - previous;
    if (step <= 0) continue;
    const contributors = rows.filter((row) => row.committed >= level);
    const amount = step * contributors.length;
    const eligible = contributors.filter((row) => !row.folded).map((row) => row.seat);
    // 这一层没人能赢（全是弃牌的人出的）→ 并入上一层，别凭空多出一个池
    if (!eligible.length && pots.length) {
      pots[pots.length - 1].amount += amount;
    } else {
      pots.push({ amount, eligible });
    }
    previous = level;
  }
  return pots;
}

// ── 桌面状态机 ───────────────────────────────────────────────────────

function log(table, text, level) {
  table.logs.push({ seq: (table.logs[table.logs.length - 1]?.seq || 0) + 1, text: String(text), level: level || "info" });
  if (table.logs.length > MAX_LOG) table.logs.splice(0, table.logs.length - MAX_LOG);
}

function create(options) {
  const opts = options || {};
  return {
    phase: "waiting", // waiting | playing | over
    hand: 0,
    ante: clampInt(opts.ante, 1, 100000, DEFAULTS.ante),
    cap: clampInt(opts.cap, 1, 1000000, DEFAULTS.cap),
    stack: clampInt(opts.stack, 1, 10000000, DEFAULTS.stack),
    maxRounds: MAX_ROUNDS,
    players: {}, // seat -> player
    dealer: 1,
    turn: 0,
    currentBet: 0,
    roundOf: 0,
    pot: 0,
    outcome: null,
    logs: [],
  };
}

function seatedSeats(table) {
  return Object.keys(table.players)
    .map(Number)
    .sort((left, right) => left - right);
}

/** 本局在桌上、还没弃牌的人。 */
function activeSeats(table) {
  return seatedSeats(table).filter((seat) => !table.players[seat].folded && table.players[seat].inHand);
}

/** 还能做决定的人：本局在桌、没弃牌、筹码没全下。 */
function actingSeats(table) {
  return activeSeats(table).filter((seat) => !table.players[seat].allIn);
}

function playerOf(table, seat) {
  return table.players[seat] || null;
}

function firstSeat(table) {
  return seatedSeats(table)[0] || 1;
}

/** 升序座位里 `from` 之后的第一个；`from` 不在列表里（弃牌、离座）也能正确接力。 */
function nextIn(seats, from) {
  if (!seats.length) return 0;
  const after = seats.find((seat) => seat > from);
  return after === undefined ? seats[0] : after;
}

function nextSeat(table, from) {
  return nextIn(seatedSeats(table), from);
}

function nextTurn(table) {
  return nextIn(actingSeats(table), table.turn);
}

/** 建一位玩家。名字由传输层带来；这里只保证形状可用。 */
function makePlayer(seat, name) {
  return {
    seat,
    name: String(name || `同事${seat}`).slice(0, MAX_NAME_LEN),
    stack: 0,
    committed: 0,
    bet: 0,
    level: 0,
    looked: false,
    folded: false,
    allIn: false,
    inHand: false,
    cards: [],
  };
}

function seatJoined(table, seat, name) {
  const player = makePlayer(seat, name);
  player.stack = table.stack;
  table.players[seat] = player;
  log(table, table.phase === "playing" ? `${player.name} 入座（下一局开始）` : `${player.name} 入座`, "good");
  return null;
}

/**
 * 有人离开牌桌（主动退出或连接断开）。局中离开＝弃牌：他投进去的钱留在池里，
 * 牌摊不了但池子不能少。`reason` 只影响日志措辞。
 */
function seatLeft(table, seat, reason) {
  const player = playerOf(table, seat);
  if (!player) return null;
  const how = reason ? String(reason).slice(0, 16) : "离开了牌桌";
  if (table.phase === "playing" && player.inHand && !player.folded) {
    player.folded = true;
    log(table, `${player.name} ${how}（视为弃牌）`, "warn");
    settleIfHandOver(table);
  } else {
    log(table, `${player.name} ${how}`, "warn");
  }
  if (table.phase !== "playing") {
    delete table.players[seat];
    if (table.dealer === seat) table.dealer = firstSeat(table);
  } else {
    player.away = true;
  }
  return null;
}

/** 连接断开：和「离开」同一套处理，只是日志里说清楚是掉线。 */
function seatOffline(table, seat) {
  return seatLeft(table, seat, "掉线了");
}

/** 改昵称：把牌桌上这个名字一起改掉，别让日志里还是旧名字。 */
function seatRenamed(table, seat, name) {
  const player = playerOf(table, seat);
  if (player) player.name = String(name || player.name).slice(0, MAX_NAME_LEN);
  return null;
}

function beginHand(table, random) {
  const seats = seatedSeats(table).filter((seat) => table.players[seat].stack > 0);
  if (seats.length < MIN_PLAYERS) return "至少要有两个人，而且都得有筹码";

  table.hand += 1;
  table.phase = "playing";
  table.outcome = null;
  table.pot = 0;
  table.roundOf = 1;
  table.currentBet = 0;
  // 先把所有人清空：筹码不够的人本局不发牌，也不参与判定
  for (const seat of seatedSeats(table)) {
    const player = table.players[seat];
    player.bet = 0;
    player.level = 0;
    player.committed = 0;
    player.looked = false;
    player.folded = false;
    player.allIn = false;
    player.inHand = false;
    player.cards = [];
    player.away = false;
  }

  const deck = shuffle(makeDeck(), random);
  let cursor = 0;
  for (const seat of seats) {
    table.players[seat].inHand = true;
    table.players[seat].cards = [deck[cursor], deck[cursor + 1], deck[cursor + 2]];
    cursor += 3;
  }

  // 底注先入池，然后下注额从底注起步（跟一轮就要再出一次底注）
  let anteTotal = 0;
  for (const seat of seats) {
    const player = table.players[seat];
    const paid = Math.min(player.stack, table.ante);
    player.stack -= paid;
    player.committed += paid;
    if (player.stack === 0) player.allIn = true;
    anteTotal += paid;
  }
  table.pot = anteTotal;
  table.currentBet = table.ante;
  // 庄家每局轮转，庄家的下家先说话
  table.dealer = nextSeat(table, table.dealer);
  table.turn = nextSeat(table, table.dealer);
  log(table, `第 ${table.hand} 局开始：底注 ${table.ante}，单注封顶 ${table.cap}`, "good");
  return null;
}

function payInto(table, player, amount) {
  const paid = Math.max(0, Math.min(player.stack, Math.round(amount)));
  player.stack -= paid;
  player.committed += paid;
  player.bet += paid;
  // 闷牌出的钱按两倍记进「明牌等效额」，所以跟注进度和明牌是一条线
  player.level += player.looked ? paid : paid * 2;
  table.pot += paid;
  if (player.stack === 0) player.allIn = true;
  return paid;
}

/** 把注额补齐到当前注额所需的筹码：闷牌只出明牌的一半。 */
function callCost(table, player) {
  const shortfall = Math.max(0, table.currentBet - player.level);
  return player.looked ? shortfall : Math.ceil(shortfall / 2);
}

/**
 * 一轮结束（能说话的人都跟到了）之后怎么走。
 * 返回 "continue"（这一轮还没跟完，轮下一个人）/ "round"（新的一轮开始）/ "over"（本局结束）。
 * "round" 与 "over" 都由这里定好下一手该谁说话，调用方不要再改 `table.turn`。
 */
function advanceRound(table) {
  const pending = actingSeats(table);
  const everyoneCalled = pending.every((seat) => table.players[seat].level >= table.currentBet);
  if (!everyoneCalled) return "continue";

  // 只剩一个人还能说话：不必再让他一轮一轮地掏钱，直接开牌
  if (pending.length <= 1) {
    showdown(table, "只剩一个人还能下注，开牌");
    return "over";
  }
  const capped = table.currentBet >= table.cap;
  if (capped || table.roundOf >= table.maxRounds) {
    showdown(table, capped ? `注额到顶（${table.cap}），开牌` : `打到第 ${table.roundOf} 轮，开牌`);
    return "over";
  }
  table.roundOf += 1;
  // 新一轮重新计：每一轮每个还在场的人都要按当前注额再下一次
  for (const seat of activeSeats(table)) {
    table.players[seat].bet = 0;
    table.players[seat].level = 0;
  }
  table.turn = nextIn(actingSeats(table), table.dealer);
  log(table, `第 ${table.roundOf} 轮：当前注额 ${table.currentBet}`, "info");
  return "round";
}

function findWinner(table, seats) {
  let best = seats[0];
  for (const seat of seats.slice(1)) {
    if (compareHands(table.players[seat].cards, table.players[best].cards) > 0) best = seat;
  }
  return best;
}

/** 只剩一个人没弃牌：直接收池，不摊牌。 */
function settleUncontested(table, winnerSeat) {
  const winner = table.players[winnerSeat];
  winner.stack += table.pot;
  table.outcome = {
    type: "uncontested",
    winners: [{ seat: winnerSeat, name: winner.name, amount: table.pot }],
    reveal: {},
  };
  table.phase = "over";
  table.turn = 0;
  log(table, `${winner.name} 收下底池 ${table.pot}`, "good");
}

/** 摊牌：按边池分层，每层用该层有资格的人比牌。 */
function showdown(table, reason) {
  const entries = seatedSeats(table).map((seat) => ({
    seat,
    committed: table.players[seat].committed,
    folded: table.players[seat].folded || !table.players[seat].inHand,
  }));
  const pots = buildPots(entries);
  const payouts = {};
  const detail = [];
  for (const pot of pots) {
    if (!pot.eligible.length) continue;
    const winner = findWinner(table, pot.eligible);
    payouts[winner] = (payouts[winner] || 0) + pot.amount;
    detail.push({ seat: winner, amount: pot.amount, from: pot.eligible.slice() });
  }
  for (const [seat, amount] of Object.entries(payouts)) {
    table.players[Number(seat)].stack += amount;
  }
  const reveal = {};
  for (const seat of activeSeats(table)) reveal[seat] = table.players[seat].cards.map((card) => ({ r: card.r, s: card.s }));
  table.outcome = {
    type: "showdown",
    reason,
    winners: detail.map((row) => ({ seat: row.seat, name: table.players[row.seat].name, amount: row.amount })),
    pots: pots.map((pot) => ({ amount: pot.amount, eligible: pot.eligible })),
    reveal,
  };
  table.phase = "over";
  table.turn = 0;
  const text = detail.map((row) => `${table.players[row.seat].name} 赢 ${row.amount}`).join("，");
  log(table, `摊牌：${text || "没人能赢"}`);
}

/** 只剩一个人没弃牌就收池；一个人都没有时本局作废。返回是否已经结束本局。 */
function settleIfHandOver(table) {
  const alive = activeSeats(table);
  if (alive.length > 1) return false;
  if (!alive.length) {
    // 所有人都走了（含房主掉线）：池子原路退回，避免凭空吞掉筹码
    for (const seat of seatedSeats(table)) table.players[seat].stack += table.players[seat].committed;
    table.pot = 0;
    table.phase = "waiting";
    table.outcome = null;
    table.turn = 0;
    log(table, "牌桌上没人了，本局作废", "warn");
    return true;
  }
  settleUncontested(table, alive[0]);
  return true;
}

function requireTurn(table, seat) {
  if (table.phase !== "playing") return "现在没有进行中的牌局";
  if (!playerOf(table, seat)?.inHand) return "你这一局没在牌桌上";
  if (table.players[seat].folded) return "你这一局已经弃牌了";
  if (table.players[seat].allIn) return "你已经全下了，等开牌";
  if (table.turn !== seat) return "还没轮到你";
  return null;
}

/**
 * 处理一次意图。返回 null 表示已生效，返回字符串表示给界面看的拒绝原因。
 * 所有判定都在这里，客户端只发意图、不算规则。
 */
function intent(table, seat, payload) {
  const kind = String(payload?.kind || "");
  const player = playerOf(table, seat);
  if (!player) return "你不在这个牌桌上";

  // 看牌不消耗行动，局中随时可以
  if (kind === "look") {
    if (table.phase !== "playing" || !player.inHand) return "现在没什么可看的";
    if (player.looked) return "你已经看过牌了";
    player.looked = true;
    log(table, `${player.name} 看了牌`, "info");
    return null;
  }

  // 开新局：等人阶段和上一局结束后都能点
  if (kind === "next") {
    if (table.phase === "playing") return "这一局还没结束";
    return beginHand(table);
  }

  const problem = requireTurn(table, seat);
  if (problem) return problem;

  if (kind === "fold") {
    player.folded = true;
    log(table, `${player.name} 弃牌`, "warn");
    if (settleIfHandOver(table)) return null;
    const step = advanceRound(table);
    if (step === "continue") table.turn = nextTurn(table);
    return null;
  }

  if (kind === "call") {
    const cost = callCost(table, player);
    const paid = payInto(table, player, cost);
    if (paid < cost) log(table, `${player.name} 全下 ${paid}（少于跟注额）`, "warn");
    else log(table, `${player.name} 跟注 ${paid}`, "info");
    const step = advanceRound(table);
    if (step === "continue") table.turn = nextTurn(table);
    return null;
  }

  if (kind === "raise") {
    const target = clampInt(payload?.to, 0, 1000000, 0);
    if (!target || target <= table.currentBet) return `加注要到 ${table.currentBet + 1} 以上`;
    if (target > table.cap) return `单注封顶 ${table.cap}`;
    const shortfall = Math.max(0, target - player.level);
    const want = player.looked ? shortfall : Math.ceil(shortfall / 2);
    const paid = payInto(table, player, want);
    if (paid < want) {
      // 筹码不够加到这个数：按全下处理，注额不抬到目标值
      log(table, `${player.name} 全下 ${paid}，注额没抬到 ${target}`, "warn");
    } else {
      table.currentBet = target;
      log(table, `${player.name} 加注到 ${target}`, "good");
    }
    const step = advanceRound(table);
    if (step === "continue") table.turn = nextTurn(table);
    return null;
  }

  if (kind === "compare") {
    const target = Number(payload?.target);
    const victim = playerOf(table, target);
    if (!victim || !victim.inHand || victim.folded) return "找不到要比牌的人";
    if (target === seat) return "不能和自己比牌";
    if (!player.looked) return "先看牌才能比牌";
    if (activeSeats(table).length < 2) return "现在没有可比的人";
    payInto(table, player, callCost(table, player));
    const result = compareHands(player.cards, victim.cards);
    if (result > 0) {
      victim.folded = true;
      log(table, `${player.name} 和 ${victim.name} 比牌：${player.name} 赢`, "good");
    } else {
      player.folded = true;
      log(table, `${player.name} 和 ${victim.name} 比牌：${victim.name} 赢`, "warn");
    }
    if (settleIfHandOver(table)) return null;
    const step = advanceRound(table);
    if (step === "continue") table.turn = nextTurn(table);
    return null;
  }

  return "不认识的操作";
}

// ── 视图（手牌只发给看牌的人；摊牌后公开） ───────────────────────────

function cardsOf(cards) {
  return (cards || []).map((card) => ({ r: card.r, s: card.s }));
}

/** 座位 → 昵称。传输层和界面都从这里取名字，免得两处各记一份。 */
function nameMap(table) {
  const names = {};
  for (const seat of seatedSeats(table)) names[seat] = table.players[seat].name;
  return names;
}

/** 给某个座位看的桌面。`seat` 为 0 表示旁观/未入座：看不到任何人的牌。 */
function view(table, seat) {
  const me = playerOf(table, seat);
  const players = seatedSeats(table).map((each) => {
    const player = table.players[each];
    const revealed = Boolean(table.outcome?.reveal?.[each]);
    // 闷牌的人连自己都拿不到自己的牌：牌压根不发到界面，就不靠前端藏
    // （否则「闷牌只付一半」成了稳赚：不出全价还能看自己的牌）
    const show = revealed || (each === seat && Boolean(player.looked));
    return {
      seat: each,
      name: player.name,
      stack: player.stack,
      bet: player.bet,
      committed: player.committed,
      looked: Boolean(player.looked || revealed),
      folded: Boolean(player.folded || !player.inHand),
      inHand: Boolean(player.inHand),
      allIn: Boolean(player.allIn),
      away: Boolean(player.away),
      online: player.online !== false,
      turn: table.turn === each && table.phase === "playing",
      cards: show ? cardsOf(player.cards) : [CARD_BACK, CARD_BACK, CARD_BACK],
      // 亮出来的牌给个牌型名，省得对面自己数
      holding: show && player.cards.length === 3 ? evaluate(player.cards)?.label || "" : "",
    };
  });
  return {
    game: "zhajinhua",
    phase: table.phase,
    hand: table.hand,
    roundOf: table.roundOf,
    maxRounds: table.maxRounds,
    ante: table.ante,
    cap: table.cap,
    stack: table.stack,
    pot: table.pot,
    currentBet: table.currentBet,
    dealer: table.dealer,
    turn: table.turn,
    seat,
    looked: Boolean(me?.looked),
    folded: Boolean(me?.folded),
    inHand: Boolean(me?.inHand),
    allIn: Boolean(me?.allIn),
    // 跟注要掏多少：闷牌是一半，全下的人不用再掏
    toCall: me && me.inHand && !me.folded && !me.allIn ? callCost(table, me) : 0,
    minRaise: Math.min(table.cap, table.currentBet + Math.max(table.ante, 1)),
    canNext: table.phase !== "playing" && seatedSeats(table).filter((each) => table.players[each].stack > 0).length >= MIN_PLAYERS,
    players,
    names: nameMap(table),
    outcome: table.outcome
      ? {
          type: table.outcome.type,
          reason: table.outcome.reason || "",
          winners: table.outcome.winners.map((row) => ({ seat: row.seat, name: row.name, amount: row.amount })),
          pots: (table.outcome.pots || []).map((pot) => ({ amount: pot.amount, eligible: pot.eligible.slice() })),
        }
      : null,
    log: table.logs.slice(-6),
  };
}

/** 房间列表里给对方看的摘要（不含任何手牌信息）。 */
function advertise(table) {
  return {
    game: "zhajinhua",
    players: activeSeats(table).length || seatedSeats(table).length,
    cap: CAPACITY,
    phase: table.phase,
    ante: table.ante,
    limit: table.cap,
    stack: table.stack,
  };
}

function roomName(nickname) {
  return `${nickname} 的牌桌`;
}

/**
 * 对端发来的桌面只当数据看：数字夹到合法区间、玩家数组按座位数截断，
 * 其余字段沿用传输层的通用清洗结果。房主自己也走这一条，两边形状才会完全一致。
 */
function sanitize(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const players = (Array.isArray(raw.players) ? raw.players : []).slice(0, CAPACITY).map((item) => {
    const row = item && typeof item === "object" ? item : {};
    return {
      ...row,
      seat: clampInt(row.seat, 1, CAPACITY, 0),
      name: String(row.name ?? "").slice(0, MAX_NAME_LEN),
      stack: clampInt(row.stack, 0, MAX_MONEY, 0),
      bet: clampInt(row.bet, 0, MAX_MONEY, 0),
      committed: clampInt(row.committed, 0, MAX_MONEY, 0),
      looked: row.looked === true,
      folded: row.folded === true,
      inHand: row.inHand === true,
      allIn: row.allIn === true,
      away: row.away === true,
      online: row.online !== false,
      turn: row.turn === true,
      holding: String(row.holding ?? "").slice(0, 8),
      cards: (Array.isArray(row.cards) ? row.cards : []).slice(0, 3).map((card) => {
        const r = clampInt(card?.r, 2, 14, 0);
        return r ? { r, s: clampInt(card?.s, 0, 3, 0) } : { ...CARD_BACK };
      }),
    };
  });
  const names = {};
  if (raw.names && typeof raw.names === "object" && !Array.isArray(raw.names)) {
    for (let index = 1; index <= CAPACITY; index += 1) {
      const value = raw.names[index];
      if (typeof value === "string" && value) names[index] = value.slice(0, MAX_NAME_LEN);
    }
  }
  const source = raw.outcome && typeof raw.outcome === "object" && !Array.isArray(raw.outcome) ? raw.outcome : null;
  const outcome = source
    ? {
        type: String(source.type ?? "").slice(0, 12),
        reason: String(source.reason ?? "").slice(0, 48),
        winners: (Array.isArray(source.winners) ? source.winners : []).slice(0, CAPACITY).map((row) => ({
          seat: clampInt(row?.seat, 1, CAPACITY, 0),
          name: String(row?.name ?? "").slice(0, MAX_NAME_LEN),
          amount: clampInt(row?.amount, 0, MAX_MONEY, 0),
        })),
        pots: (Array.isArray(source.pots) ? source.pots : []).slice(0, CAPACITY).map((pot) => ({
          amount: clampInt(pot?.amount, 0, MAX_MONEY, 0),
          eligible: (Array.isArray(pot?.eligible) ? pot.eligible : []).slice(0, CAPACITY).map((each) => clampInt(each, 1, CAPACITY, 0)),
        })),
      }
    : null;
  return {
    ...raw,
    game: "zhajinhua",
    phase: raw.phase === "playing" || raw.phase === "over" ? raw.phase : "waiting",
    hand: clampInt(raw.hand, 0, 100000, 0),
    roundOf: clampInt(raw.roundOf, 0, MAX_ROUNDS, 0),
    maxRounds: MAX_ROUNDS,
    ante: clampInt(raw.ante, 1, 100000, DEFAULTS.ante),
    cap: clampInt(raw.cap, 1, 1000000, DEFAULTS.cap),
    stack: clampInt(raw.stack, 1, 10000000, DEFAULTS.stack),
    pot: clampInt(raw.pot, 0, MAX_MONEY, 0),
    currentBet: clampInt(raw.currentBet, 0, 1000000, 0),
    dealer: clampInt(raw.dealer, 0, CAPACITY, 0),
    turn: clampInt(raw.turn, 0, CAPACITY, 0),
    seat: clampInt(raw.seat, 0, CAPACITY, 0),
    looked: raw.looked === true,
    folded: raw.folded === true,
    inHand: raw.inHand === true,
    allIn: raw.allIn === true,
    toCall: clampInt(raw.toCall, 0, 1000000, 0),
    minRaise: clampInt(raw.minRaise, 0, 1000000, 0),
    canNext: raw.canNext === true,
    players,
    names,
    outcome,
    log: (Array.isArray(raw.log) ? raw.log : []).slice(-6).map((line) => ({
      text: String(line?.text ?? "").slice(0, 80),
      level: ["info", "good", "warn", "error"].includes(line?.level) ? line.level : "info",
    })),
  };
}

module.exports = {
  id: "zhajinhua",
  title: "局域网炸金花",
  capacity: CAPACITY,
  intents: INTENTS,
  minPlayers: MIN_PLAYERS,
  defaults: DEFAULTS,
  maxRounds: MAX_ROUNDS,
  roomName,
  create,
  seatJoined,
  seatLeft,
  seatOffline,
  seatRenamed,
  view,
  intent,
  advertise,
  sanitize,
  _logic: {
    SUIT_LABEL,
    RANK_LABEL,
    HAND_TYPES,
    TYPE_BY_RANK,
    makeDeck,
    shuffle,
    straightHigh,
    evaluate,
    compareValues,
    compareHands,
    buildPots,
    beginHand,
    callCost,
    seatedSeats,
    activeSeats,
    actingSeats,
    nextIn,
    view,
    advertise,
  },
};
