import { describe, expect, it } from 'vitest';

import {
  RUN_OUTPUT_TEXT_CHARS,
  RUN_OUTPUTS_TEXT_LIMIT,
  formatRunOutputsSummary,
  normalizeRunOutputs,
  runOutputsApiPath,
} from '../src/runOutputs';

const output = {
  run_artifact_id: 'ra-1',
  work_artifact_id: 'wa-1',
  title: 'Continuity answer',
  type: 'document',
  status: 'draft',
  summary: 'CODENAME=HERON',
  excerpt: 'CODENAME=HERON\nwith detail',
  excerpt_truncated: false,
  url: null,
  created_at: '2026-09-28T10:00:00.000Z',
};

describe('runOutputsApiPath', () => {
  it('encodes the run id into the app path', () => {
    expect(runOutputsApiPath('a/b')).toBe('/api/v1/runs/a%2Fb/artifacts');
  });
});

describe('normalizeRunOutputs', () => {
  it('reads the app envelope', () => {
    expect(
      normalizeRunOutputs({ ok: true, data: { outputs: [output], has_more: true } })
    ).toEqual({ outputs: [output], has_more: true });
  });

  it('is null for anything that is not the envelope', () => {
    expect(normalizeRunOutputs(null)).toBeNull();
    expect(normalizeRunOutputs({ error: 'nope' })).toBeNull();
    expect(normalizeRunOutputs({ data: { outputs: 'x' } })).toBeNull();
  });

  it('drops rows without an id and fills labels', () => {
    expect(
      normalizeRunOutputs({
        data: { outputs: [{ title: 'no id' }, { run_artifact_id: 'ra-2' }] },
      })
    ).toEqual({
      has_more: false,
      outputs: [
        {
          run_artifact_id: 'ra-2',
          work_artifact_id: null,
          title: 'Run output',
          type: 'document',
          status: null,
          summary: null,
          excerpt: null,
          excerpt_truncated: false,
          url: null,
          created_at: null,
        },
      ],
    });
  });
});

describe('formatRunOutputsSummary', () => {
  it('shows each output with its ids and body', () => {
    expect(formatRunOutputsSummary({ outputs: [output], has_more: false })).toBe(
      [
        'Outputs (1, newest first):',
        '- Continuity answer (document) work_artifact_id:wa-1 run_artifact_id:ra-1',
        '  CODENAME=HERON',
        '  with detail',
      ].join('\n')
    );
  });

  it('says when a run recorded nothing', () => {
    expect(formatRunOutputsSummary({ outputs: [] })).toBe(
      'Outputs: none recorded for this run.'
    );
  });

  it('bounds the text and points at the rest', () => {
    const long = { ...output, excerpt: 'x'.repeat(RUN_OUTPUT_TEXT_CHARS + 10) };
    const many = Array.from({ length: RUN_OUTPUTS_TEXT_LIMIT + 1 }, () => long);
    const text = formatRunOutputsSummary({ outputs: many, has_more: false })!;
    expect(text).toContain('[…truncated]');
    expect(text.match(/^- /gm)).toHaveLength(RUN_OUTPUTS_TEXT_LIMIT);
    expect(text).toContain('More outputs exist');
  });
});
