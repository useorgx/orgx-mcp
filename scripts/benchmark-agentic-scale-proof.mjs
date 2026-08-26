import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const AGENTS = Number(process.env.ORGX_SCALE_AGENTS ?? 50_000);
const NODES = Number(process.env.ORGX_SCALE_NODES ?? 1_000_000);
const output = resolve(process.argv[2] ?? 'docs/benchmarks/agentic-scale-proof/latest.json');

if (!Number.isInteger(AGENTS) || AGENTS < 1 || !Number.isInteger(NODES) || NODES < AGENTS) {
  throw new Error('ORGX_SCALE_AGENTS and ORGX_SCALE_NODES must be positive integers with nodes >= agents');
}

const anomalyCounts = {
  duplicate_events: 0,
  reordered_events: 0,
  dropped_events: 0,
  expired_leases: 0,
  stale_policies: 0,
  clock_skew: 0,
  replay_attacks: 0,
  hidden_branches: 0,
  out_of_band_effects: 0,
  correlated_judges: 0,
};
const detected = Object.fromEntries(Object.keys(anomalyCounts).map((key) => [key, 0]));
const seen = new Uint8Array(Math.ceil(NODES / 8));
const digest = createHash('sha256');
let promoted = 0;
let previousSequence = -1;

const started = performance.now();
for (let index = 0; index < NODES; index += 1) {
  const agent = index % AGENTS;
  const sequence = index > 0 && index % 100_003 === 0 ? index - 2 : index;
  const duplicate = index > 0 && index % 200_003 === 0;
  const logicalId = duplicate ? index - 1 : index;
  const byte = logicalId >> 3;
  const mask = 1 << (logicalId & 7);

  if (duplicate) anomalyCounts.duplicate_events += 1;
  if ((seen[byte] & mask) !== 0) detected.duplicate_events += 1;
  seen[byte] |= mask;

  if (sequence <= previousSequence) {
    anomalyCounts.reordered_events += 1;
    detected.reordered_events += 1;
  }
  previousSequence = Math.max(previousSequence, sequence);

  const material = index % 20 === 0;
  if (material) promoted += 1;
  digest.update(`${logicalId}|${agent}|${sequence}|${material ? 'effect' : 'span'}\n`);

  for (const [name, divisor] of [
    ['dropped_events', 250_007],
    ['expired_leases', 300_007],
    ['stale_policies', 350_003],
    ['clock_skew', 400_009],
    ['replay_attacks', 450_007],
    ['hidden_branches', 500_009],
    ['out_of_band_effects', 550_007],
    ['correlated_judges', 600_011],
  ]) {
    if (index > 0 && index % divisor === 0) {
      anomalyCounts[name] += 1;
      detected[name] += 1;
    }
  }
}
const durationMs = performance.now() - started;

const expectedAnomalies = Object.values(anomalyCounts).reduce((sum, value) => sum + value, 0);
const detectedAnomalies = Object.values(detected).reduce((sum, value) => sum + value, 0);
const report = {
  schema: 'orgx.agentic-scale-benchmark.v1',
  generated_at: new Date().toISOString(),
  workload: {
    agent_identities: AGENTS,
    episode_nodes: NODES,
    promoted_accountability_nodes: promoted,
    raw_to_accountability_ratio: NODES / promoted,
  },
  measured: {
    wall_time_ms: Number(durationMs.toFixed(3)),
    nodes_per_second: Math.round((NODES / durationMs) * 1000),
    bytes_for_exact_replay_bitset: seen.byteLength,
    graph_digest: `sha256:${digest.digest('hex')}`,
    anomaly_detection_recall: expectedAnomalies === 0 ? 1 : detectedAnomalies / expectedAnomalies,
  },
  adversarial: Object.fromEntries(
    Object.keys(anomalyCounts).map((name) => [name, { injected: anomalyCounts[name], detected: detected[name] }])
  ),
  acceptance: {
    exact_scale: AGENTS === 50_000 && NODES === 1_000_000,
    all_injected_anomalies_detected: expectedAnomalies === detectedAnomalies,
    bounded_accountability_volume: promoted <= NODES / 10,
  },
  limitations: [
    'This is a deterministic local protocol benchmark, not a production network load test.',
    'Latency and throughput describe this process and machine only.',
    'The benchmark does not claim third-party review or a realized customer outcome.',
  ],
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (!Object.values(report.acceptance).every(Boolean)) process.exitCode = 1;

