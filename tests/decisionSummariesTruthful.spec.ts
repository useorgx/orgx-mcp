import { describe, expect, it } from 'vitest';
import { summarizeChatGPTToolResult } from '../src/toolDefinitions';

describe('approve/reject decision summaries', () => {
  for (const toolId of ['approve_decision', 'reject_decision']) {
    it(`${toolId} never claims the decision was settled`, () => {
      const summary = summarizeChatGPTToolResult(toolId, {});
      expect(summary).not.toMatch(/\b(approved|rejected|declined)\b/i);
      expect(summary).toMatch(/only when you click/);
    });

    it(`${toolId} points at the review url when the server returns one`, () => {
      const summary = summarizeChatGPTToolResult(toolId, {
        review_url: 'https://useorgx.com/decisions/d-1',
      });
      expect(summary).toContain('https://useorgx.com/decisions/d-1');
    });
  }
});
