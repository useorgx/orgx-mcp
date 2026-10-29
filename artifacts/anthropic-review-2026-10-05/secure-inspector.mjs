import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SERVER_URL, REVIEW_WORKSPACE_ID } from './secure-oauth.mjs';

const INSPECTOR_ENTRY = '/Users/hopeatina/.npm/_npx/8b9d6ce26068e72c/node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js';

function flags(argv) {
  const parsed = {};
  for (let n = 0; n < argv.length; n += 2) {
    if (!argv[n]?.startsWith('--') || argv[n + 1] === undefined) throw new Error('Invalid flag');
    parsed[argv[n].slice(2)] = argv[n + 1];
  }
  return parsed;
}

function noCredentialArguments(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/(?:password|secret|cookie|authorization|access_token|refresh_token|api_key|code_verifier)/i.test(key)) throw new Error('Credential-bearing tool arguments are prohibited');
    if (typeof item === 'object') noCredentialArguments(item);
  }
}

function scrub(value, credentialValues) {
  if (Array.isArray(value)) return value.map(item => scrub(item, credentialValues));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /(?:password|secret|cookie|authorization|access_token|refresh_token|api_key|code_verifier|stream_token|identity_token|session_token)/i.test(key) ? '[REDACTED]' : scrub(item, credentialValues),
    ]));
  }
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return JSON.stringify(scrub(parsed, credentialValues));
  } catch { /* Ordinary text content. */ }
  let text = value;
  for (const secret of credentialValues) if (secret) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/([?&](?:t|token|access_token|refresh_token|identity_token|session_token|code)=)[^&#\s"<>]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]');
}

async function run() {
  const opts = flags(process.argv.slice(2));
  const allowed = ['auth-file', 'method', 'tool-name', 'args-file', 'evidence-file', 'strict', 'uri'];
  if (Object.keys(opts).some(key => !allowed.includes(key)) || !opts['auth-file']) throw new Error('Unsupported or missing option');
  const authPath = resolve(opts['auth-file']);
  const fileStat = await lstat(authPath);
  if (!fileStat.isFile() || (fileStat.mode & 0o077) !== 0 || fileStat.uid !== process.getuid()) throw new Error('Auth file must be an owner-only regular file');
  const authRecord = JSON.parse(await readFile(authPath, 'utf8'));
  if (authRecord.serverUrl !== SERVER_URL || authRecord.workspaceId !== REVIEW_WORKSPACE_ID || !authRecord.tokens?.access_token) throw new Error('Auth file has wrong server/workspace or no access token');
  const method = opts.method ?? 'tools/list';
  if (!['initialize', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'resources/templates/list', 'prompts/list'].includes(method)) throw new Error('Unsupported MCP method');
  let toolArgs;
  if (method === 'tools/call') {
    if (!opts['tool-name'] || !opts['args-file']) throw new Error('A tool call requires --tool-name and --args-file');
    toolArgs = JSON.parse(await readFile(resolve(opts['args-file']), 'utf8'));
    noCredentialArguments(toolArgs);
    if (toolArgs.workspace_id !== REVIEW_WORKSPACE_ID) throw new Error('Tool arguments must explicitly select the Anthropic reviewer workspace');
  }
  const privateDir = await mkdtemp(join(tmpdir(), 'orgx-inspector-call-'));
  await chmod(privateDir, 0o700);
  const privateConfig = join(privateDir, 'mcp.json');
  const clientConfig = join(privateDir, 'client.json');
  try {
    await writeFile(privateConfig, JSON.stringify({ mcpServers: { 'orgx-anthropic-review': { type: 'http', url: SERVER_URL, headers: { Authorization: `Bearer ${authRecord.tokens.access_token}` }, connectionTimeout: 25_000, requestTimeout: 45_000 } } }), { mode: 0o600, flag: 'wx' });
    await writeFile(clientConfig, '{}', { mode: 0o600, flag: 'wx' });
    const argv = [INSPECTOR_ENTRY, '--cli', '--config', privateConfig, '--server', 'orgx-anthropic-review', '--method', method, '--format', 'json', '--stored-auth-only', '--client-config', clientConfig];
    if (opts.strict === 'true') argv.push('--strict');
    if (opts.uri) argv.push('--uri', opts.uri);
    if (method === 'tools/call') argv.push('--tool-name', opts['tool-name'], '--tool-args-json', JSON.stringify(toolArgs));
    const systemEnvNames = ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];
    const systemEnv = Object.fromEntries(systemEnvNames.filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const childEnv = { ...systemEnv, MCP_AUTO_OPEN_ENABLED: 'false', MCP_INSPECTOR_SECRET_STORE: 'memory', MCP_INSPECTOR_PERSIST_TOKENS: 'none', MCP_STORAGE_DIR: privateDir, MCP_INSPECTOR_OAUTH_STATE_PATH: join(privateDir, 'oauth.json'), NO_COLOR: '1' };
    const result = await new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, argv, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolveRun({ exitCode, signal, stdout, stderr }));
    });
    const credentialValues = [authRecord.tokens.access_token, authRecord.tokens.refresh_token, authRecord.clientInformation?.client_secret];
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { parsed = { output: result.stdout }; }
    const cleaned = scrub({ ...result, stdout: parsed }, credentialValues);
    const payload = parsed.result ?? parsed;
    const evidencePath = opts['evidence-file'] ? resolve(opts['evidence-file']) : join(dirname(authPath), `inspector-${Date.now()}.json`);
    await writeFile(evidencePath, JSON.stringify({ testedAt: new Date().toISOString(), client: '@modelcontextprotocol/inspector@2.9.0', serverUrl: SERVER_URL, workspaceId: REVIEW_WORKSPACE_ID, method, toolName: opts['tool-name'], ...cleaned }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ client: '@modelcontextprotocol/inspector@2.9.0', method, toolName: opts['tool-name'], exitCode: result.exitCode, toolError: payload?.isError === true, evidenceFile: evidencePath }));
    process.exitCode = result.exitCode ?? 1;
  } finally {
    await rm(privateDir, { recursive: true, force: true });
  }
}

try { await run(); }
catch { console.error(JSON.stringify({ event: 'secure_inspector_failed', detail: 'Check owner-only auth file, supported flags and explicit reviewer workspace.' })); process.exitCode = 1; }
