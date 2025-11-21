const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 8080 });
let client = null;

wss.on("connection", ws => {
    client = ws;
    broadcast({ type: "friend-online" });

    ws.on("close", () => {
        broadcast({ type: "friend-offline" });
        client = null;
    });
});

function broadcast(obj) {
    if (!client) return;
    client.send(JSON.stringify(obj));
}


