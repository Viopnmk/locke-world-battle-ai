import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Plain client-side build: no server, no secrets, everything ships as static files
// so the same output works on Cloudflare Pages and GitHub Pages.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 2048,
    chunkSizeWarningLimit: 900,
  },
});
