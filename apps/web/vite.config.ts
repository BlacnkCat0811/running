import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
    port: 5173,
    strictPort: true,
    proxy: {
      "/v1": "http://127.0.0.1:8787"
    }
  }
});
