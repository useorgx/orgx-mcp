// Projection shapes from lib/server/workLedger/receiptOperations.ts and the
// /api/v1/work-ledger routes in the app. Counts and documents intentionally
// share names across views, which ordinary entity search does not do.
const row = {
  id: 'ledger-1', externalId: 'receipt-1', at: '2026-10-09T14:00:00Z',
  actor: 'engineering-agent', repo: 'useorgx/orgx', summary: 'Repair ledger search',
  outcome: 'succeeded', verification: 'passed', accepted: null,
  workType: 'fix', workTypeConfidence: 0.9, area: 'MCP', workstream: 'workstream-1',
  entity: { type: 'task', id: 'task-1', title: 'Ledger search contract' },
  criteria: { met: 1, unmet: 0, unknown: 0, backed: 1 }, prs: ['42'],
  costUsd: null, confidence: 0.9,
};
const mapping = {
  workstream: 'workstream-1', entity: row.entity, confidence: 1,
  basis: 'decided', evidence: ['Confirmed by the team'], status: 'accepted', decidedBy: 'member-1',
};
const workstream = {
  id: 'workstream-1', title: 'Repair ledger search', repo: 'useorgx/orgx',
  receipts: ['receipt-1'], members: 1, sessions: 1,
  startedAt: row.at, lastAt: '2026-10-09T14:10:00Z', status: 'done',
  outcomes: { succeeded: 1 }, unmetCriteria: 0, costUsd: 0, costReported: 0,
  confidence: 0.9, weakestLink: null, objects: ['pr:useorgx/orgx#42'],
  workTypes: { fix: 1 }, areas: { MCP: 1 }, relationships: {},
};
const assessment = {
  evidence_status: 'recorded', verification_status: 'producer_reported',
  acceptance_status: 'awaiting_human_review', outcome_status: null,
};
const receipt = {
  schema_version: '0.2', receipt_id: 'receipt-1',
  intent: { summary: row.summary, criteria: [{ id: 'readable', text: 'Agents can read every ledger view', kind: 'test', required: true }] },
  actor: { type: 'agent', id: row.actor, runtime: 'codex', model: { name: 'gpt-6-luna', provider: 'openai' } },
  actions: [{ type: 'command', summary: 'Run contract tests', status: 'succeeded' }],
  artifacts: [], evidence: [{ id: 'test-1', kind: 'test', ref: { system: 'local', type: 'file', id: 'test-results.json' } }],
  verification: { status: 'passed' },
  outcome: { status: 'succeeded', summary: 'Tests pass', criteria_results: [{ criterion_id: 'readable', status: 'met', evidence_ids: ['test-1'] }] },
  lineage: { parent_receipt_refs: [], references: [] },
  timestamps: { started_at: row.at, completed_at: workstream.lastAt },
  extensions: { 'org.orgx.trail/v1': { repo: row.repo, labels: { work_type: { id: 'fix', confidence: 0.9, by: 'producer' } } } },
};

export const WORK_LEDGER_OUTPUT_VARIANTS = [
  {
    view: 'search', args: { query: 'ledger outcome:succeeded' },
    path: '/api/v1/work-ledger/receipts',
    data: {
      query: { text: 'ledger', filters: { outcome: 'succeeded' } }, total: 1,
      receipts: 1, workstreams: 1, window_days: 120,
      results: [{ ...row, score: 0.7, matched: ['ledger'], href: '/work-ledger/receipts/receipt-1',
        receipt_id: row.id, external_receipt_id: row.externalId, receipt_review_revision: 'rev-1', schema_version: '0.2',
        producer_claims: { outcome_status: 'succeeded', verification_status: 'passed', acceptance_status: null },
        receipt_assessment: assessment, human_judgment: null }],
    },
  },
  {
    view: 'workstreams', args: { view: 'workstreams' },
    path: '/api/v1/work-ledger/workstreams',
    data: { total: 1, workstreams: [{ ...workstream, mapping }] },
  },
  {
    view: 'review', args: { view: 'review' },
    path: '/api/v1/work-ledger/review',
    data: {
      total: 1, queue_limit: 200, queue_truncated: false, window_days: 120,
      items: [{ kind: 'outcome', subject: row.externalId, question: 'Did this get done?',
        guess: 'succeeded', confidence: 0.5, answers: ['succeeded', 'failed'], summary: row.summary }],
      criteria_proposals: [{ id: 'proposal-1', statement: 'Contract tests must pass', source_receipt_id: row.id }],
    },
  },
  {
    view: 'receipt', args: { receipt_id: 'receipt-1' },
    path: '/api/v1/work-ledger/receipts/receipt-1',
    data: {
      receipt_id: row.id, receipt_review_revision: 'rev-1', href: '/work-ledger/receipts/receipt-1', row, receipt,
      verdict: 'proven', criteria: [{ id: 'readable', text: 'Agents can read every ledger view', kind: 'test', required: true,
        result: 'met', confidence: 0.9, state: 'proven', lenses: { judged: { s: 'yes' }, measured: { s: 'yes' } } }],
      outcome: { status: 'succeeded', summary: 'Tests pass', confidence: 0.9, decided: null, producerStatus: 'succeeded' },
      acceptance: { status: 'pending', by: null }, receipt_assessment: assessment, human_judgment: null,
      workstream, mappings: [mapping], links: [], uncertain: ['Producer verification is a claim.'],
    },
  },
  {
    view: 'workstream', args: { workstream_id: workstream.id },
    path: '/api/v1/work-ledger/workstreams',
    data: { ...workstream, mapping, members: [row], links: [] },
  },
] as const;

export function workLedgerPayload(variant: typeof WORK_LEDGER_OUTPUT_VARIANTS[number]) {
  return {
    _v2_tool: 'orgx_search', scope: 'work_ledger', view: variant.view, ...variant.data,
    next_calls: variant.view === 'receipt' || variant.view === 'workstream'
      ? [{ tool: 'orgx_list_work_receipts', args: { view: 'review' } }]
      : [{ tool: 'orgx_list_work_receipts', args: { view: 'workstreams' } }],
  };
}
