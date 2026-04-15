/**
 * Regenerate test HTML pages from TypeScript widget builders.
 * Uses tsx/esbuild-register to run TS directly.
 *
 * Usage: node gen.mjs  (or: npx tsx gen.mjs)
 */

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { register } from 'node:module';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dir, '../../src');

// We need to import TS files — use tsx's register hook
// Run via: node --import tsx/esm gen.mjs
// OR simply use tsx directly: npx tsx gen.mjs

// Dynamic import (tsx must already be registered as loader)
const { buildScaffoldWidget } = await import(path.join(srcDir, 'scaffoldWidget.ts'));
const { buildLiveFeedWidget }  = await import(path.join(srcDir, 'liveFeedWidget.ts'));

const BASE = 'http://localhost:9099';
const INITIATIVE_ID = '07f49477';
const FAKE_TOKEN = 'demo-token-for-local-testing';

// ── scaffold.html: connects to live test SSE stream ──────────────────────────
writeFileSync(
  path.join(__dir, 'scaffold.html'),
  buildScaffoldWidget({
    sessionId: 'test-session',
    streamBaseUrl: BASE,
    initiativeTitle: 'Operation Prism: Real-Time Streaming MCP Widgets',
    liveUrl: `https://useorgx.com/live/${INITIATIVE_ID}-6807-449c-b46c-5bc71a1219da`,
  })
);

// ── scaffold-streaming.html: slow SSE — stays in streaming state longer ───────
writeFileSync(
  path.join(__dir, 'scaffold-streaming.html'),
  buildScaffoldWidget({
    sessionId: 'slow-session',
    streamBaseUrl: BASE,
    initiativeTitle: 'Operation Prism: Real-Time Streaming MCP Widgets',
  })
);

// ── scaffold-complete.html: uses completed-session (fires complete event) ─────
// Reuse test-session (it fires scaffold.complete at the end)
writeFileSync(
  path.join(__dir, 'scaffold-complete.html'),
  buildScaffoldWidget({
    sessionId: 'test-session',
    streamBaseUrl: BASE,
    initiativeTitle: 'Operation Prism: Real-Time Streaming MCP Widgets',
    liveUrl: `https://useorgx.com/live/${INITIATIVE_ID}-6807-449c-b46c-5bc71a1219da`,
  })
);

// ── agent-status.html ─────────────────────────────────────────────────────────
writeFileSync(
  path.join(__dir, 'agent-status.html'),
  buildLiveFeedWidget({
    feedType: 'agent-status',
    feedId: INITIATIVE_ID,
    streamBaseUrl: BASE,
    streamToken: FAKE_TOKEN,
    liveUrl: `https://useorgx.com/live/${INITIATIVE_ID}-6807-449c-b46c-5bc71a1219da`,
    title: 'Agent Status',
  })
);

// ── initiative-pulse.html ──────────────────────────────────────────────────────
writeFileSync(
  path.join(__dir, 'initiative-pulse.html'),
  buildLiveFeedWidget({
    feedType: 'initiative-pulse',
    feedId: INITIATIVE_ID,
    streamBaseUrl: BASE,
    streamToken: FAKE_TOKEN,
    liveUrl: `https://useorgx.com/live/${INITIATIVE_ID}-6807-449c-b46c-5bc71a1219da`,
    title: 'Operation Prism — Initiative Pulse',
  })
);

// ── Also write production-URL copies into public/widgets/ ────────────────────
const PROD_BASE = 'https://mcp.useorgx.com';
const PROD_LIVE = `https://useorgx.com/live/${INITIATIVE_ID}-6807-449c-b46c-5bc71a1219da`;
const pubWidgets = path.join(__dir, '../../public/widgets');

// scaffold-streaming.html — self-contained SSE widget with demo mode
writeFileSync(
  path.join(pubWidgets, 'scaffold-streaming.html'),
  buildScaffoldWidget({
    sessionId: 'demo-session',
    streamBaseUrl: PROD_BASE,
    initiativeTitle: 'Operation Prism: Real-Time MCP Widgets',
    liveUrl: PROD_LIVE,
  })
);

// agent-status-stream.html
writeFileSync(
  path.join(pubWidgets, 'agent-status-stream.html'),
  buildLiveFeedWidget({
    feedType: 'agent-status',
    feedId: INITIATIVE_ID,
    streamBaseUrl: PROD_BASE,
    streamToken: 'demo',
    liveUrl: PROD_LIVE,
    title: 'Agent Status',
  })
);

// initiative-pulse-stream.html
writeFileSync(
  path.join(pubWidgets, 'initiative-pulse-stream.html'),
  buildLiveFeedWidget({
    feedType: 'initiative-pulse',
    feedId: INITIATIVE_ID,
    streamBaseUrl: PROD_BASE,
    streamToken: 'demo',
    liveUrl: PROD_LIVE,
    title: 'Operation Prism — Initiative Pulse',
  })
);

console.log('✓ Generated all widget test pages');
console.log('✓ Wrote streaming widgets to public/widgets/');
