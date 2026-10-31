import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

function copyWellKnown() {
  return {
    name: 'copy-well-known',
    closeBundle() {
      const src = path.resolve('public/.well-known');
      const dest = path.resolve('dist/.well-known');
      if (fs.existsSync(src)) {
        fs.cpSync(src, dest, { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), copyWellKnown()],
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
