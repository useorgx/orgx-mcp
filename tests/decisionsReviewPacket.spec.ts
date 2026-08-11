import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('decisions widget canonical review packet', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'public/widgets/decisions.html'),
    'utf8'
  );

  it('uses the canonical packet identity and packet fields when supplied', () => {
    expect(source).toContain('decision.review_packet');
    expect(source).toContain('packet.headDecisionId');
    expect(source).toContain('packet && packet.question');
    expect(source).toContain('packet.recommendation');
    expect(source).toContain('packet.consequences');
    expect(source).toContain("if (packetId) return `packet:${packetId}`");
    expect(source).toContain('review packet');
    expect(source).toContain('Collapsed');
  });
});
