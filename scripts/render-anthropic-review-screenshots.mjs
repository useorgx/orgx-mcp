import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

import { chromium } from 'playwright';

const root = process.cwd();
const publicRoot = resolve(root, 'public');
const outputRoot = resolve(publicRoot, 'screenshots');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const captures = [
  {
    file: 'anthropic-memory-search-response.png',
    widget: 'search-results.html',
    prompt: 'What did we decide about Search Copilot readiness?',
    payload: {
      scope: 'decisions',
      topic: 'Search Copilot readiness',
      decisions: [
        {
          id: 'decision-search-threshold',
          title: 'Keep the reviewer relevance threshold at 0.82',
          summary:
            'Use the 0.82 threshold so accepted decisions and linked artifacts stay above the fold.',
          status: 'approved',
          decided_by: 'Pace · Product',
          initiative_id: 'search-copilot-readiness',
        },
        {
          id: 'decision-evidence-order',
          title: 'Show accepted proof before activity history',
          summary:
            'Rank accepted artifacts first, then supporting execution activity and operator notes.',
          status: 'approved',
          decided_by: 'Eli · Engineering',
          initiative_id: 'search-copilot-readiness',
        },
        {
          id: 'decision-read-only-review',
          title: 'Keep the directory review surface read-only',
          summary:
            'Expose memory, status, pulse, brief, and chronicle reads without mutation tools or prompts.',
          status: 'approved',
          decided_by: 'Orion · Operations',
          initiative_id: 'search-copilot-readiness',
        },
      ],
    },
  },
  {
    file: 'anthropic-agent-status-response.png',
    widget: 'agent-status.html',
    prompt: 'Show me what the OrgX agents are doing right now.',
    payload: {
      agents: [
        {
          agent_name: 'Pace',
          role: 'Product',
          status: 'running',
          current_task:
            'Synthesizing the Search Copilot reviewer narrative from accepted decisions',
          progress: 76,
          eta: '~35 minutes remaining',
          tasks: [
            {
              id: 'pace-1',
              title: 'Summarize accepted product decisions',
              status: 'done',
            },
            {
              id: 'pace-2',
              title: 'Assemble reviewer-facing continuity notes',
              status: 'in_progress',
            },
          ],
          artifacts: [
            {
              id: 'pace-a',
              title: 'Search Copilot decision digest',
              artifact_type: 'prod.brief',
              status: 'approved',
            },
          ],
        },
        {
          agent_name: 'Eli',
          role: 'Engineering',
          status: 'running',
          current_task:
            'Running relevance and output-schema regressions for the read-only connector',
          progress: 84,
          eta: '~20 minutes remaining',
          tasks: [
            {
              id: 'eli-1',
              title: 'Verify eight-tool discovery profile',
              status: 'done',
            },
            {
              id: 'eli-2',
              title: 'Capture MCP Apps response evidence',
              status: 'in_progress',
            },
          ],
          artifacts: [
            {
              id: 'eli-a',
              title: 'Directory contract test report',
              artifact_type: 'eng.report',
              status: 'approved',
            },
          ],
        },
      ],
    },
  },
  {
    file: 'anthropic-initiative-pulse-response.png',
    widget: 'initiative-pulse.html',
    prompt:
      'Give me the pulse for the Search Copilot Readiness initiative.',
    payload: {
      id: 'search-copilot-readiness',
      name: 'Search Copilot Readiness',
      status: 'active',
      health_score: 88,
      message:
        'The read-only connector contract is stable and the remaining work is evidence capture.',
      progress_pct: 82,
      pending_decisions: 0,
      active_workstreams: 3,
      total_workstreams: 3,
      blocked_workstreams: 0,
      roi_summary: {
        total_cost: 286,
        total_value: 1760,
        period: '30d',
      },
      next_steps: [],
      blockers: [],
      workstreams: [
        {
          id: 'ws-contract',
          title: 'Directory Contract',
          progress_pct: 96,
          status: 'active',
          agent_name: 'Eli',
          agent_domain: 'engineering',
          summary: 'Eight read-only tools and discovery resources are locked.',
        },
        {
          id: 'ws-evidence',
          title: 'Reviewer Evidence',
          progress_pct: 78,
          status: 'active',
          agent_name: 'Pace',
          agent_domain: 'product',
          summary: 'Response-only screenshots and paired prompts are in progress.',
        },
        {
          id: 'ws-operations',
          title: 'Release Readiness',
          progress_pct: 72,
          status: 'active',
          agent_name: 'Orion',
          agent_domain: 'operations',
          summary: 'OAuth, Origin validation, and upstream health checks are staged.',
        },
      ],
      recent_artifacts: [
        {
          id: 'artifact-contract',
          name: 'Read-only discovery contract',
          status: 'approved',
          artifact_type: 'eng.config',
          created_by_name: 'Eli',
          primary_url: 'https://useorgx.com/artifacts/artifact-contract',
          primary_label: 'Open artifact',
        },
        {
          id: 'artifact-runbook',
          name: 'Reviewer runbook',
          status: 'approved',
          artifact_type: 'ops.runbook',
          created_by_name: 'Orion',
          primary_url: 'https://useorgx.com/artifacts/artifact-runbook',
          primary_label: 'Open artifact',
        },
      ],
      artifact_summary: { total: 2, approved: 2, in_review: 0 },
    },
  },
  {
    file: 'anthropic-morning-brief-response.png',
    widget: 'morning-brief.html',
    prompt: "Give me today's morning brief.",
    payload: {
      generated_at: '2026-08-05T13:00:00.000Z',
      session_summary: {
        session_type: 'overnight',
        receipts_produced: 4,
        completed: 5,
        failed: 0,
      },
      value_dashboard: {
        value_delivered_usd: 1760,
        roi_display: '515%',
        decisions_resolved: 3,
        completed_this_week: 5,
        initiatives_completed: 1,
        estimated_time_saved_hours: 12.5,
      },
      workspace_pulse: {
        stats: {
          activeInitiatives: 2,
          pendingDecisions: 0,
          blockedWorkstreams: 0,
        },
      },
      summary:
        'Search Copilot Readiness is healthy. The eight-tool read-only surface is locked, Origin validation is covered, and evidence capture is the final release task.',
      top_priorities: [
        {
          domain: 'Engineering',
          title: 'Run the final discovery regression',
          reason: 'Confirms the deployed profile still exposes exactly eight read-only tools.',
        },
        {
          domain: 'Product',
          title: 'Package response-only screenshots',
          reason: 'Pairs each read-only widget response with its reviewer prompt.',
        },
        {
          domain: 'Operations',
          title: 'Capture production health receipts',
          reason: 'Separates primary health, fallback health, deployment, and submission states.',
        },
      ],
      top_receipts: [
        { intent: 'Locked the read-only profile', attributed_value_usd: 520 },
        { intent: 'Verified MCP output schemas', attributed_value_usd: 410 },
      ],
      artifacts_produced: [
        {
          id: 'artifact-contract',
          name: 'Read-only discovery contract',
          status: 'approved',
          artifact_type: 'eng.config',
          created_by_name: 'Eli',
          summary: 'Eight tools, four widgets, no prompts, and no mutation surfaces.',
          primary_url: 'https://useorgx.com/artifacts/artifact-contract',
          primary_label: 'Open artifact',
        },
        {
          id: 'artifact-origin',
          name: 'Origin validation report',
          status: 'approved',
          artifact_type: 'eng.report',
          created_by_name: 'Orion',
          summary: 'Invalid, trusted, and no-Origin transport cases are covered.',
          primary_url: 'https://useorgx.com/artifacts/artifact-origin',
          primary_label: 'Open artifact',
        },
      ],
      review_items: [],
      exceptions: [],
      brief_markdown: '# Morning Brief',
    },
  },
];

