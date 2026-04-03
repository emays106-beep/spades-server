import http from "http";
import { WebSocketServer, WebSocket } from "ws";

type Suit = "S" | "H" | "D" | "C";
type Rank =
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "J"
  | "Q"
  | "K"
  | "A";

type Card = {
  suit: Suit;
  rank: Rank;
};

type ClientMessage =
  | { t: "AUTH"; d?: { guestName?: string } }
  | { t: "QUEUE_JOIN"; d?: { mode?: string; teamCode?: string } }
  | { t: "QUEUE_LEAVE"; d?: Record<string, never> }
  | { t: "BID_SUBMIT"; d?: { matchId?: string; seat?: string; bid?: number } }
  | { t: "PLAY_CARD"; d?: { matchId?: string; seat?: string; card?: Card } };

type PlayerSocket = WebSocket & {
  playerId?: string;
  guestName?: string;
  inQueue?: boolean;
  matchId?: string;
  queueTimer?: NodeJS.Timeout | null;
  teamCode?: string;
};

type MatchPlayer = {
  seat: string;
  name: string;
  playerId: string;
  isBot: boolean;
  teamCode?: string;
  ws?: PlayerSocket;
};

type TableCard = {
  seat: string;
  card: Card;
};

type TeamKey = "NS" | "EW";

type MatchState = {
  matchId: string;
  players: MatchPlayer[];
  hands: Record<string, Card[]>;
  tableCards: TableCard[];
  currentTurn: string;
  spadesBroken: boolean;
  teamTricks: Record<TeamKey, number>;
  bids: Record<string, number | null>;
  biddingComplete: boolean;
  botTurnTimer?: NodeJS.Timeout | null;
  botBidTimer?: NodeJS.Timeout | null;
  roundNumber: number;
  completedTricks: number;
  teamScores: Record<TeamKey, number>;
  teamBags: Record<TeamKey, number>;
  gameOver: boolean;
  winnerTeam: TeamKey | null;
};

const TURN_ORDER = ["N", "E", "S", "W"] as const;
const SEATS = ["N", "E", "S", "W"] as const;
const WIN_SCORE = 500;

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Spades server is running");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const wss = new WebSocketServer({
  server,
  path: "/ws",
});

const queue: PlayerSocket[] = [];
const clients = new Set<PlayerSocket>();
const matches = new Map<string, MatchState>();

function send(ws: PlayerSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastToMatch(match: MatchState, payload: unknown) {
  for (const player of match.players) {
    if (!player.isBot && player.ws) {
      send(player.ws, payload);
    }
  }
}

function makeId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function clearQueueTimer(player: PlayerSocket) {
  if (player.queueTimer) {
    clearTimeout(player.queueTimer);
    player.queueTimer = null;
  }
}

function clearBotTurnTimer(match: MatchState) {
  if (match.botTurnTimer) {
    clearTimeout(match.botTurnTimer);
    match.botTurnTimer = null;
  }
}

function clearBotBidTimer(match: MatchState) {
  if (match.botBidTimer) {
    clearTimeout(match.botBidTimer);
    match.botBidTimer = null;
  }
}

function removeFromQueue(ws: PlayerSocket) {
  const index = queue.indexOf(ws);
  if (index !== -1) {
    queue.splice(index, 1);
  }
  ws.inQueue = false;
  clearQueueTimer(ws);
}

function createBot(botNumber: number, teamCode = ""): MatchPlayer {
  return {
    seat: "",
    name: `Bot ${botNumber}`,
    playerId: makeId("bot"),
    isBot: true,
    teamCode,
  };
}

function createDeck(): Card[] {
  const suits: Suit[] = ["S", "H", "D", "C"];
  const ranks: Rank[] = [
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "J",
    "Q",
    "K",
    "A",
  ];

  const deck: Card[] = [];

  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ suit, rank });
    }
  }

  return deck;
}

function shuffle<T>(items: T[]): T[] {
  const arr = [...items];

  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr;
}

