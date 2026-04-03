import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('scaffolded initiative display IDs', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'public/widgets/scaffolded-initiative.html'),
    'utf8'
  );

  it('generates display IDs for initiative, workstreams, milestones, and tasks', () => {
    expect(source).toContain("display_id: makeDisplayId('INI'");
    expect(source).toContain("display_id: sectionRef || makeDisplayId('ws'");
    expect(source).toContain("display_id: milestoneRef || makeDisplayId('ms'");
    expect(source).toContain("display_id: taskRef || makeDisplayId('task'");
  });

  it('renders badges from display IDs rather than raw ids', () => {
    expect(source).toContain('renderIdBadge(task.display_id, task.raw_id)');
    expect(source).toContain('renderIdBadge(milestone.display_id, milestone.raw_id)');
    expect(source).toContain('renderIdBadge(section.display_id, section.raw_id)');
    expect(source).toContain(
      'renderIdBadge(scaffold.initiative.display_id, scaffold.initiative.raw_id)'
    );
  });

  it('prefers scaffold refs for display badges before falling back to generated labels', () => {
    expect(source).toContain(
      "var sectionRef = typeof section.ref === 'string' && section.ref.trim() ? section.ref.trim() : '';"
    );
    expect(source).toContain(
      "var milestoneRef = typeof milestone.ref === 'string' && milestone.ref.trim() ? milestone.ref.trim() : '';"
    );
    expect(source).toContain(
      "var taskRef = typeof task.ref === 'string' && task.ref.trim() ? task.ref.trim() : '';"
    );
  });
});
