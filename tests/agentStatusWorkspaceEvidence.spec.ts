import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('agent status workspace evidence query', () => {
  it('unions workspace artifacts even when initiative ids were discovered', () => {
    const source = readFileSync('src/index.ts', 'utf8');
    const workspaceUnion = source.indexOf(
      "if (workspaceId && params.toolId === 'get_agent_status')"
    );
    const initiativeLookup = source.indexOf('if (initiativeIds.size > 0)');

    expect(initiativeLookup).toBeGreaterThan(-1);
    expect(workspaceUnion).toBeGreaterThan(initiativeLookup);

    const nextBranch = source.indexOf('} else if (', workspaceUnion);
    const block = source.slice(workspaceUnion, nextBranch);
    expect(block).toContain("type: 'artifact'");
    expect(block).toContain('workspaceId');
    expect(block).toContain('limit: 100');
    expect(block).not.toContain('initiativeIds.size === 0');
  });
});
