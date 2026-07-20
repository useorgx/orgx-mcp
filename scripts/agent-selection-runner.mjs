const DEFAULT_MCP_ENDPOINT = 'https://mcp.useorgx.com/mcp';
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_ITERATIONS = 10;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 45_000;

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1)
  );
  return sorted[index];
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function compactError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function providerFailure(message, metrics) {
  const error = new Error(message);
  error.provider_metrics = metrics;
  return error;
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function parseMcpJsonRpcResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const messages = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        // Keepalives and non-JSON SSE payloads are not JSON-RPC messages.
      }
    }
    return messages.at(-1) ?? null;
  }
}

async function readMcpResponse(response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return { message: parseMcpJsonRpcResponse(text), text };
}

export async function fetchMcpToolsList({
  endpoint = DEFAULT_MCP_ENDPOINT,
  profile = 'v2',
  accessToken,
  fetchImpl = globalThis.fetch,
  protocolVersion = DEFAULT_PROTOCOL_VERSION,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchMcpToolsList requires a fetch implementation.');
  }
  const url = new URL(endpoint);
  if (profile) url.searchParams.set('profile', profile);
  const commonHeaders = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  };
  let sessionId;
  let rpcId = 1;

  const rpc = async (method, params, notification = false) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      ...(notification ? {} : { id: rpcId++ }),
      method,
      ...(params === undefined ? {} : { params }),
    });
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        ...commonHeaders,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body,
    });
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    return readMcpResponse(response);
  };

  const initialized = await rpc('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: {
      name: 'orgx-agent-selection-harness',
      version: '1.0.0',
    },
  });
  if (initialized.message?.error) {
    throw new Error(
      `MCP initialize failed: ${JSON.stringify(initialized.message.error).slice(0, 500)}`
    );
  }
  await rpc('notifications/initialized', {}, true);
  const listed = await rpc('tools/list', {});
  if (listed.message?.error) {
    throw new Error(
      `MCP tools/list failed: ${JSON.stringify(listed.message.error).slice(0, 500)}`
    );
  }
  const tools = listed.message?.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(
      `MCP tools/list returned no tools for profile=${profile}. ` +
        'Set MCP_ACCESS_TOKEN when the target requires OAuth.'
    );
  }

  return {
    endpoint: url.toString(),
    profile,
    protocol_version:
      initialized.message?.result?.protocolVersion ?? protocolVersion,
    server_info: initialized.message?.result?.serverInfo ?? null,
    session_established: Boolean(sessionId),
    tools,
    tools_list_response_bytes: utf8Bytes(listed.text),
  };
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function fetchProviderJson({
  url,
  headers,
  body,
  fetchImpl,
  maxRetries,
  timeoutMs,
}) {
  const serialized = JSON.stringify(body);
  const serializedBytes = utf8Bytes(serialized);
  let attempt = 0;
  let requestBytes = 0;
  let responseBytes = 0;
  const startedAt = performance.now();
  while (true) {
    attempt += 1;
    requestBytes += serializedBytes;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: serialized,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt <= maxRetries) continue;
      throw providerFailure(
        `Provider request failed after ${attempt} attempt(s): ${compactError(error)}`,
        {
          attempts: attempt,
          latency_ms: Math.max(0, performance.now() - startedAt),
          request_bytes: requestBytes,
          response_bytes: responseBytes,
        }
      );
    }
    const text = await response.text();
    responseBytes += utf8Bytes(text);
    if (!response.ok) {
      if (retryableStatus(response.status) && attempt <= maxRetries) continue;
      throw providerFailure(
        `Provider HTTP ${response.status} after ${attempt} attempt(s): ${text.slice(0, 400)}`,
        {
          attempts: attempt,
          latency_ms: Math.max(0, performance.now() - startedAt),
          request_bytes: requestBytes,
          response_bytes: responseBytes,
        }
      );
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw providerFailure(
        `Provider returned non-JSON after ${attempt} attempt(s).`,
        {
          attempts: attempt,
          latency_ms: Math.max(0, performance.now() - startedAt),
          request_bytes: requestBytes,
          response_bytes: responseBytes,
        }
      );
    }
    return {
      json,
      attempts: attempt,
      latency_ms: Math.max(0, performance.now() - startedAt),
      request_bytes: requestBytes,
      response_bytes: responseBytes,
    };
  }
}

