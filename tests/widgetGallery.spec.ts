import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('widget gallery state contract', () => {
  const gallerySource = readFileSync(
    resolve(process.cwd(), 'public/widgets/index.html'),
    'utf8'
  );
  const taskSource = readFileSync(
    resolve(process.cwd(), 'public/widgets/task-spawned.html'),
    'utf8'
  );

  it('exposes the core operating states in the QA workbench', () => {
    expect(gallerySource).toContain('value="progressing">In progress');
    expect(gallerySource).toContain('value="completed">Completed');
    expect(gallerySource).toContain('value="blocked">Blocked');
    expect(gallerySource).toContain('value="stale">Needs refresh');
    expect(gallerySource).toContain('State contract');
  });

  it('maps the task card to an honest state-specific headline and action', () => {
    expect(taskSource).toContain('Execution Complete');
    expect(taskSource).toContain('Execution In Progress');
    expect(taskSource).toContain('Execution Needs Refresh');
    expect(taskSource).toContain("stateMeta.state === 'completed' ? 'View result'");
  });
});
