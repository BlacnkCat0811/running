import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const lanDev = process.env.RAI_ALLOW_LAN_DEV === "1";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ["recharts"],
          react: ["react", "react-dom", "react-router-dom"],
          icons: ["@phosphor-icons/react"]
        }
      }
    }
  },
  server: {
    host: lanDev ? "0.0.0.0" : "127.0.0.1",
    port: 5173,
    strictPort: true,
    ...(lanDev ? { hmr: false as const } : {}),
    proxy: {
      "/v1": "http://127.0.0.1:8787"
    }
  }
});
