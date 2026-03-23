import { describe, expect, it, vi } from 'vitest';

import { hydrateTaskContext } from '../src/taskContextHydrator';

describe('task context hydrator', () => {
  it('hydrates artifact pointers through the artifact entity path', async () => {
    const fetchEntity = vi.fn(async (type: string, id: string) => ({
      id,
      entity_type: type,
      title: 'Launch brief',
      artifact_url: 'https://example.com/launch-brief.md',
    }));

    const result = await hydrateTaskContext({
      context: [
        {
          type: 'artifact',
          artifact_id: 'artifact-1',
        },
      ],
      fetchEntity,
      maxChars: 4000,
    });

    expect(fetchEntity).toHaveBeenCalledWith('artifact', 'artifact-1');
    expect(result).toMatchObject({
      truncated: false,
      hydrated: [
        {
          entry: {
            type: 'artifact',
            artifact_id: 'artifact-1',
          },
          hydrated: {
            id: 'artifact-1',
            entity_type: 'artifact',
            title: 'Launch brief',
            artifact_url: 'https://example.com/launch-brief.md',
          },
        },
      ],
    });
  });

  it('truncates hydrated context when max chars are exceeded', async () => {
    const fetchEntity = vi.fn(async (_type: string, id: string) => ({
      id,
      title: `Artifact ${id}`,
      summary: 'x'.repeat(2000),
    }));

    const result = await hydrateTaskContext({
      context: [
        { type: 'artifact', artifact_id: 'artifact-1' },
        { type: 'artifact', artifact_id: 'artifact-2' },
      ],
      fetchEntity,
      maxChars: 2500,
    });

    expect(result.truncated).toBe(true);
    expect(result.hydrated).toHaveLength(1);
    expect(result.hydrated[0]).toMatchObject({
      entry: { artifact_id: 'artifact-1' },
    });
  });
});
