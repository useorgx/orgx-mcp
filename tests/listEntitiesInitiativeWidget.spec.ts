import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('list_entities initiative widget integration', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');

  it('adapts initiative list results into the scaffold widget payload when renderable hierarchy is present', () => {
    expect(source).toMatch(
      /const initiativeWidgetPayload =\s*buildInitiativeListWidgetPayload\(finalPayload\);[\s\S]*?_meta:\s*SCAFFOLD_INITIATIVE_WIDGET_META[\s\S]*?text:\s*JSON\.stringify\(initiativeWidgetPayload\)[\s\S]*?structuredContent:\s*initiativeWidgetPayload/m
    );
  });
});
