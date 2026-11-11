import { describe, expect, it } from 'vitest';
import {
  backendErrorText,
  isRawErrorText,
  legibleRecordSummary,
  legibleRecordTitle,
  legibleSearchFailure,
  legibleSearchRecord,
} from '../src/searchLegibility';

// Shapes copied from real orgx_search results (Nov 2026).
const ASSIGNMENT =
  '## Your Assignment\n\n**Goal:** Daily readiness check. Read the bound goal and report one concrete next step or blocker.\n**Mode:** planning_only\n\n## Initiative Context\n**Initiative:** User Request';
const PROVIDER_ERROR =
  'Run failed: 400 {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."},"request_id":"req_011Cf7pMT843cbh1sJJG2PXq"} (status=400) (cause=Error, causeMessage=400 {"type":"error"})';

describe('search record titles', () => {
  it('turns an assignment prompt into its goal line, keeping an agent prefix', () => {
    expect(legibleRecordTitle(ASSIGNMENT)).toBe(
      'Daily readiness check. Read the bound goal and report one concrete next step or blocker.'
    );
    expect(legibleRecordTitle(`Orion: ${ASSIGNMENT}`)).toMatch(/^Orion: Daily readiness check\./);
  });

  it('strips markdown and leaves plain titles and non-strings alone', () => {
    expect(legibleRecordTitle('**Launch** plan for `pricing`')).toBe('Launch plan for pricing');
    expect(legibleRecordTitle('Continue governed work after human judgment')).toBe(
      'Continue governed work after human judgment'
    );
    expect(legibleRecordTitle(null)).toBeNull();
  });
});

describe('search record summaries', () => {
  it('says what a continuation code means', () => {
    expect(legibleRecordSummary('Continuation failed: missing_initiative_id')).toBe(
      'Approval recorded, but the decision has no initiative, so nothing could resume.'
    );
    expect(legibleRecordSummary('Continuation failed: brand_new_reason')).toBe(
      'Approval recorded, but no work resumed.'
    );
  });

  it('turns runtime codes and runner errors into sentences', () => {
    expect(legibleRecordSummary('Model call stopped: model_budget_exhausted')).toBe(
      'Model call stopped: the run reached its model budget before finishing.'
    );
    expect(legibleRecordSummary('Console run job missing runId in input payload')).toMatch(/^The run never started/);
    expect(legibleRecordSummary('Native SDK recovery checkpoint unavailable or already consumed')).toMatch(
      /^The run could not resume/
    );
  });

  it('keeps what a provider said and drops its JSON and request id', () => {
    const text = legibleRecordSummary(PROVIDER_ERROR) as string;
    expect(text).toBe('Run failed: temperature is deprecated for this model.');
    expect(text).not.toMatch(/req_|request_id|\{|status=/);
  });

  it('drops summaries that only repeat a prompt or carry only internals', () => {
    expect(legibleRecordSummary(ASSIGNMENT)).toBeNull();
    expect(legibleRecordSummary('relation "public.memory_chunks" does not exist')).toBeNull();
  });

  it('leaves prose alone, including prose about a failure', () => {
    const prose = 'Run failed before completion due to model budget exhaustion. Cost was recorded.';
    expect(legibleRecordSummary(prose)).toBe(prose);
    expect(isRawErrorText(prose)).toBe(false);
  });
});

describe('search records', () => {
  it('cleans title, summary and a prompt-only description, keeping everything else', () => {
    const record = {
      id: 'run-1',
      type: 'run',
      title: ASSIGNMENT,
      summary: 'Continuation failed: missing_initiative_id',
      description: ASSIGNMENT,
      status: 'failed',
      url: 'https://useorgx.com/runs/run-1',
    };
    const result = legibleSearchRecord(record);
    expect(result).toMatchObject({ id: 'run-1', type: 'run', status: 'failed', url: record.url, description: null });
    expect(result.title).toMatch(/^Daily readiness check\./);
    expect(result.summary).toMatch(/^Approval recorded/);
  });

  it('returns the same object when nothing needs cleaning, so a second pass is a no-op', () => {
    const record = { id: 'i', title: 'Evidence plan', summary: 'Three pilots, one owner.' };
    expect(legibleSearchRecord(record)).toBe(record);
    const cleaned = legibleSearchRecord({ id: 'r', title: ASSIGNMENT, summary: PROVIDER_ERROR });
    expect(legibleSearchRecord(cleaned)).toBe(cleaned);
  });
});

describe('search failures', () => {
  it('never passes raw backend text through', () => {
    for (const raw of [
      'relation "public.memory_chunks" does not exist',
      'Database client not configured',
      'permission denied for table decisions',
      '{"code":"PGRST301","message":"JWT expired"}',
      'vector_search_failed',
      'TypeError: fetch failed',
    ]) {
      const message = legibleSearchFailure(500, raw);
      expect(message).not.toContain(raw);
      expect(message).toMatch(/^Search is temporarily unavailable/);
      expect(legibleSearchFailure(400, raw)).not.toContain(raw);
    }
  });

  it('chooses the message by status', () => {
    expect(legibleSearchFailure(401, 'Unauthorized')).toMatch(/Reconnect OrgX/);
    expect(legibleSearchFailure(403, 'Forbidden: workspace_mismatch')).toMatch(/Reconnect OrgX/);
    expect(legibleSearchFailure(404, null)).toMatch(/workspace was not found/);
    expect(legibleSearchFailure(429, null)).toMatch(/too many searches/);
    expect(legibleSearchFailure(undefined, null)).toMatch(/^Search is temporarily unavailable/);
  });

  it('keeps a client-error sentence written for people', () => {
    expect(legibleSearchFailure(400, 'Query must be at least 2 characters.')).toBe(
      'Query must be at least 2 characters.'
    );
  });

  it('reads the backend text from the shapes the APIs send', () => {
    expect(backendErrorText({ ok: false, error: 'boom' })).toBe('boom');
    expect(backendErrorText({ error: { message: 'nested' } })).toBe('nested');
    expect(backendErrorText({ message: 'msg', error: 'code' })).toBe('msg');
    expect(backendErrorText(null)).toBeNull();
  });
});