function dealHands(players: MatchPlayer[]) {
  const deck = shuffle(createDeck());
  const hands: Record<string, Card[]> = {};

  players.forEach((player) => {
    hands[player.playerId] = [];
  });

  for (let i = 0; i < 52; i += 1) {
    const player = players[i % 4];
    hands[player.playerId].push(deck[i]);
  }

  return hands;
}

function buildHumans(players: PlayerSocket[]): MatchPlayer[] {
  return players.map((player) => ({
    seat: "",
    name: player.guestName ?? "Player",
    playerId: player.playerId ?? makeId("player"),
    isBot: false,
    teamCode: player.teamCode ?? "",
    ws: player,
  }));
}

function findPairedHumans(humans: MatchPlayer[]) {
  const byCode = new Map<string, MatchPlayer[]>();

  for (const human of humans) {
    const code = (human.teamCode ?? "").trim();
    if (!code) continue;

    if (!byCode.has(code)) {
      byCode.set(code, []);
    }
    byCode.get(code)!.push(human);
  }

  for (const [, group] of byCode) {
    if (group.length >= 2) {
      return [group[0], group[1]];
    }
  }

  return null;
}

function assignSeats(humans: MatchPlayer[]) {
  const assigned: MatchPlayer[] = [];

  const paired = findPairedHumans(humans);

  if (paired) {
    const [p1, p2] = paired;
    assigned.push({ ...p1, seat: "N" });
    assigned.push({ ...p2, seat: "S" });

    const remainingHumans = humans.filter(
      (h) => h.playerId !== p1.playerId && h.playerId !== p2.playerId,
    );

    const eastWest: MatchPlayer[] = [];

    if (remainingHumans.length >= 2) {
      eastWest.push({ ...remainingHumans[0], seat: "E" });
      eastWest.push({ ...remainingHumans[1], seat: "W" });
    } else if (remainingHumans.length === 1) {
      eastWest.push({ ...remainingHumans[0], seat: "E" });
      eastWest.push({ ...createBot(1), seat: "W" });
    } else {
      eastWest.push({ ...createBot(1), seat: "E" });
      eastWest.push({ ...createBot(2), seat: "W" });
    }

    assigned.push(...eastWest);

    return SEATS.map((seat) => assigned.find((p) => p.seat === seat)!);
  }

  const filled = [...humans];

  while (filled.length < 4) {
    filled.push(createBot(filled.length - humans.length + 1));
  }

  return filled.slice(0, 4).map((player, i) => ({
    ...player,
    seat: SEATS[i],
  }));
}

function cardsEqual(a?: Card, b?: Card) {
  return !!a && !!b && a.suit === b.suit && a.rank === b.rank;
}

function nextSeat(seat: string) {
  const index = TURN_ORDER.indexOf(seat as (typeof TURN_ORDER)[number]);
  if (index === -1) return "N";
  return TURN_ORDER[(index + 1) % TURN_ORDER.length];
}

function seatToTeam(seat: string): TeamKey {
  return seat === "N" || seat === "S" ? "NS" : "EW";
}

function rankValue(rank: Rank) {
  const values: Record<Rank, number> = {
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 7,
    "8": 8,
    "9": 9,
    "10": 10,
    J: 11,
    Q: 12,
    K: 13,
    A: 14,
  };

  return values[rank];
}

function sortCardsLow(cards: Card[]) {
  return [...cards].sort((a, b) => {
    if (a.suit !== b.suit) {
      return a.suit.localeCompare(b.suit);
    }
    return rankValue(a.rank) - rankValue(b.rank);
  });
}

function determineTrickWinner(tableCards: TableCard[]) {
  if (tableCards.length !== 4) return null;

  const leadSuit = tableCards[0].card.suit;
  const spadesPlayed = tableCards.filter((entry) => entry.card.suit === "S");

  let contenders =
    spadesPlayed.length > 0
      ? spadesPlayed
      : tableCards.filter((entry) => entry.card.suit === leadSuit);

  contenders = contenders.sort(
    (a, b) => rankValue(b.card.rank) - rankValue(a.card.rank),
  );

  return contenders[0];
}

function hasSuit(cards: Card[], suit: Suit) {
  return cards.some((card) => card.suit === suit);
}

