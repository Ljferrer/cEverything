import { defineConfig } from 'vite';

// One origin for the page and the relay: the headset opens the tunnel URL and
// its WebSocket to /relay rides Vite's proxy to the Node relay on 8787 (PIN-9, PIN-14).
// allowedHosts: true lets a cloudflared or ngrok hostname through Vite's host check.
export default defineConfig({
  server: {
    host: true,
    allowedHosts: true,
    proxy: {
      '/relay': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
