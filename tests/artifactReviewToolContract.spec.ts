import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(resolve('src/index.ts'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve('server.json'), 'utf8')) as {
  tools: Array<{
    name: string;
    annotations: Record<string, boolean>;
  }>;
};

function registration(toolId: string) {
  const start = indexSource.search(
    new RegExp(`registerAppTool\\(\\s*this\\.server,\\s*'${toolId}'`)
  );
  expect(start, `${toolId} registration`).toBeGreaterThanOrEqual(0);
  const next = indexSource.indexOf('\n    // ---', start + 1);
  return indexSource.slice(start, next >= 0 ? next : undefined);
}

describe('canonical artifact review MCP tools', () => {
  it('hydrates an explicit or selected artifact from the canonical app route', () => {
    const source = registration('review_artifact');
    expect(source).toContain('`/api/artifacts/${encodeURIComponent(artifactId)}`');
    expect(source).toContain('structuredContent: result');
    expect(source).toContain('result.reviewContract');
    expect(source).not.toContain("type: 'artifact',\n            id:");
  });

  it('submits one fail-closed artifact PATCH and requires feedback for changes', () => {
    const source = registration('submit_artifact_review');
    expect(source).toContain("method: 'PATCH'");
    expect(source).toContain("status === 'changes_requested' && !note");
    expect(source).toContain('allowFallback: false');
    expect(source).not.toContain("'orgx_act'");
    expect(source).not.toContain("'orgx_decide'");
  });

  it('publishes honest read and write annotations', () => {
    const readTool = manifest.tools.find((tool) => tool.name === 'review_artifact');
    const writeTool = manifest.tools.find(
      (tool) => tool.name === 'submit_artifact_review'
    );

    expect(readTool?.annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    });
    expect(writeTool?.annotations).toEqual({
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: true,
    });
  });
});
