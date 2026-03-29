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

  it('deduplicates repeated fetch targets before hydrating', async () => {
    const fetchEntity = vi.fn(async (type: string, id: string) => ({
      id,
      entity_type: type,
      title: `Hydrated ${id}`,
    }));

    const result = await hydrateTaskContext({
      context: [
        { type: 'artifact', artifact_id: 'artifact-1' },
        { type: 'artifact', artifact_id: 'artifact-1' },
        { type: 'entity', entity_type: 'task', entity_id: 'task-1' },
        { type: 'entity', entity_type: 'task', entity_id: 'task-1' },
      ],
      fetchEntity,
      maxChars: 4000,
    });

    expect(fetchEntity).toHaveBeenCalledTimes(2);
    expect(fetchEntity).toHaveBeenNthCalledWith(1, 'artifact', 'artifact-1');
    expect(fetchEntity).toHaveBeenNthCalledWith(2, 'task', 'task-1');
    expect(result.hydrated).toHaveLength(4);
    expect(result.hydrated[0]?.hydrated).toEqual(result.hydrated[1]?.hydrated);
    expect(result.hydrated[2]?.hydrated).toEqual(result.hydrated[3]?.hydrated);
  });
});
