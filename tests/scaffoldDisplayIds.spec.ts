import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('scaffolded initiative display IDs', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'public/widgets/scaffolded-initiative.html'),
    'utf8'
  );

  it('preserves scaffold refs as display ids before falling back to internal ids', () => {
    expect(source).toContain(
      "id: workstream && typeof workstream.ref === 'string' ? workstream.ref : workstream && typeof workstream.id === 'string' ? workstream.id : ''"
    );
    expect(source).toContain(
      "id: milestone && typeof milestone.ref === 'string' ? milestone.ref : milestone && typeof milestone.id === 'string' ? milestone.id : ''"
    );
    expect(source).toContain(
      "id: task && typeof task.ref === 'string' ? task.ref : task && typeof task.id === 'string' ? task.id : ''"
    );
  });
});
