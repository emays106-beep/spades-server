import http from "http";
import { WebSocketServer, WebSocket } from "ws";

type ClientMessage =
  | { t: "AUTH"; d?: { guestName?: string } }
  | { t: "QUEUE_JOIN"; d?: { mode?: string } }
  | { t: "QUEUE_LEAVE"; d?: Record<string, never> };

type PlayerSocket = WebSocket & {
  playerId?: string;
  guestName?: string;
  inQueue?: boolean;
  matchId?: string;
};

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

function send(ws: PlayerSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function removeFromQueue(ws: PlayerSocket) {
  const index = queue.indexOf(ws);
  if (index !== -1) {
    queue.splice(index, 1);
  }
  ws.inQueue = false;
}

function makeId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function tryMakeMatch() {
  while (queue.length >= 4) {
    const players = queue.splice(0, 4);
    const matchId = makeId("match");

    const seats = ["N", "E", "S", "W"];

    players.forEach((player, index) => {
      player.inQueue = false;
      player.matchId = matchId;

      send(player, {
        t: "MATCH_FOUND",
        d: {
          matchId,
          seat: seats[index],
          players: players.map((p, i) => ({
            seat: seats[i],
            name: p.guestName ?? `Player ${i + 1}`,
            playerId: p.playerId,
          })),
        },
      });
    });

    console.log(
      `Created ${matchId} with players: ${players
        .map((p) => p.guestName ?? p.playerId)
        .join(", ")}`,
    );
  }
}

wss.on("connection", (ws) => {
  const player = ws as PlayerSocket;

  player.playerId = makeId("player");
  player.guestName = "Player";
  player.inQueue = false;

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

      console.log("Received:", data);

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

        player.inQueue = true;
        queue.push(player);

        send(player, {
          t: "QUEUE_OK",
          d: {
            status: "joined",
            size: queue.length,
          },
        });

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
