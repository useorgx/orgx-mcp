import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('scaffold_initiative widget registration', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');

  it('registers scaffold_initiative via registerAppTool so widget metadata is exposed to MCP app hosts', () => {
    expect(source).toMatch(
      /registerAppTool\(\s*this\.server,\s*'scaffold_initiative'/
    );
  });

  it('declares scaffold widget output template on the app tool registration', () => {
    expect(source).toMatch(
      /'scaffold_initiative'[\s\S]*?SCAFFOLD_INITIATIVE_WIDGET_META/
    );
  });

  it('returns scaffold widget payload as the first text content block for MCP app hosts', () => {
    expect(source).toMatch(
      /content:\s*\[\s*\{\s*type:\s*'text',\s*text:\s*JSON\.stringify\(finalPayload\)[\s\S]*?structuredContent:\s*finalPayload/m
    );
  });
});
