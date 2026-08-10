# Simple WebRTC Server

This project provides a minimal WebRTC signaling server and a demo page.

## What it does

- Serves the demo page and WebSocket signaling from the same host
- Uses signaling for room join, SDP offer/answer exchange, and ICE candidate relay
- Supports up to 2 peers per room
- Exposes a health endpoint at /health (used by Render)

## Run locally

1. Install dependencies:
   npm install
2. Start the server:
   npm start
3. Open http://localhost:3000 in two browser tabs.
4. In both tabs, join the same room.
5. Click Start Call in one tab.

## Deploy on Render

Option A (recommended): Blueprint deploy

1. Push this project to GitHub.
2. In Render, choose New + and select Blueprint.
3. Pick your repository.
4. Render will use render.yaml automatically.

Option B: Manual Web Service

1. New + -> Web Service
2. Build Command: npm install
3. Start Command: npm start
4. Environment variables:
   - HOST=0.0.0.0

After deploy, open your Render URL (example: https://your-service.onrender.com) in two tabs and test with the same room ID.

## Notes

- The browser client automatically uses wss on https pages, so it works on Render.
- This is a signaling server only. Media still flows peer-to-peer between clients.
- Free tier instances can sleep when idle and may take a few seconds to wake.