function safePublicPath(pathname) {
  const relative = normalize(decodeURIComponent(pathname)).replace(
    /^(\.\.(\/|\\|$))+/,
    ''
  );
  const candidate = resolve(publicRoot, `.${relative}`);
  return candidate.startsWith(publicRoot) ? candidate : null;
}

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const filePath = safePublicPath(pathname);
    if (!filePath) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen)
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve screenshot server port');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function renderCapture(browser, baseUrl, capture) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1200 },
    deviceScaleFactor: 3,
    colorScheme: 'light',
  });
  const page = await context.newPage();
  await page.route('**/shared/mcp-apps-sdk.umd.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: '',
    })
  );
  await page.setContent(
    `<style>html,body{margin:0;background:#f4f7fa}iframe{display:block;border:0;width:1280px;height:1200px}</style><iframe title="MCP Apps response" src="${baseUrl}/widgets/${capture.widget}?theme=light"></iframe>`
  );
  const frame = page.frames().find((candidate) =>
    candidate.url().includes(`/widgets/${capture.widget}`)
  );
  if (!frame) throw new Error(`Widget frame did not load: ${capture.widget}`);
  await frame.waitForLoadState('domcontentloaded');
  await frame.evaluate((payload) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-result',
          params: { structuredContent: payload },
        },
      })
    );
  }, capture.payload);
  await frame.locator('#content .animate-in').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  await frame.locator('#content').screenshot({
    path: join(outputRoot, capture.file),
    animations: 'disabled',
  });
  await context.close();
}

await mkdir(outputRoot, { recursive: true });
const { server, baseUrl } = await startStaticServer();
const browser = await chromium.launch({ channel: 'chrome', headless: true });

try {
  for (const capture of captures) {
    await renderCapture(browser, baseUrl, capture);
    console.log(`${capture.file}\t${capture.prompt}`);
  }
} finally {
  await browser.close();
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  );
}
