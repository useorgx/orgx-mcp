import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const packageJson = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8')
);
const serverJson = JSON.parse(
  readFileSync(resolve(root, 'server.json'), 'utf8')
);
const glamaJson = JSON.parse(readFileSync(resolve(root, 'glama.json'), 'utf8'));
const toolCatalog = JSON.parse(
  readFileSync(resolve(root, 'docs/generated/tool-catalog.json'), 'utf8')
);
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const anthropicSubmissionForm = readFileSync(
  resolve(root, 'docs/anthropic-submission-form.md'),
  'utf8'
);

const requiredDocs = [
  'docs/privacy-policy.md',
  'docs/security-data-handling.md',
  'docs/github-presence.md',
  'docs/openai-review-runbook.md',
  'docs/support.md',
  'docs/anthropic-directory.md',
  'docs/anthropic-submission-form.md',
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

const staleOrgPattern =
  /github\.com\/(?:OrgX-ai|orgx-ai)\/|https?:\/\/(?:[^/]+\.)?orgx\.ai/i;
const claudeDirectoryEndpoint =
  'https://mcp.useorgx.com/mcp?profile=claude-directory';
const claudeDirectoryTools = [
  'orgx_bootstrap',
  'orgx_search',
  'orgx_inspect',
  'orgx_recommend',
  'get_agent_status',
  'get_initiative_pulse',
  'get_morning_brief',
  'get_operator_chronicle',
].sort();

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

function metadataBaseUrl(input) {
  const parsed = new URL(input);
  if (parsed.pathname === '/mcp' || parsed.pathname === '/sse') {
    parsed.pathname = '/';
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
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
  assert(
    packageJson.homepage === 'https://mcp.useorgx.com',
    `package homepage should point at the MCP endpoint, found: ${packageJson.homepage}`
  );
  assert(
    packageJson.repository?.url === 'https://github.com/useorgx/orgx-mcp.git',
    `package repository should point at useorgx/orgx-mcp, found: ${packageJson.repository?.url}`
  );
  assert(
    packageJson.bugs?.url === 'https://github.com/useorgx/orgx-mcp/issues',
    `package bugs URL should point at useorgx/orgx-mcp issues, found: ${packageJson.bugs?.url}`
  );
  assert(
    serverJson.repository?.url === 'https://github.com/useorgx/orgx-mcp',
    `server.json repository should point at useorgx/orgx-mcp, found: ${serverJson.repository?.url}`
  );
  assert(
    Array.isArray(glamaJson.maintainers) &&
      glamaJson.maintainers.some(
        (maintainer) => maintainer?.email === 'reviewers@useorgx.com'
      ),
    'glama.json should keep an explicit maintainer email for external listing ownership'
  );

  const listingText = [
    readme,
    JSON.stringify(packageJson),
    JSON.stringify(serverJson),
    JSON.stringify(glamaJson),
    readFileSync(resolve(root, 'docs/github-presence.md'), 'utf8'),
    readFileSync(resolve(root, 'docs/anthropic-directory.md'), 'utf8'),
    anthropicSubmissionForm,
  ].join('\n');
  assert(
    !staleOrgPattern.test(listingText),
    'External listing sources must not link to legacy OrgX-ai/orgx-ai surfaces'
  );
  assert(
    anthropicSubmissionForm.includes(claudeDirectoryEndpoint),
    `Anthropic submission form must use ${claudeDirectoryEndpoint}`
  );
  assert(
    !anthropicSubmissionForm.includes('[ fill before submitting:'),
    'Anthropic submission form must not contain a reviewer credential placeholder'
  );
  assert(
    anthropicSubmissionForm.includes('HTTPS Origin validation'),
    'Anthropic submission form must confirm HTTPS Origin validation'
  );

  const catalogClaudeTools = (toolCatalog.tools ?? [])
    .filter((tool) => tool?.profiles?.includes('claude-directory'))
    .map((tool) => tool.id)
    .sort();
  assert(
    JSON.stringify(catalogClaudeTools) ===
      JSON.stringify(claudeDirectoryTools),
    `claude-directory profile drift: expected ${claudeDirectoryTools.join(', ')}, found ${catalogClaudeTools.join(', ')}`
  );
  for (const tool of toolCatalog.tools ?? []) {
    if (!tool?.profiles?.includes('claude-directory')) continue;
    assert(
      tool.readOnly === true,
      `claude-directory tool must be read-only: ${tool.id}`
    );
  }

  const configuredBaseUrl =
    process.env.MCP_BASE_URL ||
    serverJson?.remotes?.find?.((remote) => remote.type === 'streamable-http')
      ?.url ||
    'https://mcp.useorgx.com/';
  const normalizedBase = metadataBaseUrl(configuredBaseUrl);

  await checkJsonEndpoint('server.json', `${normalizedBase}/server.json`);
  await checkJsonEndpoint(
    'glama.json',
    `${normalizedBase}/.well-known/glama.json`
  );
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
  console.log('Remember to manually verify reviewer credentials and current OAuth callbacks:');
  console.log('- hosted Claude callback supplied by the current client');
  console.log('- http://localhost:<random-port>/...');
  console.log('- http://127.0.0.1:<random-port>/...');
  console.log('- PKCE S256 and protected-resource 401 with WWW-Authenticate');
  console.log('- invalid Origin -> 403; trusted Claude Origin echoed; no-Origin CLI reaches OAuth');
  console.log('Remember to verify the dedicated review workspace via the authenticated OrgX routes:');
  console.log('- GET https://useorgx.com/api/review/sessions/<token>/status');
  console.log('- POST https://useorgx.com/api/review/sessions/<token>/bootstrap');
  console.log('- POST https://useorgx.com/api/review/sessions/<token>/reset');
}

main().catch((error) => {
  console.error(`Directory preflight failed: ${error.message}`);
  process.exitCode = 1;
});
