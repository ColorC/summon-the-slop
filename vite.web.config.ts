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
        // 主入口带哈希(2026-08-16): 固定文件名 + 浏览器 304 缓存会在部署交界处造成
        // "新 html 配旧 js" 的版本错配 → 启动崩死在加载门且无可见报错(远端卡死根因嫌疑)。
        entryFileNames: (chunk) => chunk.name === "notes-embed"
          ? "assets/notes-embed.js"
          : "assets/notes-web-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