function onlySpadesLeft(cards: Card[]) {
  return cards.length > 0 && cards.every((card) => card.suit === "S");
}

function findPlayerBySeat(match: MatchState, seat: string) {
  return match.players.find((p) => p.seat === seat);
}

function chooseBotLeadCard(hand: Card[], spadesBroken: boolean) {
  const sorted = sortCardsLow(hand);
  const nonSpades = sorted.filter((card) => card.suit !== "S");
  const spades = sorted.filter((card) => card.suit === "S");

  if (!spadesBroken && nonSpades.length > 0) return nonSpades[0];
  if (nonSpades.length > 0) return nonSpades[0];
  return spades[0];
}

function chooseBotFollowCard(hand: Card[], leadSuit: Suit) {
  const sorted = sortCardsLow(hand);
  const sameSuit = sorted.filter((card) => card.suit === leadSuit);

  if (sameSuit.length > 0) return sameSuit[0];

  const nonSpades = sorted.filter((card) => card.suit !== "S");
  if (nonSpades.length > 0) return nonSpades[0];

  const spades = sorted.filter((card) => card.suit === "S");
  return spades[0];
}

function chooseBotCard(match: MatchState, hand: Card[]) {
  if (match.tableCards.length === 0) {
    return chooseBotLeadCard(hand, match.spadesBroken);
  }

  const leadSuit = match.tableCards[0].card.suit;
  return chooseBotFollowCard(hand, leadSuit);
}

function estimateBotBid(hand: Card[]) {
  let bid = 0;

  for (const card of hand) {
    if (card.suit === "S") {
      if (card.rank === "A" || card.rank === "K" || card.rank === "Q") bid += 1;
      else if (card.rank === "J" || card.rank === "10") bid += 0.5;
      else bid += 0.25;
    } else {
      if (card.rank === "A") bid += 1;
      else if (card.rank === "K") bid += 0.75;
      else if (card.rank === "Q") bid += 0.5;
    }
  }

  return Math.max(1, Math.min(13, Math.round(bid)));
}

function teamBidTotal(match: MatchState, team: TeamKey) {
  const seats = team === "NS" ? ["N", "S"] : ["E", "W"];
  return seats.reduce((sum, seat) => sum + (match.bids[seat] ?? 0), 0);
}

function scheduleBotBidIfNeeded(match: MatchState) {
  clearBotBidTimer(match);

  if (match.gameOver) return;

  const nextBot = SEATS.find((seat) => {
    const player = findPlayerBySeat(match, seat);
    return player?.isBot && match.bids[seat] === null;
  });

  if (!nextBot) {
    maybeCompleteBidding(match);
    return;
  }

  match.botBidTimer = setTimeout(() => {
    const player = findPlayerBySeat(match, nextBot);
    if (!player || !player.isBot || match.gameOver) return;

    const hand = match.hands[player.playerId] ?? [];
    const bid = estimateBotBid(hand);

    match.bids[nextBot] = bid;

    broadcastToMatch(match, {
      t: "BID_ACCEPTED",
      d: {
        matchId: match.matchId,
        seat: nextBot,
        bid,
        bids: match.bids,
      },
    });

    scheduleBotBidIfNeeded(match);
    maybeCompleteBidding(match);
  }, 700);
}

function scheduleBotTurnIfNeeded(match: MatchState) {
  clearBotTurnTimer(match);

  if (!match.biddingComplete || match.gameOver) return;

  const currentPlayer = findPlayerBySeat(match, match.currentTurn);
  if (!currentPlayer || !currentPlayer.isBot) return;

  match.botTurnTimer = setTimeout(() => {
    playBotTurn(match.matchId);
  }, 900);
}

function calculateRoundScore(
  teamBid: number,
  teamTricks: number,
  currentBags: number,
) {
  let scoreDelta = 0;
  let bags = currentBags;

  if (teamTricks >= teamBid) {
    const extra = teamTricks - teamBid;
    scoreDelta += teamBid * 10 + extra;
    bags += extra;

    if (bags >= 10) {
      scoreDelta -= 100;
      bags -= 10;
    }
  } else {
    scoreDelta -= teamBid * 10;
  }

  return {
    scoreDelta,
    bags,
  };
}

