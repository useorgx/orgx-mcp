import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

type Yaml = Record<string, any>;
type Scope = { github: { event_name: string; ref_type: string }; inputs: Record<string, unknown> };
const workflow = load(readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8')) as Yaml;
const composite = load(readFileSync(new URL('../.github/actions/validate/action.yml', import.meta.url), 'utf8')) as Yaml;
const COMPOSITE = './.github/actions/validate';
const CHECKOUT = 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803';
const PNPM = 'pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320';
const NODE = 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38';

// These are the current guards' operators and bindings, not a general Actions
// interpreter. In particular, job `needs`/implicit success gates are not modeled.
function expression(value: unknown, scope: Scope): unknown {
  if (typeof value !== 'string') return value;
  const source = value.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1');
  assert.match(source, /^[\w\s.'"\[\]()=!&|\-]+$/, 'unsupported expression syntax');
  assert.doesNotMatch(source, /\b(?:constructor|prototype|__proto__|globalThis|process|eval|Function|require|import)\b/, 'unsupported expression access');
  const identifiers = source.replace(/'[^']*'|"[^"]*"/g, '').match(/\b[A-Za-z_]\w*\b/g) ?? [];
  const permitted = new Set(['github', 'inputs', 'event_name', 'ref_type', 'environment', 'publish_registry', 'true', 'false']);
  assert.ok(identifiers.every(name => permitted.has(name)), 'unsupported expression binding');
  const context = createContext(structuredClone(scope), { codeGeneration: { strings: false, wasm: false } });
  return new Script(`(${source})`).runInContext(context, { timeout: 1000 });
}

function setting(value: unknown, scope: Scope): unknown {
  return typeof value === 'string' && value.trim().startsWith('${{') ? expression(value, scope) : value;
}

const scope = (event: string, ref = 'branch', inputs: Record<string, unknown> = {}): Scope => ({
  github: { event_name: event, ref_type: ref }, inputs,
});
const pr = scope('pull_request', 'branch', { publish_registry: true, environment: 'production', 'cache-enabled': 'true' });
const scenarios: Array<[Scope, boolean, boolean, boolean]> = [
  [pr, true, false, false],
  [scope('push'), false, true, false],
  [scope('push', 'tag'), false, true, true],
  [scope('release', 'tag'), false, true, true],
  [scope('workflow_dispatch', 'branch', { environment: 'production', publish_registry: true }), false, true, true],
  [scope('workflow_dispatch', 'branch', { environment: 'production', publish_registry: false }), false, true, false],
  [scope('workflow_dispatch', 'branch', { environment: 'preview', publish_registry: true }), false, true, false],
  [scope('workflow_dispatch', 'branch', { environment: 'preview', publish_registry: false }), false, true, false],
];

function step(owner: Yaml, name: string): Yaml {
  const found = owner.steps?.find((entry: Yaml) => entry.name === name);
  assert.ok(found, `missing composite check: ${name}`);
  return found;
}

function call(owner: Yaml): Yaml {
  const matches = owner.steps.filter((entry: Yaml) => entry.uses === COMPOSITE);
  assert.equal(matches.length, 1, 'expected one shared validation call');
  return matches[0];
}

function cacheEffects(action: Yaml, invocation: Yaml, caller: Scope) {
  const supplied = invocation.with?.['cache-enabled'];
  const value = supplied === undefined ? action.inputs['cache-enabled'].default : setting(supplied, caller);
  const context = { ...caller, inputs: { 'cache-enabled': String(value) } };
  const node = step(action.runs, 'Set up Node.js');
  return {
    explicit: setting(node.with.cache, context),
    // setup-node enables automatic package-manager caching when omitted.
    automatic: node.with['package-manager-cache'] === undefined ? true : setting(node.with['package-manager-cache'], context),
  };
}

const exactCommands: Record<string, string> = {
  'Install dependencies': 'pnpm install --frozen-lockfile',
  'Refresh widget build version': 'node scripts/generate-widget-build-info.mjs',
  'Type-check': 'pnpm exec tsc --noEmit',
  'Run Vitest suite': 'pnpm exec vitest run --testTimeout=30000 --hookTimeout=30000',
  'Verify Wrangler build (dry-run)': 'pnpm exec wrangler deploy --env "${{ inputs.wrangler-environment }}" --dry-run --outdir .wrangler/dist',
};
const checkNames = [
  'Set up pnpm', 'Set up Node.js', 'Validate server.json', 'Validate portable ChatGPT package',
  'Install dependencies', 'Refresh widget build version', 'Type-check',
  'Install Chromium for browser-backed tests', 'Run Vitest suite',
  'Verify upstream API is reachable without redirects', 'Verify Wrangler build (dry-run)',
];

function assertPolicy(w: Yaml, action: Yaml) {
  assert.ok(w.on && Object.keys(w.on).length > 0, 'workflow triggers must be present');
  assert.ok(!Object.hasOwn(w.on, 'pull_request_target'), 'privileged pull_request_target trigger');
  assert.ok(Object.hasOwn(w.on, 'pull_request'), 'regular PR trigger is required');
  assert.deepEqual(Object.keys(w.on).sort(), ['pull_request', 'push', 'release', 'workflow_dispatch'], 'unreviewed workflow trigger');
  assert.deepEqual(w.on.push, { branches: ['main'], tags: ['v*'] }, 'trusted main/tag push admission');
  assert.deepEqual(w.on.release, { types: ['published'] }, 'published release admission');
  assert.deepEqual(w.on.pull_request, { branches: ['main'] }, 'PR target branch admission');
  assert.deepEqual(Object.keys(w.jobs).sort(), ['deploy', 'publish-registry', 'validate'], 'unexpected job admission surface');
  for (const [context, validate, deploy, publish] of scenarios) {
    const actual = ['validate', 'deploy', 'publish-registry'].map(name => Boolean(w.jobs[name].if === undefined ? true : expression(w.jobs[name].if, context)));
    assert.deepEqual(actual, [validate, deploy, publish], `${context.github.event_name}/${context.github.ref_type} own job guards`);
  }

  const job = w.jobs.validate;
  assert.equal(job['runs-on'], 'ubuntu-24.04', 'PR runner must be the standard hosted Linux label');
  assert.deepEqual(job.permissions, { contents: 'read' }, 'PR permissions must override inherited deployment writes');
  assert.equal(job.environment, undefined, 'PR job must not attach a production environment');
  assert.equal(job.env, undefined, 'PR job env must not carry service/model configuration');
  assert.equal(job.secrets, undefined, 'PR job must not inherit secrets');
  assert.equal(job.uses, undefined, 'PR job must remain explicit steps');
  assert.equal(job['continue-on-error'], undefined, 'PR validation failures must propagate');
  assert.equal(w.env, undefined, 'global env must not flow into PR validation');
  assert.equal(w.secrets, undefined, 'global inherited secrets must not flow into PR validation');
  assert.doesNotMatch(JSON.stringify({ defaults: w.defaults, job }), /\bsecrets\s*(?:\.|\[)/i, 'PR secret context reference');
  assert.equal(job.steps.length, 5, 'PR validation keeps only the reviewed actions and checks');
  for (const entry of job.steps) {
    assert.equal(entry.env, undefined, 'PR step env must not carry credentials');
    assert.equal(entry.secrets, undefined, 'PR step must not inherit secrets');
    assert.equal(entry.if, undefined, 'PR checks must execute without optional step guards');
    assert.equal(entry['continue-on-error'], undefined, 'PR checks must fail the job');
    if (entry.uses) assert.ok([CHECKOUT, COMPOSITE].includes(entry.uses), 'unreviewed PR action');
  }
  assert.equal(job.steps[0].uses, CHECKOUT, 'pinned checkout is retained');
  for (const command of ['node --check scripts/verify-gateway-actor-parity.mjs', 'pnpm widget:verify-rendering', 'pnpm widget:verify-payloads']) {
    assert.ok(job.steps.some((entry: Yaml) => entry.run?.trim() === command), `missing mandatory PR command: ${command}`);
  }

  assert.equal(action.inputs['cache-enabled'].default, 'true', 'cache-enabled default must preserve non-PR caching');
  assert.equal(action.runs.using, 'composite');
  assert.deepEqual(action.runs.steps.map((entry: Yaml) => entry.name), checkNames, 'all reviewed composite checks must remain');
  assert.equal(step(action.runs, 'Set up pnpm').uses, PNPM, 'pinned pnpm setup');
  // This pinned action defaults its independent pnpm-store cache to false.
  assert.equal(step(action.runs, 'Set up pnpm').with.cache, undefined, 'pnpm setup cache must retain its disabled default');
  assert.equal(step(action.runs, 'Set up Node.js').uses, NODE, 'pinned Node setup');
  for (const entry of action.runs.steps) {
    assert.equal(entry.if, undefined, 'composite checks cannot be skipped');
    assert.equal(entry['continue-on-error'], undefined, 'composite checks must propagate failure');
    assert.equal(entry.secrets, undefined, 'composite inherited secrets');
    if (entry.env) assert.deepEqual(entry.env, { PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: 120000 }, 'composite secret env');
    assert.doesNotMatch(JSON.stringify(entry), /\bsecrets\s*(?:\.|\[)/i, 'composite secret reference');
    if (entry.uses) assert.ok([PNPM, NODE].includes(entry.uses), 'unreviewed composite action');
    if (entry.run) assert.equal(entry.shell, 'bash', 'reviewed composite shell');
  }
  for (const [name, command] of Object.entries(exactCommands)) {
    assert.equal(step(action.runs, name).run.trim(), command, `mandatory command: ${name}`);
  }
  assert.match(step(action.runs, 'Validate server.json').run, /^\s*jq empty server.json$/m, 'server JSON check');
  assert.match(step(action.runs, 'Validate server.json').run, /^\s*jq -e '.name and .version and .remotes' server.json >\/dev\/null$/m, 'server JSON fields');
  const portable = step(action.runs, 'Validate portable ChatGPT package');
  assert.equal(portable['working-directory'], 'chatgpt-plugin');
  for (const command of ['python3 scripts/verify_package.py', "python3 -m unittest discover -s scripts -p 'test_*.py'", 'python3 scripts/build_package.py --verify-reproducible']) {
    assert.ok(portable.run.split('\n').some((line: string) => line.trim() === command), `portable package command: ${command}`);
  }
  assert.match(step(action.runs, 'Install Chromium for browser-backed tests').run, /if pnpm exec playwright install --only-shell chromium; then/, 'browser-backed checks retain Chromium');
  const upstream = step(action.runs, 'Verify upstream API is reachable without redirects').run;
  assert.match(upstream, /curl --silent --show-error/, 'upstream request is retained');
  assert.match(upstream, /"\$api_url\/api\/health"/, 'upstream health target');
  assert.match(upstream, /if \[\[ "\$status" =~ \^30\[0-9\]\$ \]\]; then/, 'redirect rejection');
  assert.match(upstream, /if \[\[ "\$status" != "200" \]\]; then/, 'unhealthy status rejection');
  assert.doesNotMatch(upstream, /--location\b/, 'upstream redirects remain visible');

  // GitHub compares strings without case sensitivity; the limited JS model does
  // not. Bind this reviewed invocation to the literal opt-out before evaluating.
  assert.equal(call(job).with?.['cache-enabled'], 'false', 'PR cache effects require the literal false input');
  assert.deepEqual(cacheEffects(action, call(job), pr), { explicit: '', automatic: false }, 'PR cache effects must disable explicit and automatic caches');
  const deployCall = call(w.jobs.deploy);
  assert.ok(!Object.hasOwn(deployCall.with ?? {}, 'cache-enabled'), 'deployment must retain the cache input default');
  assert.deepEqual(cacheEffects(action, deployCall, scope('push')), { explicit: 'pnpm', automatic: true }, 'non-PR default cache effects are preserved');
}

type Mutation = { name: string; change: (w: Yaml, action: Yaml) => void; reason: RegExp };
const negatives: Mutation[] = [
  { name: 'PR deployment guard', change: w => { w.jobs.deploy.if = true; }, reason: /own job guards/ },
  { name: 'PR registry publication guard', change: w => { w.jobs['publish-registry'].if = true; }, reason: /own job guards/ },
  { name: 'privileged PR trigger', change: w => { w.on.pull_request_target = {}; }, reason: /privileged pull_request_target/ },
  { name: 'unreviewed indirect trigger', change: w => { w.on.workflow_run = {}; }, reason: /unreviewed workflow trigger/ },
  { name: 'untrusted push branch', change: w => { w.on.push.branches = ['*']; }, reason: /trusted main\/tag push admission/ },
  { name: 'PR production environment', change: w => { w.jobs.validate.environment = 'production'; }, reason: /production environment/ },
  { name: 'PR service env', change: w => { w.jobs.validate.env = { ORGX_SERVICE_KEY: '${{ secrets.ORGX_SERVICE_KEY }}' }; }, reason: /PR job env/ },
  { name: 'PR inherited secrets', change: w => { w.jobs.validate.secrets = 'inherit'; }, reason: /inherit secrets/ },
  { name: 'global model env', change: w => { w.env = { OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}' }; }, reason: /global env/ },
  { name: 'global inherited secrets', change: w => { w.secrets = 'inherit'; }, reason: /global inherited secrets/ },
  { name: 'PR write token', change: w => { w.jobs.validate.permissions.contents = 'write'; }, reason: /PR permissions/ },
  { name: 'missing PR permission override', change: w => { delete w.jobs.validate.permissions; }, reason: /PR permissions/ },
  { name: 'unverified-cost third-party runner', change: w => { w.jobs.validate['runs-on'] = 'blacksmith-2vcpu-ubuntu-2404'; }, reason: /standard hosted Linux/ },
  { name: 'larger hosted runner', change: w => { w.jobs.validate['runs-on'] = 'ubuntu-24.04-16core'; }, reason: /standard hosted Linux/ },
  { name: 'self-hosted runner', change: w => { w.jobs.validate['runs-on'] = ['self-hosted', 'linux']; }, reason: /standard hosted Linux/ },
  { name: 'missing cache opt-out', change: w => { delete call(w.jobs.validate).with['cache-enabled']; }, reason: /PR cache effects/ },
  { name: 'case-insensitive cache opt-in', change: w => { call(w.jobs.validate).with['cache-enabled'] = 'TRUE'; }, reason: /PR cache effects/ },
  { name: 'globally disabled default cache', change: (_w, a) => { a.inputs['cache-enabled'].default = 'false'; }, reason: /cache-enabled default/ },
  { name: 'forced explicit cache', change: (_w, a) => { step(a.runs, 'Set up Node.js').with.cache = 'pnpm'; }, reason: /PR cache effects/ },
  { name: 'forced automatic cache', change: (_w, a) => { step(a.runs, 'Set up Node.js').with['package-manager-cache'] = true; }, reason: /PR cache effects/ },
  { name: 'missing automatic opt-out', change: (_w, a) => { delete step(a.runs, 'Set up Node.js').with['package-manager-cache']; }, reason: /PR cache effects/ },
  { name: 'pnpm setup store cache', change: (_w, a) => { step(a.runs, 'Set up pnpm').with.cache = true; }, reason: /pnpm setup cache/ },
  { name: 'removed type check', change: (_w, a) => { a.runs.steps = a.runs.steps.filter((entry: Yaml) => entry.name !== 'Type-check'); }, reason: /reviewed composite checks/ },
  { name: 'removed dry-run flag', change: (_w, a) => { step(a.runs, 'Verify Wrangler build (dry-run)').run = step(a.runs, 'Verify Wrangler build (dry-run)').run.replace(' --dry-run', ''); }, reason: /mandatory command: Verify Wrangler/ },
  { name: 'skipped Vitest', change: (_w, a) => { step(a.runs, 'Run Vitest suite').if = false; }, reason: /cannot be skipped/ },
  { name: 'composite service env', change: (_w, a) => { step(a.runs, 'Run Vitest suite').env = { MCP_TOKEN: '${{ secrets.MCP_TOKEN }}' }; }, reason: /composite secret env/ },
  { name: 'removed payload verification', change: w => { w.jobs.validate.steps = w.jobs.validate.steps.filter((entry: Yaml) => entry.run !== 'pnpm widget:verify-payloads'); }, reason: /reviewed actions and checks/ },
];

describe('PR validation policy from the actual workflow and composite YAML', () => {
  it('admits only read-only free PR validation, disables cache writes and retains all checks', () => {
    assertPolicy(workflow, composite);
  });

  it.each(negatives)('rejects $name', ({ change, reason }) => {
    const w = structuredClone(workflow);
    const action = structuredClone(composite);
    change(w, action);
    expect(() => assertPolicy(w, action)).toThrow(reason);
  });

  it('limits the evaluated expression language rather than exposing Node or generated code', () => {
    expect(() => expression("globalThis.process.exit()", pr)).toThrow(/unsupported expression access/);
    expect(() => expression("github.constructor.constructor('return process')()", pr)).toThrow(/unsupported expression access/);
  });
});
