import { describe, expect, it } from 'vitest';
import { documentExcerpt } from '../src/documentExcerpt';

describe('document excerpts', () => {
  it('retains complete blocks and labels the omitted remainder', () => {
    expect(documentExcerpt('Ready for review.\n\n```json\n' + ' '.repeat(1000) + '\n```', 900)).toEqual({ text: 'Ready for review.', truncated: true });
  });
  it('does not break a long fence or table into malformed source', () => {
    expect(documentExcerpt('```text\n' + 'x'.repeat(1000) + '\n```', 900)).toEqual({ text: null, truncated: true });
    expect(documentExcerpt('| Owner | Evidence |\n| --- | --- |\n| Alex | ' + 'x'.repeat(1000) + ' |', 900).text).toBeNull();
  });
  it('preserves code indentation when the full source fits', () => {
    const source = '```py\ndef run():\n    return True\n```';
    expect(documentExcerpt(source, 900)).toEqual({ text: source, truncated: false });
  });
});
