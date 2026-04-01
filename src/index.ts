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

type MatchState = {
  matchId: string;
  players: MatchPlayer[];
  hands: Record<string, Card[]>;
  tableCards: TableCard[];
  currentTurn: string;
};

const TURN_ORDER = ["N", "E", "S", "W"] as const;

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
  const seats = ["N", "E", "S", "W"] as const;
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

    return seats
      .map((seat) => assigned.find((p) => p.seat === seat))
      .filter(Boolean) as MatchPlayer[];
  }

  const filled = [...humans];

  while (filled.length < 4) {
    filled.push(createBot(filled.length - humans.length + 1));
  }

  return filled.slice(0, 4).map((player, i) => ({
    ...player,
    seat: seats[i],
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

function createMatch(players: PlayerSocket[]) {
  const matchId = makeId("match");
  const humans = buildHumans(players);
  const allPlayers = assignSeats(humans);
  const hands = dealHands(allPlayers);

  const match: MatchState = {
    matchId,
    players: allPlayers,
    hands,
    tableCards: [],
    currentTurn: "N",
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
      },
    });

    send(player, {
      t: "HAND_DEALT",
      d: {
        matchId,
        seat: thisPlayer?.seat ?? "N",
        hand: hands[player.playerId ?? ""],
        currentTurn: match.currentTurn,
      },
    });
  });

  broadcastToMatch(match, {
    t: "TURN_UPDATE",
    d: {
      matchId,
      currentTurn: match.currentTurn,
    },
  });

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

        const hand = match.hands[player.playerId ?? ""] ?? [];
        const cardIndex = hand.findIndex((c) => cardsEqual(c, card));

        if (cardIndex == -1) {
          send(player, {
            t: "ERROR",
            d: { message: "Card not in hand" },
          });
          return;
        }

        const [playedCard] = hand.splice(cardIndex, 1);

        match.tableCards.push({
          seat,
          card: playedCard,
        });

        if (match.tableCards.length < 4) {
          match.currentTurn = nextSeat(seat);
        }

        broadcastToMatch(match, {
          t: "CARD_PLAYED",
          d: {
            matchId,
            seat,
            card: playedCard,
            remainingCount: hand.length,
            tableCards: match.tableCards,
            currentTurn: match.currentTurn,
          },
        });

        if (match.tableCards.length === 4) {
          const finishedTrick = [...match.tableCards];

          broadcastToMatch(match, {
            t: "TRICK_COMPLETE",
            d: {
              matchId,
              tableCards: finishedTrick,
            },
          });

          match.tableCards = [];
          match.currentTurn = "N";

          broadcastToMatch(match, {
            t: "TURN_UPDATE",
            d: {
              matchId,
              currentTurn: match.currentTurn,
            },
          });

          broadcastToMatch(match, {
            t: "TABLE_CLEAR",
            d: {
              matchId,
            },
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
