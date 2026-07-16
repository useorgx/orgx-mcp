import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('task spawned widget', () => {
  const widgetSource = readFileSync(
    resolve(process.cwd(), 'public/widgets/task-spawned.html'),
    'utf8'
  );

  it('distinguishes dispatches from consolidated spawn preflight actions', () => {
    expect(widgetSource).toContain("payload._action || payload.action || 'spawn'");
    expect(widgetSource).toContain(
      "const dispatched = action === 'spawn' || action === 'handoff'"
    );
    expect(widgetSource).toContain(
      'Routing and cost context only. No agent work was dispatched.'
    );
    expect(widgetSource).toContain('Preflight only · no dispatch');
  });
});
