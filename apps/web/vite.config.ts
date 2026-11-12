/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on all interfaces so a phone on the same Wi-Fi can open the dev server.
    host: true,
    port: 5173,
  },
  preview: { host: true, port: 4173 },
  css: {
    // camelCase class names so `styles.cardBody` works for `.card-body`.
    modules: { localsConvention: 'camelCaseOnly' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
});
