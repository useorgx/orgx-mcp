import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const foundation = readFileSync(
  resolve(__dirname, '../public/widgets/shared/widget-foundation.css'),
  'utf8'
);

describe('reduced motion', () => {
  it('shows entrance-animated content when a widget turns the animation off', () => {
    // Widgets set `.animate-in { animation: none }` under reduced motion,
    // which would leave the foundation's starting opacity: 0 in place.
    const block = foundation.slice(
      foundation.indexOf('@media (prefers-reduced-motion: reduce)')
    );
    expect(block).toMatch(/\.animate-in\s*\{\s*opacity:\s*1;?\s*\}/);
  });
});
