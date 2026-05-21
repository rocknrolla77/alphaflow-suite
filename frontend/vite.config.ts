import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
  resolve: {
    alias: {
      // Polyfill Node.js "events" for browser (ZeroDev SDK uses EventEmitter)
      events: "events",
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: false,
    minify: "esbuild",
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
          web3: ["viem"],
        },
      },
    },
  },
  define: {
    global: "globalThis",
  },
});
