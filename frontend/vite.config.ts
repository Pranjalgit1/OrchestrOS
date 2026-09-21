import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? "http://localhost:4000";
const host = process.env.VITE_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
const proxy = {
  "/api": {
    target: apiTarget,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host,
    port: 5173,
    proxy,
  },
  preview: {
    host,
    port: 5173,
    proxy,
  },
});
