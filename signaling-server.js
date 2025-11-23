// Streamchik signalling server (WebSocket for WebRTC)
// Can be started with: node signaling-server.js

const WebSocket = require('ws');

const DEFAULT_PORT = Number(process.env.PORT || process.env.SIGNALING_PORT || 8080);
const DEFAULT_ROOM = process.env.DEFAULT_ROOM || process.env.SIGNALING_ROOM || 'room-1';
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;

/** roomName -> Set<ws> */
const rooms = new Map();
let nextId = 1;

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function getRoom(roomName) {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, new Set());
  }
  return rooms.get(roomName);
}

function sendJson(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcast(roomName, obj, exceptWs = null) {
  const room = rooms.get(roomName);
  if (!room) return;
  const message = JSON.stringify(obj);
  for (const client of room) {
    if (client !== exceptWs && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function broadcastPeers(roomName) {
  const room = rooms.get(roomName);
  const ids = room ? Array.from(room).map(ws => ws.clientId) : [];
  const payload = { type: 'peers', room: roomName, count: ids.length, ids };
  broadcast(roomName, payload);
  log(`room=${roomName} peers:`, payload);
}

function joinRoom(ws, roomName = DEFAULT_ROOM) {
  const room = getRoom(roomName);
  room.add(ws);
  ws.roomName = roomName;
  ws.lastPong = Date.now();
  sendJson(ws, { type: 'welcome', room: roomName, id: ws.clientId });
  broadcastPeers(roomName);
}

function leaveRoom(ws) {
  const roomName = ws.roomName;
  if (!roomName || !rooms.has(roomName)) return;

  const room = rooms.get(roomName);
  room.delete(ws);
  if (room.size === 0) {
    rooms.delete(roomName);
  }
  broadcastPeers(roomName);
}

function handleMessage(ws, data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch (e) {
    log(`Bad JSON from ${ws.clientId}:`, data.toString());
    return;
  }

  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'pong':
      ws.lastPong = Date.now();
      break;

    case 'offer':
    case 'answer':
    case 'ice':
    case 'state': {
      const roomName = ws.roomName || DEFAULT_ROOM;
      const payload = { ...msg, from: ws.clientId, room: roomName };
      broadcast(roomName, payload, ws);
      break;
    }

    case 'join': {
      const targetRoom = typeof msg.room === 'string' && msg.room.trim()
        ? msg.room.trim()
        : DEFAULT_ROOM;
      if (ws.roomName !== targetRoom) {
        leaveRoom(ws);
        joinRoom(ws, targetRoom);
      }
      break;
    }

    default:
      log(`Unknown message type from ${ws.clientId}:`, msg);
  }
}

function startSignalingServer(options = {}) {
  const port = Number(options.port || DEFAULT_PORT);
  const host = options.host || '0.0.0.0';
  const wss = new WebSocket.Server({ host, port }, () => {
    log(`Signalling server started on ws://${host}:${port} defaultRoom=${DEFAULT_ROOM}`);
  });

  wss.on('connection', (ws, req) => {
    ws.clientId = `c${nextId++}`;
    ws.lastPong = Date.now();
    joinRoom(ws, DEFAULT_ROOM);
    log(`Client connected ${ws.clientId} from ${req.socket.remoteAddress}`);

    ws.on('message', (data) => handleMessage(ws, data));

    ws.on('close', () => {
      log(`Client disconnected ${ws.clientId}`);
      leaveRoom(ws);
    });

    ws.on('error', (err) => {
      log(`Error on ${ws.clientId}:`, err.message);
    });
  });

  setInterval(() => {
    for (const room of rooms.values()) {
      for (const ws of room) {
        if (ws.readyState !== WebSocket.OPEN) continue;

        if (Date.now() - ws.lastPong > HEARTBEAT_TIMEOUT_MS) {
          log(`Client ${ws.clientId} timed out, terminating`);
          ws.terminate();
          continue;
        }

        sendJson(ws, { type: 'ping', ts: Date.now() });
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  return wss;
}

if (require.main === module) {
  startSignalingServer();
}

module.exports = { startSignalingServer };
