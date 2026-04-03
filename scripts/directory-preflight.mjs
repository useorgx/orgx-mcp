import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const packageJson = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8')
);
const serverJson = JSON.parse(
  readFileSync(resolve(root, 'server.json'), 'utf8')
);
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

const requiredDocs = [
  'docs/privacy-policy.md',
  'docs/security-data-handling.md',
  'docs/support.md',
  'docs/anthropic-directory.md',
  'docs/anthropic-reviewer-runbook.md',
  'docs/anthropic-release-manager-checklist.md',
];

const requiredReadmeSections = [
  '## Reviewer Operations',
  '## Examples',
  '## Privacy Policy',
  '## Support',
  '## Security & Data Handling',
  '## Anthropic Directory Review',
  '## Limitations',
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function checkJsonEndpoint(label, url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json, text/plain, */*',
      'user-agent': 'orgx-mcp-directory-preflight/1.0',
    },
  });
  assert(response.ok, `${label} failed: ${url} -> ${response.status}`);
  return response;
}

async function main() {
  assert(
    packageJson.version === serverJson.version,
    `Version mismatch: package.json=${packageJson.version} server.json=${serverJson.version}`
  );

  for (const docPath of requiredDocs) {
    assert(existsSync(resolve(root, docPath)), `Missing required doc: ${docPath}`);
  }

  for (const heading of requiredReadmeSections) {
    assert(readme.includes(heading), `README missing required section: ${heading}`);
  }

  assert(
    serverJson.websiteUrl === 'https://useorgx.com',
    `websiteUrl should point at the product site, found: ${serverJson.websiteUrl}`
  );

  const baseUrl =
    process.env.MCP_BASE_URL ||
    serverJson?.remotes?.find?.((remote) => remote.type === 'streamable-http')
      ?.url ||
    'https://mcp.useorgx.com/';
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

  await checkJsonEndpoint('server.json', `${normalizedBase}/server.json`);
  await checkJsonEndpoint(
    'oauth-authorization-server',
    `${normalizedBase}/.well-known/oauth-authorization-server`
  );
  await checkJsonEndpoint(
    'oauth-protected-resource',
    `${normalizedBase}/.well-known/oauth-protected-resource`
  );
  await checkJsonEndpoint('healthz', `${normalizedBase}/healthz`);

  console.log('Directory preflight passed.');
  console.log(`Verified base URL: ${normalizedBase}`);
  console.log('Remember to manually verify reviewer credentials and callback allowlists:');
  console.log('- http://localhost:6274/oauth/callback');
  console.log('- http://localhost:6274/oauth/callback/debug');
  console.log('- https://claude.ai/api/mcp/auth_callback');
  console.log('- https://claude.com/api/mcp/auth_callback');
  console.log('Remember to verify the dedicated review workspace via the authenticated OrgX routes:');
  console.log('- GET https://useorgx.com/api/review/anthropic/status');
  console.log('- POST https://useorgx.com/api/review/anthropic/bootstrap');
  console.log('- POST https://useorgx.com/api/review/anthropic/reset');
}

main().catch((error) => {
  console.error(`Directory preflight failed: ${error.message}`);
  process.exitCode = 1;
});
