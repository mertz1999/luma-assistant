import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const apiPort = Number(process.env.API_PORT || 9001);
const webPort = Number(process.env.WEB_PORT || 5175);
const tunnelMode = process.env.VITE_TUNNEL_MODE === "1";
const explicitHmrHost = process.env.VITE_HMR_HOST;
const hmrUseWss = process.env.VITE_HMR_PROTOCOL === "wss" || tunnelMode;
const hmrClientPort = Number(process.env.VITE_HMR_CLIENT_PORT || (hmrUseWss ? 443 : webPort));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: webPort,
    host: true,
    allowedHosts: true,
    hmr: {
      protocol: hmrUseWss ? "wss" : "ws",
      host: explicitHmrHost || undefined,
      clientPort: hmrClientPort,
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
