import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'LLMWidget',
      fileName: 'llm-widget',
      formats: ['iife', 'es'],
    },
    rollupOptions: {
      // Bundle everything — no external deps, single file drop-in
      external: [],
    },
    target: 'es2020',
    minify: true,
  },
  optimizeDeps: {
    exclude: ['@mlc-ai/web-llm'],
  },
});
