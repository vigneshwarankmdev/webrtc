const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// Free default STUN only; DataChannel may still fail behind strict NAT.
// In that case the client will automatically use WebSocket relay for text.
const ICE_CONFIG = {
  iceTransportPolicy: 'all',
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

function serveStatic(req, res) {
  const requestPath = new URL(req.url, 'http://localhost').pathname;

  if (requestPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (requestPath === '/ice-config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(ICE_CONFIG));
    return;
  }

  const resolvedPath = requestPath === '/' ? '/index.html' : requestPath;
  const safePath = path.normalize(resolvedPath).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(500);
      res.end('Server error');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server });
const rooms = new Map();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  return rooms.get(roomId);
}

function broadcastToRoom(room, sender, payload) {
  for (const peer of room) {
    if (peer !== sender) {
      send(peer, payload);
    }
  }
}

function leaveRoom(ws) {
  if (!ws.roomId) return;

  const room = rooms.get(ws.roomId);
  if (!room) return;

  room.delete(ws);
  broadcastToRoom(room, ws, { type: 'peer-left' });

  if (room.size === 0) {
    rooms.delete(ws.roomId);
  }

  ws.roomId = null;
}

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.clientId = Math.random().toString(36).slice(2, 10);

  ws.on('message', (buffer) => {
    let message;
    try {
      message = JSON.parse(buffer.toString());
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (message.type === 'join') {
      const roomId = String(message.roomId || '').trim();
      if (!roomId) {
        send(ws, { type: 'error', message: 'roomId is required' });
        return;
      }

      leaveRoom(ws);
      const room = getRoom(roomId);

      if (room.size >= 2) {
        send(ws, { type: 'error', message: 'Room is full (max 2 peers)' });
        return;
      }

      room.add(ws);
      ws.roomId = roomId;

      send(ws, { type: 'joined', roomId, peerCount: room.size, clientId: ws.clientId });

      for (const peer of room) {
        if (peer !== ws) {
          send(peer, { type: 'peer-joined', clientId: ws.clientId });
          send(ws, { type: 'peer-joined', clientId: peer.clientId });
        }
      }
      return;
    }

    if (!ws.roomId) {
      send(ws, { type: 'error', message: 'Join a room first' });
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room) return;

    if (message.type === 'signal') {
      broadcastToRoom(room, ws, { type: 'signal', data: message.data });
      return;
    }

    send(ws, { type: 'error', message: 'Unknown message type' });
  });

  ws.on('close', () => {
    leaveRoom(ws);
  });
});

function getLanIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];

  for (const list of Object.values(interfaces)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }

  return ips;
}

server.listen(PORT, HOST, () => {
  console.log(`Realtime text server running on ${HOST}:${PORT}`);

  if (process.env.RENDER) {
    const externalUrl = process.env.RENDER_EXTERNAL_URL || 'https://<your-service>.onrender.com';
    console.log(`Render URL: ${externalUrl}`);
    console.log(`Health: ${externalUrl}/health`);
    return;
  }

  console.log(`Local:   http://localhost:${PORT}`);

  const lanIps = getLanIps();
  if (lanIps.length === 0) {
    console.log('LAN IPs: none detected');
    return;
  }

  for (const ip of lanIps) {
    console.log(`LAN:     http://${ip}:${PORT}`);
  }
});
