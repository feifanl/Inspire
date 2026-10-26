import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;

export default defineConfig({
  base: './',
  server: {
    ...(envPort ? { port: envPort, strictPort: true } : {}),
    // Dev only: the page isn't an extension there, so Google Calendar's iCal
    // feed (no CORS headers) is fetched through this proxy (modules/calendar/sync.ts).
    proxy: {
      '/gcal': {
        target: 'https://calendar.google.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gcal/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: {
      input: {
        newtab: resolve(__dirname, 'newtab.html'),
        background: resolve(__dirname, 'src/background.ts'),
      },
      output: {
        // The service worker must land at a fixed path the manifest references;
        // everything else keeps hashed asset names.
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
