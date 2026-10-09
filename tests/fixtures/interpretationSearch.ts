export const INTERPRETATION_SEARCH_RESULT = {
  id: 'lesson:mcp-ledger-contract', type: 'interpretation', title: 'Read ledger projections through their exact contract',
  summary: 'Ledger searches return parsed queries and work documents; they do not use the entity search envelope.',
  relevance: 0.8, created_at: '2026-10-09T14:00:00Z',
  metadata: {
    interpretation: {
      schemaVersion: '1.0.0', id: 'lesson:mcp-ledger-contract', version: 2,
      digest: `sha256:${'a'.repeat(64)}`, workspaceId: '7af01a51-49b1-47d8-98b9-91a198debca8',
      kind: 'lesson', ontology: { package: 'orgx.core', version: '1.0.0' },
      subjects: [{ ref: 'orgx://tasks/11111111-1111-4111-8111-111111111111', role: 'applies_to',
        aliases: [{ system: 'github', type: 'repository', id: 'useorgx/orgx-mcp' }] }],
      statement: { title: 'Read ledger projections through their exact contract', action: 'Validate every ledger view' },
      basis: 'inferred',
      derivedFrom: [{ eventId: '22222222-2222-4222-8222-222222222222', aggregateType: 'work_receipt', aggregateId: 'receipt-1', version: 1 }],
      producer: { name: 'orgx-lesson-consolidator', version: '1', model: 'gpt-6-luna' },
      assurance: [{ rung: 1, evidenceRefs: ['22222222-2222-4222-8222-222222222222'],
        witness: { kind: 'extractor', id: 'orgx-lesson-consolidator' }, independent: false }],
      confidence: 0.8, validFrom: '2026-10-09T14:00:00Z', recordedAt: '2026-10-09T14:00:00Z',
      status: 'candidate', scope: 'team', authority: { type: 'policy', id: 'lesson-consolidation-v1' }, baseSequence: 40,
    },
    event_id: '33333333-3333-4333-8333-333333333333',
    event_hash: `sha256:${'b'.repeat(64)}`, global_sequence: 41, assurance_rung: 1,
  },
} as const;
