/**
 * server.js — WebRTC Signaling Server
 *
 * Responsibilities:
 *  1. Serve static files from the /public directory.
 *  2. Act as a WebSocket signaling server so two browser peers
 *     can exchange SDP offers/answers and ICE candidates before
 *     establishing a direct peer-to-peer WebRTC connection.
 *
 * Flow:
 *  - A peer sends { type: 'join', roomId } to enter a room.
 *  - Once two peers are in the same room, the caller sends
 *    { type: 'signal', data: { description } } with an SDP offer.
 *  - The server forwards signal messages to all OTHER peers in the room.
 *  - After signaling completes, media flows directly between browsers
 *    (this server is no longer in the media path).
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

// Port and host can be overridden via environment variables (e.g., on Render)
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Map file extensions to their correct Content-Type headers
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Serves static files from the /public directory.
 * Also exposes a /health endpoint for uptime monitoring (e.g., Render).
 * Includes path traversal protection to prevent directory escape attacks.
 */
function serveStatic(req, res) {
  const requestPath = new URL(req.url, 'http://localhost').pathname;

  // Health check endpoint — returns { ok: true }
  if (requestPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const resolvedPath = requestPath === '/' ? '/index.html' : requestPath;
  // Strip any leading '../' sequences to prevent path traversal
  const safePath = path.normalize(resolvedPath).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  // Double-check the resolved path is still inside PUBLIC_DIR
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

// Attach the WebSocket server to the same HTTP server so both
// static files and WebSocket connections share one port.
const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server });

// rooms: Map<roomId, Set<WebSocket>>
// Tracks which WebSocket clients are in which room (max 2 per room).
const rooms = new Map();

/** Safely send a JSON-serialised payload to a WebSocket client. */
function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/** Returns the Set of peers for a room, creating it if it doesn't exist. */
function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  return rooms.get(roomId);
}

/**
 * Removes a WebSocket client from its current room and notifies
 * remaining peers. Cleans up the room entry if it becomes empty.
 */
function leaveRoom(ws) {
  if (!ws.roomId) return;

  const room = rooms.get(ws.roomId);
  if (!room) return;

  room.delete(ws);
  for (const peer of room) {
    send(peer, { type: 'peer-left' });
  }

  if (room.size === 0) {
    rooms.delete(ws.roomId);
  }

  ws.roomId = null;
}

// Handle each new WebSocket connection (one per browser tab)
wss.on('connection', (ws) => {
  ws.roomId = null; // Track which room this client has joined

  ws.on('message', (buffer) => {
    let message;
    try {
      message = JSON.parse(buffer.toString());
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    // --- join: add this client to a named room ---
    if (message.type === 'join') {
      const roomId = String(message.roomId || '').trim();
      if (!roomId) {
        send(ws, { type: 'error', message: 'roomId is required' });
        return;
      }

      // Leave any existing room before joining a new one
      leaveRoom(ws);
      const room = getRoom(roomId);

      // Limit each room to 2 peers for a simple 1-to-1 call
      if (room.size >= 2) {
        send(ws, { type: 'error', message: 'Room is full (max 2 peers)' });
        return;
      }

      room.add(ws);
      ws.roomId = roomId;

      // Confirm to the joining peer
      send(ws, { type: 'joined', roomId, peerCount: room.size });

      // Notify the other peer (if already present) and also tell the
      // new arrival that a peer is already in the room.
      for (const peer of room) {
        if (peer !== ws) {
          send(peer, { type: 'peer-joined' });
          send(ws, { type: 'peer-joined' });
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

    // --- signal: forward SDP offer/answer or ICE candidate to the other peer ---
    // The server does NOT inspect the signal payload — it just relays it.
    if (message.type === 'signal') {
      for (const peer of room) {
        if (peer !== ws) {
          send(peer, { type: 'signal', data: message.data });
        }
      }
      return;
    }

    send(ws, { type: 'error', message: 'Unknown message type' });
  });

  // Clean up room membership when the browser tab closes or disconnects
  ws.on('close', () => {
    leaveRoom(ws);
  });
});

/** Returns all non-internal IPv4 addresses for convenience logging. */
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
  console.log(`WebRTC signaling server running on ${HOST}:${PORT}`);

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
