import http from "http";
import { WebSocketServer } from "ws";

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

wss.on("connection", (ws) => {
  console.log("Player connected");

ws.on("message", (msg) => {
  try {
    const data = JSON.parse(msg.toString());

    console.log("Received:", data);

    if (data.t === "AUTH") {
      ws.send(JSON.stringify({
        t: "AUTH_OK",
        d: { message: "Welcome!" }
      }));
    }

    if (data.t === "QUEUE_JOIN") {
      ws.send(JSON.stringify({
        t: "QUEUE_OK",
        d: { message: "Joined queue" }
      }));
    }

  } catch (err) {
    console.error("Invalid message:", err);
  }
});

  ws.on("close", () => {
    console.log("Player disconnected");
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });
});

const PORT = Number(process.env.PORT || 10000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Spades server running on :${PORT}`);
});
