/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Exercise the real OAuth implementation in Node; only its Worker base
    // class is replaced by the local fixture in smokeClientRegistration tests.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
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