function checkGameOver(match: MatchState) {
  if (match.teamScores.NS >= WIN_SCORE || match.teamScores.EW >= WIN_SCORE) {
    match.gameOver = true;
    match.winnerTeam =
      match.teamScores.NS >= WIN_SCORE && match.teamScores.EW >= WIN_SCORE
        ? match.teamScores.NS >= match.teamScores.EW
          ? "NS"
          : "EW"
        : match.teamScores.NS >= WIN_SCORE
          ? "NS"
          : "EW";

    clearBotBidTimer(match);
    clearBotTurnTimer(match);

    broadcastToMatch(match, {
      t: "GAME_OVER",
      d: {
        matchId: match.matchId,
        winnerTeam: match.winnerTeam,
        totalScores: match.teamScores,
        bags: match.teamBags,
      },
    });

    return true;
  }

  return false;
}

function resetForNextRound(match: MatchState) {
  clearBotBidTimer(match);
  clearBotTurnTimer(match);

  if (match.gameOver) return;

  const newHands = dealHands(match.players);

  match.hands = newHands;
  match.tableCards = [];
  match.currentTurn = "N";
  match.spadesBroken = false;
  match.teamTricks = { NS: 0, EW: 0 };
  match.bids = { N: null, E: null, S: null, W: null };
  match.biddingComplete = false;
  match.roundNumber += 1;
  match.completedTricks = 0;

  for (const player of match.players) {
    if (!player.isBot && player.ws) {
      send(player.ws, {
        t: "NEW_ROUND",
        d: {
          matchId: match.matchId,
          roundNumber: match.roundNumber,
          currentTurn: match.currentTurn,
          spadesBroken: match.spadesBroken,
          teamScores: match.teamScores,
          teamBags: match.teamBags,
        },
      });

      send(player.ws, {
        t: "HAND_DEALT",
        d: {
          matchId: match.matchId,
          seat: player.seat,
          hand: newHands[player.playerId] ?? [],
          currentTurn: match.currentTurn,
          spadesBroken: match.spadesBroken,
        },
      });

      send(player.ws, {
        t: "BID_REQUEST",
        d: {
          matchId: match.matchId,
          seat: player.seat,
        },
      });
    }
  }

  broadcastToMatch(match, {
    t: "BID_STATUS",
    d: {
      matchId: match.matchId,
      bids: match.bids,
    },
  });

  scheduleBotBidIfNeeded(match);
}

function completeRound(match: MatchState) {
  const nsBid = teamBidTotal(match, "NS");
  const ewBid = teamBidTotal(match, "EW");

  const nsResult = calculateRoundScore(nsBid, match.teamTricks.NS, match.teamBags.NS);
  const ewResult = calculateRoundScore(ewBid, match.teamTricks.EW, match.teamBags.EW);

  match.teamScores.NS += nsResult.scoreDelta;
  match.teamScores.EW += ewResult.scoreDelta;

  match.teamBags.NS = nsResult.bags;
  match.teamBags.EW = ewResult.bags;

  broadcastToMatch(match, {
    t: "ROUND_COMPLETE",
    d: {
      matchId: match.matchId,
      roundNumber: match.roundNumber,
      bids: match.bids,
      tricks: match.teamTricks,
      roundScores: {
        NS: nsResult.scoreDelta,
        EW: ewResult.scoreDelta,
      },
      totalScores: match.teamScores,
      bags: match.teamBags,
    },
  });

  if (checkGameOver(match)) {
    return;
  }

  setTimeout(() => {
    resetForNextRound(match);
  }, 2200);
}

