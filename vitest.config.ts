/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.spec.ts'],
    exclude: ['dist/**', 'node_modules/**', '**/.claude/**', '**/.codex/**'],
    env: {
      NODE_ENV: 'test',
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('test'),
  },
});
