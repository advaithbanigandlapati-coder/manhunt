// Builds the self-contained demo (real app + in-page game server + bots) into dist-demo/.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./src/demo/cf-shim.ts', import.meta.url)) } },
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./demo.html', import.meta.url)) },
  },
});