function selectionInstruction(prompt) {
  return [
    'Select exactly one function that best advances the user request.',
    'Do not answer in prose. Do not execute the function.',
    'Supply the smallest schema-valid argument object supported by the request.',
    '',
    `User request: ${prompt}`,
  ].join('\n');
}

function asOpenAiTool(tool) {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    strict: false,
  };
}

function asAnthropicTool(tool) {
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
  };
}

export function createOpenAiProvider({
  apiKey,
  model = 'gpt-5-mini',
  baseUrl = 'https://api.openai.com/v1',
  fetchImpl = globalThis.fetch,
  maxRetries = 2,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for the OpenAI selection provider.');
  return {
    id: 'openai',
    model,
    async select({ prompt, tools }) {
      const result = await fetchProviderJson({
        url: `${baseUrl.replace(/\/+$/, '')}/responses`,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: {
          model,
          input: selectionInstruction(prompt),
          tools: tools.map(asOpenAiTool),
          tool_choice: 'required',
          parallel_tool_calls: false,
        },
        fetchImpl,
        maxRetries,
        timeoutMs,
      });
      const call = result.json?.output?.find(
        (item) => item?.type === 'function_call'
      );
      return {
        selected_tool: call?.name ?? null,
        arguments: parseJsonObject(call?.arguments),
        ...result,
        json: undefined,
      };
    },
  };
}

export function createAnthropicProvider({
  apiKey,
  model = 'claude-sonnet-4-20250514',
  baseUrl = 'https://api.anthropic.com/v1',
  fetchImpl = globalThis.fetch,
  maxRetries = 2,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required for the Anthropic selection provider.');
  }
  return {
    id: 'anthropic',
    model,
    async select({ prompt, tools }) {
      const result = await fetchProviderJson({
        url: `${baseUrl.replace(/\/+$/, '')}/messages`,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: {
          model,
          max_tokens: 512,
          messages: [{ role: 'user', content: selectionInstruction(prompt) }],
          tools: tools.map(asAnthropicTool),
          tool_choice: { type: 'any', disable_parallel_tool_use: true },
        },
        fetchImpl,
        maxRetries,
        timeoutMs,
      });
      const call = result.json?.content?.find((item) => item?.type === 'tool_use');
      return {
        selected_tool: call?.name ?? null,
        arguments: parseJsonObject(call?.input),
        ...result,
        json: undefined,
      };
    },
  };
}

function matchesType(value, type) {
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

export function validateJsonSchema(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return [];
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.flatMap((entry) => validateJsonSchema(value, entry, path));
  }
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const choices = schema.anyOf ?? schema.oneOf;
    const results = choices.map((entry) => validateJsonSchema(value, entry, path));
    if (results.some((errors) => errors.length === 0)) return [];
    return [`${path} does not match any allowed schema`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    return [`${path} is not an allowed enum value`];
  }
  const allowedTypes = Array.isArray(schema.type)
    ? schema.type
    : typeof schema.type === 'string'
      ? [schema.type]
      : [];
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => matchesType(value, type))) {
    return [`${path} must be ${allowedTypes.join('|')}`];
  }

  const errors = [];
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in value)) errors.push(`${path}.${required} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) {
        errors.push(...validateJsonSchema(child, properties[key], `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateJsonSchema(item, schema.items, `${path}[${index}]`));
    });
  }
  return errors;
}

