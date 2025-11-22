// streamchik 1.0.1 — signalling server
// Авто-комната room-1, пинг-понг, логирование подключений

const WebSocket = require('ws');

const PORT = 8080;
const ROOM_NAME = 'room-1';
const HEARTBEAT_INTERVAL_MS = 30000; // как часто слать ping
const HEARTBEAT_TIMEOUT_MS = 90000;  // через сколько без pong считаем клиента умершим

/** roomName -> Set<ws> */
const rooms = new Map();
rooms.set(ROOM_NAME, new Set());

let nextId = 1;

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

/**
 * Отправка json
 */
function sendJson(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

/**
 * Разослать всем в комнате
 */
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

/**
 * Обновить количество клиентов в комнате и сообщить всем.
 */
function broadcastPeers(roomName) {
  const room = rooms.get(roomName);
  const count = room ? room.size : 0;
  const ids = room ? Array.from(room).map(ws => ws.clientId) : [];
  const payload = { type: 'peers', room: roomName, count, ids };
  broadcast(roomName, payload);
  log(`room=${roomName} peers:`, payload);
}

/**
 * Клиент вошёл в комнату (всегда одна авто-комната)
 */
function joinRoom(ws) {
  const room = rooms.get(ROOM_NAME) || new Set();
  room.add(ws);
  rooms.set(ROOM_NAME, room);
  ws.roomName = ROOM_NAME;
  ws.lastPong = Date.now();
  sendJson(ws, {
    type: 'welcome',
    room: ROOM_NAME,
    id: ws.clientId,
  });
  broadcastPeers(ROOM_NAME);
}

/**
 * Клиент вышел
 */
function leaveRoom(ws) {
  const roomName = ws.roomName || ROOM_NAME;
  const room = rooms.get(roomName);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) {
    rooms.delete(roomName);
    // держим auto-room, чтобы не думать
    rooms.set(ROOM_NAME, new Set());
  } else {
    rooms.set(roomName, room);
  }
  broadcastPeers(roomName);
}

const wss = new WebSocket.Server({ port: PORT }, () => {
  log(`Signalling server started on ws://0.0.0.0:${PORT} room=${ROOM_NAME}`);
});

wss.on('connection', (ws, req) => {
  ws.clientId = `c${nextId++}`;
  ws.lastPong = Date.now();
  log(`Client connected ${ws.clientId} from ${req.socket.remoteAddress}`);

  // Автоматически закидываем всех в единственную комнату
  joinRoom(ws);

  ws.on('message', (data) => {
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
        // пересылаем всем, кроме отправителя, внутри его комнаты
        const payload = {
          ...msg,
          from: ws.clientId,
          room: ws.roomName || ROOM_NAME,
        };
        broadcast(ws.roomName || ROOM_NAME, payload, ws);
        break;
      }

      case 'join':
        // Все клиенты работают только в ROOM_NAME, игнорируем кастомные комнаты
        if (ws.roomName !== ROOM_NAME) {
          joinRoom(ws);
        }
        break;

      default:
        log(`Unknown message type from ${ws.clientId}:`, msg);
    }
  });

  ws.on('close', () => {
    log(`Client disconnected ${ws.clientId}`);
    leaveRoom(ws);
  });

  ws.on('error', (err) => {
    log(`Error on ${ws.clientId}:`, err.message);
  });
});

// Пинг-понг для зачистки умерших соединений
setInterval(() => {
  for (const room of rooms.values()) {
    for (const ws of room) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      // если слишком давно не было pong – рвём коннект
      if (Date.now() - ws.lastPong > HEARTBEAT_TIMEOUT_MS) {
        log(`Client ${ws.clientId} timed out, terminating`);
        ws.terminate();
        continue;
      }

      // отправляем ping
      sendJson(ws, { type: 'ping', ts: Date.now() });
    }
  }
}, HEARTBEAT_INTERVAL_MS);
