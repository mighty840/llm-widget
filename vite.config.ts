import { defineConfig } from 'vite';
import { resolve } from 'path';
import { execSync } from 'child_process';
import pkg from './package.json';

let gitHash = 'dev';
try { gitHash = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* no git */ }

export default defineConfig({
  define: {
    __IDJET_VERSION__: JSON.stringify(pkg.version),
    __IDJET_HASH__:    JSON.stringify(gitHash),
  },
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
