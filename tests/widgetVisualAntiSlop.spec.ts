import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('widget visual anti-slop contract', () => {
  it('does not use colored left-edge accent borders', () => {
    const widgetDirectory = resolve(process.cwd(), 'public/widgets');
    const offenders = readdirSync(widgetDirectory)
      .filter((file) => file.endsWith('.html'))
      .flatMap((file) => {
        const source = readFileSync(resolve(widgetDirectory, file), 'utf8');
        const usesLeftBorder = /border-left\s*:/i.test(source);
        const usesLeftInset =
          /box-shadow\s*:\s*inset\s+[1-9][\d.]*px\s+0\s+0/i.test(source);
        return usesLeftBorder || usesLeftInset ? [file] : [];
      });

    expect(offenders).toEqual([]);
  });
});
