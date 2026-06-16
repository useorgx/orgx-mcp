import { describe, expect, it } from 'vitest';

import { formatForLLM } from '../src/responseSummarizer';

describe('response summarizer v2 OrgX workflows', () => {
  it('summarizes orgx_search results with IDs and inspect next step', () => {
    const text = formatForLLM('orgx_search', {
      _v2_tool: 'orgx_search',
      type: 'initiative',
      query: 'Crane Treasury',
      count: 1,
      results: [
        {
          id: '8118276c-a332-4dc4-b5ee-9230ee766956',
          title: 'Crane Treasury GTM',
          status: 'active',
        },
      ],
    });

    expect(text).toContain('OrgX search: 1 initiative');
    expect(text).toContain('id:8118276c-a332-4dc4-b5ee-9230ee766956');
    expect(text).toContain('Next: call orgx_inspect');
    expect(text).not.toContain('Result with');
  });

  it('summarizes orgx_inspect around the hydrated entity instead of wrapper fields', () => {
    const text = formatForLLM('orgx_inspect', {
      _v2_tool: 'orgx_inspect',
      type: 'task',
      id: 'task-1',
      entity: {
        id: 'task-1',
        title: 'Send batch 2',
        status: 'in_progress',
        summary: 'Carry reply signal forward.',
      },
    });

    expect(text).toContain('OrgX task');
    expect(text).toContain('Send batch 2');
    expect(text).toContain('id:task-1');
    expect(text).toContain('Description: Carry reply signal forward.');
    expect(text).not.toContain('Result with');
  });

  it('summarizes orgx_write creates with chainable entity IDs', () => {
    const text = formatForLLM('orgx_write', {
      _v2_tool: 'orgx_write',
      operation: 'create',
      type: 'initiative',
      data: {
        id: 'init-1',
        type: 'initiative',
        title: 'Crane Treasury GTM',
        status: 'active',
      },
    });

    expect(text).toContain('Created initiative');
    expect(text).toContain('id:init-1');
    expect(text).toContain('orgx_inspect type="initiative" id="init-1"');
    expect(text).toContain('orgx_write type="workstream" initiative_id="init-1"');
    expect(text).not.toContain('Result with');
  });

  it('labels idempotent orgx_write replay as reused existing', () => {
    const text = formatForLLM('orgx_write', {
      _v2_tool: 'orgx_write',
      operation: 'create',
      idempotent_replay: true,
      data: {
        id: 'init-existing',
        type: 'initiative',
        title: 'Crane Treasury GTM',
      },
    });

    expect(text).toContain('Reused existing initiative');
    expect(text).toContain('id:init-existing');
  });

  it('summarizes loop receipts with verification status', () => {
    const text = formatForLLM('orgx_submit_receipt', {
      _v2_tool: 'orgx_submit_receipt',
      receipt_id: 'receipt-1',
      summary: 'Batch 1 reply rewrote batch 2.',
      verification_status: 'passed',
      loop_validation: { promotable: true },
    });

    expect(text).toContain('OrgX receipt: Batch 1 reply rewrote batch 2.');
    expect(text).toContain('[passed]');
    expect(text).toContain('id:receipt-1');
    expect(text).toContain('promotable:true');
    expect(text).not.toContain('Result with');
  });
});
