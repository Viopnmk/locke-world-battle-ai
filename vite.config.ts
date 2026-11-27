import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 去掉 index.html 里 assets 的 crossorigin 属性。
 *
 * 站点是同源静态资源，本来不需要 CORS；带着 crossorigin 时浏览器会按 CORS 模式请求
 * 样式表，某些网络环境（代理/中间层不带回 Access-Control-Allow-Origin）会让整份 CSS
 * 被静默丢弃，页面变成无样式。去掉后同源直连，行为与普通 <link> 一致。
 */
function stripCrossorigin() {
  return {
    name: 'strip-crossorigin',
    enforce: 'post' as const,
    transformIndexHtml(html: string) {
      return html.replace(/\s+crossorigin(=["'][^"']*["'])?/g, '');
    },
  };
}

// Plain client-side build: no server, no secrets, everything ships as static files
// so the same output works on Cloudflare Pages and GitHub Pages.
export default defineConfig({
  plugins: [react(), stripCrossorigin()],
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 2048,
    chunkSizeWarningLimit: 900,
  },
});