function finishTrickIfReady(match: MatchState) {
  if (match.tableCards.length !== 4) return;

  const finishedTrick = [...match.tableCards];
  const winner = determineTrickWinner(finishedTrick);

  if (!winner) return;

  const winnerTeam = seatToTeam(winner.seat);
  match.teamTricks[winnerTeam] += 1;
  match.currentTurn = winner.seat;
  match.completedTricks += 1;

  broadcastToMatch(match, {
    t: "TRICK_COMPLETE",
    d: {
      matchId: match.matchId,
      winnerSeat: winner.seat,
      winnerCard: winner.card,
      tableCards: finishedTrick,
      teamTricks: match.teamTricks,
      spadesBroken: match.spadesBroken,
    },
  });

  match.tableCards = [];

  broadcastToMatch(match, {
    t: "TURN_UPDATE",
    d: {
      matchId: match.matchId,
      currentTurn: match.currentTurn,
      spadesBroken: match.spadesBroken,
    },
  });

  broadcastToMatch(match, {
    t: "TABLE_CLEAR",
    d: {
      matchId: match.matchId,
    },
  });

  if (match.completedTricks >= 13) {
    completeRound(match);
    return;
  }

  scheduleBotTurnIfNeeded(match);
}

function playValidatedCard(
  match: MatchState,
  playerId: string,
  seat: string,
  card: Card,
) {
  if (!match.biddingComplete) {
    return { ok: false, error: "Bidding is not complete" as const };
  }

  if (match.gameOver) {
    return { ok: false, error: "Game is over" as const };
  }

  const hand = match.hands[playerId] ?? [];
  const cardIndex = hand.findIndex((c) => cardsEqual(c, card));

  if (cardIndex === -1) {
    return { ok: false, error: "Card not in hand" as const };
  }

  if (match.tableCards.length > 0) {
    const leadSuit = match.tableCards[0].card.suit;
    const playerHasLeadSuit = hasSuit(hand, leadSuit);

    if (playerHasLeadSuit && card.suit !== leadSuit) {
      return { ok: false, error: `You must follow suit: ${leadSuit}` as const };
    }

    if (card.suit === "S" && leadSuit !== "S") {
      match.spadesBroken = true;
    }
  } else {
    const leadingWithSpade = card.suit === "S";
    const canLeadSpade = match.spadesBroken || onlySpadesLeft(hand);

    if (leadingWithSpade && !canLeadSpade) {
      return { ok: false, error: "Spades have not been broken yet" as const };
    }
  }

  const [playedCard] = hand.splice(cardIndex, 1);

  match.tableCards.push({
    seat,
    card: playedCard,
  });

  if (playedCard.suit === "S" && match.tableCards.length > 1) {
    match.spadesBroken = true;
  }

  if (match.tableCards.length < 4) {
    match.currentTurn = nextSeat(seat);
  }

  broadcastToMatch(match, {
    t: "CARD_PLAYED",
    d: {
      matchId: match.matchId,
      seat,
      card: playedCard,
      remainingCount: hand.length,
      tableCards: match.tableCards,
      currentTurn: match.currentTurn,
      spadesBroken: match.spadesBroken,
    },
  });

  finishTrickIfReady(match);

  if (match.tableCards.length > 0) {
    scheduleBotTurnIfNeeded(match);
  }

  return { ok: true, card: playedCard } as const;
}

function playBotTurn(matchId: string) {
  const match = matches.get(matchId);
  if (!match || match.gameOver) return;

  clearBotTurnTimer(match);

  if (!match.biddingComplete) return;

  const bot = findPlayerBySeat(match, match.currentTurn);
  if (!bot || !bot.isBot) return;

  const hand = match.hands[bot.playerId] ?? [];
  if (hand.length === 0) return;

  const chosen = chooseBotCard(match, hand);
  if (!chosen) return;

  playValidatedCard(match, bot.playerId, bot.seat, chosen);
}

function maybeCompleteBidding(match: MatchState) {
  const allBid = SEATS.every((seat) => match.bids[seat] !== null);
  if (!allBid || match.biddingComplete) return;

  match.biddingComplete = true;
  match.currentTurn = "N";

  broadcastToMatch(match, {
    t: "BIDDING_COMPLETE",
    d: {
      matchId: match.matchId,
      bids: match.bids,
      teamBids: {
        NS: teamBidTotal(match, "NS"),
        EW: teamBidTotal(match, "EW"),
      },
    },
  });

  broadcastToMatch(match, {
    t: "TURN_UPDATE",
    d: {
      matchId: match.matchId,
      currentTurn: match.currentTurn,
      spadesBroken: match.spadesBroken,
    },
  });

  scheduleBotTurnIfNeeded(match);
}

