import http from "http";
import { WebSocketServer } from "ws";

const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("Player connected");

  ws.on("message", (msg) => {
    console.log("Message:", msg.toString());
    ws.send(JSON.stringify({ t: "ECHO", d: msg.toString() }));
  });

  ws.on("close", () => {
    console.log("Player disconnected");
  });
});

const PORT = Number(process.env.PORT || 10000);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Spades server running on :${PORT}`);
});
