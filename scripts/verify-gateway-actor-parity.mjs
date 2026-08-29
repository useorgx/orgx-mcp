#!/usr/bin/env node

import { createHmac } from 'node:crypto';

const REQUIRED_CANONICAL_MISS =
  'Signed gateway email does not resolve to one canonical OrgX account. Reconnect OrgX MCP and retry.';

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for gateway actor parity verification`);
  }
  return value;
}

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function createActorToken(secret, userId, email) {
  const now = Date.now();
  const payload = {
    type: 'orgx.mcp.actor.v1',
    aud: 'orgx-api',
    iss: 'orgx-mcp',
    sub: userId,
    email,
    iat: now,
    exp: now + 60_000,
  };
  const encoded = base64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

async function main() {
  const apiUrl = requiredEnv('ORGX_API_URL').replace(/\/+$/, '');
  const serviceKey = requiredEnv('ORGX_SERVICE_KEY');
  const internalSecret = requiredEnv('ORGX_INTERNAL_SECRET');

  if (!serviceKey.startsWith('oxk-')) {
    throw new Error('ORGX_SERVICE_KEY has an invalid format');
  }
  if (internalSecret.length < 32) {
    throw new Error('ORGX_INTERNAL_SECRET must be at least 32 characters');
  }

  const probeId = `deployment-parity-probe-${process.env.GITHUB_RUN_ID || Date.now()}`;
  const probeEmail = 'gateway-parity-probe@invalid.useorgx.test';
  const actorToken = createActorToken(internalSecret, probeId, probeEmail);
  const response = await fetch(`${apiUrl}/api/tools/execute`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json',
      'x-orgx-actor-token': actorToken,
    },
    body: JSON.stringify({
      tool_id: 'spawn_agent_task',
      user_id: probeId,
      args: {
        agent_id: 'parity-probe',
        task: 'Verify gateway actor signing parity without dispatching work',
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(
      `OrgX API parity probe returned non-JSON (HTTP ${response.status})`
    );
  }

  if (!response.ok) {
    throw new Error(
      `OrgX API parity probe failed before identity verification (HTTP ${response.status})`
    );
  }
  if (body?.ok !== false || body?.error !== REQUIRED_CANONICAL_MISS) {
    throw new Error(
      'Gateway actor signature was not accepted by the live OrgX API; ORGX_INTERNAL_SECRET is missing or differs between deployments'
    );
  }

  console.log(
    'Gateway actor signing parity verified; probe stopped before plan checks or agent dispatch'
  );
}

main().catch((error) => {
  console.error(
    `Gateway actor parity verification failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