function createMatch(players: PlayerSocket[]) {
  const matchId = makeId("match");
  const humans = buildHumans(players);
  const allPlayers = assignSeats(humans);
  const hands = dealHands(allPlayers);

  const bids: Record<string, number | null> = {
    N: null,
    E: null,
    S: null,
    W: null,
  };

  const match: MatchState = {
    matchId,
    players: allPlayers,
    hands,
    tableCards: [],
    currentTurn: "N",
    spadesBroken: false,
    teamTricks: {
      NS: 0,
      EW: 0,
    },
    bids,
    biddingComplete: false,
    botTurnTimer: null,
    botBidTimer: null,
    roundNumber: 1,
    completedTricks: 0,
    teamScores: {
      NS: 0,
      EW: 0,
    },
    teamBags: {
      NS: 0,
      EW: 0,
    },
    gameOver: false,
    winnerTeam: null,
  };

  matches.set(matchId, match);

  players.forEach((player) => {
    player.inQueue = false;
    player.matchId = matchId;
    clearQueueTimer(player);

    const thisPlayer = allPlayers.find((p) => p.playerId === player.playerId);

    send(player, {
      t: "MATCH_FOUND",
      d: {
        matchId,
        seat: thisPlayer?.seat ?? "N",
        players: allPlayers.map((p) => ({
          seat: p.seat,
          name: p.name,
          playerId: p.playerId,
          isBot: p.isBot,
          teamCode: p.teamCode ?? "",
        })),
        hasBots: allPlayers.some((p) => p.isBot),
        currentTurn: match.currentTurn,
        spadesBroken: match.spadesBroken,
      },
    });

    send(player, {
      t: "HAND_DEALT",
      d: {
        matchId,
        seat: thisPlayer?.seat ?? "N",
        hand: hands[player.playerId ?? ""],
        currentTurn: match.currentTurn,
        spadesBroken: match.spadesBroken,
      },
    });

    send(player, {
      t: "BID_REQUEST",
      d: {
        matchId,
        seat: thisPlayer?.seat ?? "N",
      },
    });
  });

  broadcastToMatch(match, {
    t: "BID_STATUS",
    d: {
      matchId,
      bids: match.bids,
    },
  });

  scheduleBotBidIfNeeded(match);

  console.log(
    `Created ${matchId} with players: ${allPlayers
      .map((p) => `${p.seat}:${p.name}${p.teamCode ? `[${p.teamCode}]` : ""}`)
      .join(", ")}`,
  );
}

function tryMakeMatch() {
  while (queue.length >= 4) {
    const players = queue.splice(0, 4);

    players.forEach((p) => {
      p.inQueue = false;
      clearQueueTimer(p);
    });

    createMatch(players);
  }
}

function startQueueTimeout(player: PlayerSocket) {
  clearQueueTimer(player);

  player.queueTimer = setTimeout(() => {
    if (!player.inQueue) return;

    const availableHumans = queue.splice(0, Math.min(queue.length, 4));

    availableHumans.forEach((p) => {
      p.inQueue = false;
      clearQueueTimer(p);
    });

    if (availableHumans.length > 0) {
      createMatch(availableHumans);
    }
  }, 10000);
}

