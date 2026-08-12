// overlay-shell 笔记「纯网页」构建(与桌面 Tauri 构建分开, 不动 vite.config.ts)。
// 出静态到 dist-web/, 经 omnicompany dashboard(8210)在 /lofa/overlay/app/ 下服务。
// base "./" → 资源相对引用, 可挂任意子路径。
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "notes-entry-fetch-priority",
      transformIndexHtml: {
        order: "post",
        handler(html) {
          return html.replace(
            '<script type="module" crossorigin',
            '<script type="module" crossorigin fetchpriority="high"',
          );
        },
      },
    },
  ],
  base: "./",
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    target: "es2020",
    rollupOptions: {
      input: {
        page: "notes-web.html",
        "notes-embed": "src/notes-embed.ts",
      },
      preserveEntrySignatures: "strict",
      output: {
        entryFileNames: (chunk) => chunk.name === "notes-embed"
          ? "assets/notes-embed.js"
          : "assets/notes-web.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
