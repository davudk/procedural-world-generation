import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5174 },
  worker: { format: 'es' },
  build: { target: 'es2023', sourcemap: true },
});