wss.on("connection", (ws) => {
  const player = ws as PlayerSocket;

  player.playerId = makeId("player");
  player.guestName = "Player";
  player.inQueue = false;
  player.queueTimer = null;
  player.teamCode = "";

  clients.add(player);

  console.log("Player connected:", player.playerId);

  send(player, {
    t: "CONNECTED",
    d: {
      playerId: player.playerId,
    },
  });

  player.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString()) as ClientMessage;

      if (data.t === "AUTH") {
        player.guestName = data.d?.guestName?.trim() || "Player";

        send(player, {
          t: "AUTH_OK",
          d: {
            playerId: player.playerId,
            guestName: player.guestName,
          },
        });
        return;
      }

      if (data.t === "QUEUE_JOIN") {
        if (player.inQueue) {
          send(player, {
            t: "QUEUE_OK",
            d: {
              status: "already_in_queue",
            },
          });
          return;
        }

        player.teamCode = data.d?.teamCode?.trim() || "";
        player.inQueue = true;
        queue.push(player);

        send(player, {
          t: "QUEUE_OK",
          d: {
            status: "joined",
            size: queue.length,
            teamCode: player.teamCode,
            aiFallbackSeconds: 10,
          },
        });

        startQueueTimeout(player);
        tryMakeMatch();
        return;
      }

      if (data.t === "QUEUE_LEAVE") {
        removeFromQueue(player);

        send(player, {
          t: "QUEUE_LEFT",
          d: {},
        });
        return;
      }

      if (data.t === "BID_SUBMIT") {
        const matchId = data.d?.matchId;
        const seat = data.d?.seat;
        const bid = data.d?.bid;

        if (!matchId || !seat || typeof bid !== "number") {
          send(player, {
            t: "ERROR",
            d: { message: "Missing bid data" },
          });
          return;
        }

        const match = matches.get(matchId);
        if (!match) {
          send(player, {
            t: "ERROR",
            d: { message: "Match not found" },
          });
          return;
        }

        if (match.gameOver) {
          send(player, {
            t: "ERROR",
            d: { message: "Game is already over" },
          });
          return;
        }

        if (match.biddingComplete) {
          send(player, {
            t: "ERROR",
            d: { message: "Bidding already complete" },
          });
          return;
        }

        if (bid < 1 || bid > 13) {
          send(player, {
            t: "ERROR",
            d: { message: "Bid must be between 1 and 13" },
          });
          return;
        }

        const matchPlayer = match.players.find(
          (p) => p.playerId === player.playerId && p.seat === seat,
        );

        if (!matchPlayer) {
          send(player, {
            t: "ERROR",
            d: { message: "Player not in match seat" },
          });
          return;
        }

        match.bids[seat] = bid;

        broadcastToMatch(match, {
          t: "BID_ACCEPTED",
          d: {
            matchId,
            seat,
            bid,
            bids: match.bids,
          },
        });

        scheduleBotBidIfNeeded(match);
        maybeCompleteBidding(match);
        return;
      }

      if (data.t === "PLAY_CARD") {
        const matchId = data.d?.matchId;
        const seat = data.d?.seat;
        const card = data.d?.card;

        if (!matchId || !seat || !card) {
          send(player, {
            t: "ERROR",
            d: { message: "Missing PLAY_CARD data" },
          });
          return;
        }

        const match = matches.get(matchId);

        if (!match) {
          send(player, {
            t: "ERROR",
            d: { message: "Match not found" },
          });
          return;
        }

        if (seat !== match.currentTurn) {
          send(player, {
            t: "ERROR",
            d: { message: "Not your turn" },
          });
          return;
        }

        const matchPlayer = match.players.find(
          (p) => p.playerId === player.playerId && p.seat === seat,
        );

        if (!matchPlayer) {
          send(player, {
            t: "ERROR",
            d: { message: "Player not in match seat" },
          });
          return;
        }

        const result = playValidatedCard(match, player.playerId ?? "", seat, card);

        if (!result.ok) {
          send(player, {
            t: "ERROR",
            d: { message: result.error },
          });
        }

        return;
      }

      send(player, {
        t: "ERROR",
        d: {
          message: "Unknown message type",
        },
      });
    } catch (err) {
      console.error("Invalid message:", err);

      send(player, {
        t: "ERROR",
        d: {
          message: "Invalid JSON",
        },
      });
    }
  });

  player.on("close", () => {
    console.log("Player disconnected:", player.playerId);
    removeFromQueue(player);
    clients.delete(player);
  });

  player.on("error", (err) => {
    console.error("WebSocket error:", err);
    removeFromQueue(player);
    clients.delete(player);
  });
});

const PORT = Number(process.env.PORT || 10000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Spades server running on :${PORT}`);
});