function isSubset(expected, actual) {
  if (expected === actual) return true;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => isSubset(item, actual[index]));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) => isSubset(value, actual[key]));
  }
  return false;
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) },
    async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }
  );
  await Promise.all(runners);
  return results;
}

function summarizeRuns(runs) {
  const completed = runs.filter((run) => !run.error);
  const selected = completed.filter((run) => run.selected_tool);
  const expected = completed.filter((run) => run.expected_selected && run.arguments_valid);
  const latencies = completed.map((run) => run.latency_ms).filter(Number.isFinite);
  const providerCalls = runs.reduce((sum, run) => sum + run.provider_attempts, 0);
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.provider}\u0000${run.fixture_id}`;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  const fixtureMetrics = [...groups.entries()].map(([key, fixtureRuns]) => {
    const [provider, fixtureId] = key.split('\u0000');
    const successfulRuns = fixtureRuns.filter((run) => !run.error);
    const counts = new Map();
    for (const run of successfulRuns) {
      if (!run.selected_tool) continue;
      counts.set(run.selected_tool, (counts.get(run.selected_tool) ?? 0) + 1);
    }
    const [dominantTool, dominantCount = 0] = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    )[0] ?? [null, 0];
    const firstSuccess = fixtureRuns.findIndex(
      (run) => run.expected_selected && run.arguments_valid
    );
    return {
      provider,
      fixture_id: fixtureId,
      expected_tool: fixtureRuns[0]?.expected_tool ?? null,
      forbidden_tool: fixtureRuns[0]?.forbidden_tool ?? null,
      runs: fixtureRuns.length,
      completed_runs: successfulRuns.length,
      dominant_tool: dominantTool,
      dominant_tool_rate: successfulRuns.length
        ? round(dominantCount / successfulRuns.length)
        : null,
      expected_tool_rate: successfulRuns.length
        ? round(successfulRuns.filter((run) => run.expected_selected).length / successfulRuns.length)
        : null,
      forbidden_tool_rate: successfulRuns.length
        ? round(successfulRuns.filter((run) => run.forbidden_selected).length / successfulRuns.length)
        : null,
      argument_validity_rate: successfulRuns.length
        ? round(successfulRuns.filter((run) => run.arguments_valid).length / successfulRuns.length)
        : null,
      expected_arguments_match_rate: successfulRuns.some(
        (run) => run.expected_arguments_match !== null
      )
        ? round(
            successfulRuns.filter((run) => run.expected_arguments_match === true).length /
              successfulRuns.filter((run) => run.expected_arguments_match !== null).length
          )
        : null,
      provider_retries: fixtureRuns.reduce(
        (sum, run) => sum + Math.max(0, run.provider_attempts - 1),
        0
      ),
      calls_to_first_success: firstSuccess === -1 ? null : firstSuccess + 1,
    };
  });

  return {
    run_count: runs.length,
    completed_run_count: completed.length,
    failed_run_count: runs.length - completed.length,
    selected_call_count: selected.length,
    top_1_accuracy: completed.length
      ? round(completed.filter((run) => run.expected_selected).length / completed.length)
      : null,
    forbidden_confusion_rate: completed.length
      ? round(completed.filter((run) => run.forbidden_selected).length / completed.length)
      : null,
    argument_validity_rate: selected.length
      ? round(selected.filter((run) => run.arguments_valid).length / selected.length)
      : null,
    provider_retry_count: runs.reduce(
      (sum, run) => sum + Math.max(0, run.provider_attempts - 1),
      0
    ),
    provider_call_count: providerCalls,
    calls_per_success: expected.length ? round(providerCalls / expected.length) : null,
    latency_ms: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    bytes: {
      request_total: runs.reduce((sum, run) => sum + run.request_bytes, 0),
      response_total: runs.reduce((sum, run) => sum + run.response_bytes, 0),
    },
    fixtures: fixtureMetrics,
  };
}

export async function runSelectionSuite({
  fixtures,
  tools,
  providers,
  iterations = DEFAULT_ITERATIONS,
  concurrency = DEFAULT_CONCURRENCY,
  profile = 'v2',
  manifest = {},
} = {}) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error('runSelectionSuite requires at least one fixture.');
  }
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('runSelectionSuite requires the actual MCP tools/list result.');
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('runSelectionSuite requires at least one provider adapter.');
  }
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const missing = fixtures.flatMap((fixture) =>
    [fixture.expected_tool, fixture.forbidden_tool]
      .filter((name) => !toolsByName.has(name))
      .map((name) => `${fixture.id}:${name}`)
  );
  if (missing.length > 0) {
    throw new Error(
      `The selected MCP profile does not expose fixture tools: ${missing.join(', ')}`
    );
  }

  const jobs = [];
  for (const provider of providers) {
    for (const fixture of fixtures) {
      for (let runIndex = 0; runIndex < iterations; runIndex += 1) {
        jobs.push({ provider, fixture, runIndex });
      }
    }
  }

  const runs = await mapConcurrent(jobs, concurrency, async ({ provider, fixture, runIndex }) => {
    try {
      const result = await provider.select({ prompt: fixture.prompt, tools });
      const selectedTool = result.selected_tool;
      const selectedDefinition = toolsByName.get(selectedTool);
      const argumentErrors = selectedDefinition
        ? validateJsonSchema(
            result.arguments ?? {},
            selectedDefinition.inputSchema ?? { type: 'object' }
          )
        : ['No registered tool was selected'];
      return {
        provider: provider.id,
        model: provider.model ?? null,
        fixture_id: fixture.id,
        run_index: runIndex,
        expected_tool: fixture.expected_tool,
        forbidden_tool: fixture.forbidden_tool,
        selected_tool: selectedTool,
        expected_selected: selectedTool === fixture.expected_tool,
        forbidden_selected: selectedTool === fixture.forbidden_tool,
        arguments_valid: argumentErrors.length === 0,
        argument_errors: argumentErrors,
        expected_arguments_match: fixture.expected_arguments
          ? isSubset(fixture.expected_arguments, result.arguments ?? {})
          : null,
        provider_attempts: result.attempts ?? 1,
        latency_ms: result.latency_ms ?? 0,
        request_bytes: result.request_bytes ?? 0,
        response_bytes: result.response_bytes ?? 0,
        error: null,
      };
    } catch (error) {
      const providerMetrics = error?.provider_metrics ?? {};
      return {
        provider: provider.id,
        model: provider.model ?? null,
        fixture_id: fixture.id,
        run_index: runIndex,
        expected_tool: fixture.expected_tool,
        forbidden_tool: fixture.forbidden_tool,
        selected_tool: null,
        expected_selected: false,
        forbidden_selected: false,
        arguments_valid: false,
        argument_errors: [],
        expected_arguments_match: fixture.expected_arguments ? false : null,
        provider_attempts: providerMetrics.attempts ?? 0,
        latency_ms: providerMetrics.latency_ms ?? 0,
        request_bytes: providerMetrics.request_bytes ?? 0,
        response_bytes: providerMetrics.response_bytes ?? 0,
        error: compactError(error),
      };
    }
  });

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    profile,
    manifest: {
      tool_count: tools.length,
      tool_ids: tools.map((tool) => tool.name).sort(),
      ...manifest,
    },
    providers: providers.map((provider) => ({
      id: provider.id,
      model: provider.model ?? null,
    })),
    iterations,
    metrics: summarizeRuns(runs),
    runs,
  };
}

export function fixturesForProfile(fixtures, profile) {
  return fixtures.filter(
    (fixture) =>
      !Array.isArray(fixture.profiles) || fixture.profiles.includes(profile)
  );
}

export function evaluateSelectionThresholds(
  report,
  {
    expectedToolRate = 0.7,
    forbiddenToolRate = 0.1,
    argumentValidityRate = 0.9,
  } = {}
) {
  const failures = [];
  for (const fixture of report.metrics?.fixtures ?? []) {
    if (fixture.completed_runs === 0) {
      failures.push(`${fixture.provider}/${fixture.fixture_id}: no completed runs`);
      continue;
    }
    if (fixture.expected_tool_rate < expectedToolRate) {
      failures.push(
        `${fixture.provider}/${fixture.fixture_id}: expected_tool_rate=${fixture.expected_tool_rate}`
      );
    }
    if (fixture.forbidden_tool_rate >= forbiddenToolRate) {
      failures.push(
        `${fixture.provider}/${fixture.fixture_id}: forbidden_tool_rate=${fixture.forbidden_tool_rate}`
      );
    }
    if (fixture.argument_validity_rate < argumentValidityRate) {
      failures.push(
        `${fixture.provider}/${fixture.fixture_id}: argument_validity_rate=${fixture.argument_validity_rate}`
      );
    }
  }
  return {
    passed: failures.length === 0,
    thresholds: {
      expected_tool_rate_min: expectedToolRate,
      forbidden_tool_rate_max_exclusive: forbiddenToolRate,
      argument_validity_rate_min: argumentValidityRate,
    },
    failures,
  };
}

export function providersFromEnvironment(env = process.env, fetchImpl = globalThis.fetch) {
  const requested = (env.AGENT_SELECTION_PROVIDERS ?? 'openai,anthropic')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return requested.map((provider) => {
    if (provider === 'openai') {
      return createOpenAiProvider({
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_SELECTION_MODEL ?? 'gpt-5-mini',
        baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        fetchImpl,
        maxRetries: Number(env.AGENT_SELECTION_MAX_RETRIES ?? 2),
        timeoutMs: Number(env.AGENT_SELECTION_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
      });
    }
    if (provider === 'anthropic') {
      return createAnthropicProvider({
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.ANTHROPIC_SELECTION_MODEL ?? 'claude-sonnet-4-20250514',
        baseUrl: env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1',
        fetchImpl,
        maxRetries: Number(env.AGENT_SELECTION_MAX_RETRIES ?? 2),
        timeoutMs: Number(env.AGENT_SELECTION_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
      });
    }
    throw new Error(
      `Unknown AGENT_SELECTION_PROVIDERS entry "${provider}". Supported: openai, anthropic.`
    );
  });
}

export async function runLiveSelectionFromEnvironment({
  fixtures,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (env.RUN_AGENT_SELECTION_TESTS !== '1') {
    throw new Error(
      'Live selection is gated. Set RUN_AGENT_SELECTION_TESTS=1 to authorize provider calls.'
    );
  }
  const profile = env.AGENT_SELECTION_PROFILE ?? 'v2';
  const manifest = await fetchMcpToolsList({
    endpoint: env.MCP_SELECTION_URL ?? DEFAULT_MCP_ENDPOINT,
    profile,
    accessToken: env.MCP_ACCESS_TOKEN,
    fetchImpl,
    protocolVersion: env.MCP_PROTOCOL_VERSION ?? DEFAULT_PROTOCOL_VERSION,
  });
  return runSelectionSuite({
    fixtures: fixturesForProfile(fixtures, profile),
    tools: manifest.tools,
    providers: providersFromEnvironment(env, fetchImpl),
    iterations: Number(env.AGENT_SELECTION_ITERATIONS ?? DEFAULT_ITERATIONS),
    concurrency: Number(env.AGENT_SELECTION_CONCURRENCY ?? DEFAULT_CONCURRENCY),
    profile,
    manifest: {
      endpoint: manifest.endpoint,
      protocol_version: manifest.protocol_version,
      server_info: manifest.server_info,
      session_established: manifest.session_established,
      tools_list_response_bytes: manifest.tools_list_response_bytes,
    },
  });
}
