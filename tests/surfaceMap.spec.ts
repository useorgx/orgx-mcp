import { describe, expect, it } from 'vitest';

import serverManifest from '../server.json';
import { formatForLLM } from '../src/responseSummarizer';
import { ORGX_SURFACES, buildSurfaceMap } from '../src/surfaceMap';

const manifestTools = new Set(serverManifest.tools.map((tool) => tool.name));

describe('OrgX surface map', () => {
  it('only names tools the server publishes', () => {
    expect(ORGX_SURFACES.length).toBeGreaterThan(5);
    for (const surface of ORGX_SURFACES) {
      for (const tool of [...surface.read, ...surface.control]) {
        expect(manifestTools.has(tool), `${surface.id} → ${tool}`).toBe(true);
      }
    }
  });

  it('has unique ids and paths', () => {
    const ids = ORGX_SURFACES.map((surface) => surface.id);
    const paths = ORGX_SURFACES.map((surface) => surface.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('filters tools to the session and resolves links against the web app', () => {
    const map = buildSurfaceMap({
      visibleTools: ['orgx_decide', 'orgx_search'],
      webUrl: 'https://staging.useorgx.com',
    });
    const decisions = map.find((surface) => surface.id === 'decisions');
    expect(decisions).toMatchObject({
      url: 'https://staging.useorgx.com/decisions',
      read: ['orgx_search'],
      control: ['orgx_decide'],
    });
    // Surfaces stay listed without visible tools so the human can be sent there.
    expect(map.find((surface) => surface.id === 'execution')).toMatchObject({
      read: [],
      control: [],
    });
  });

  it('falls back to the public web app for a missing or bad URL', () => {
    expect(buildSurfaceMap({ visibleTools: [], webUrl: 'not a url' })[0].url).toBe(
      'https://useorgx.com/command'
    );
  });

  it('tells text-only agents where work lives in the bootstrap summary', () => {
    const text = formatForLLM('orgx_bootstrap', {
      profile: 'v2',
      visible_tools: ['orgx_decide'],
      surfaces: buildSurfaceMap({ visibleTools: ['orgx_decide'] }),
    });
    expect(text).toContain('Surfaces (where work lives');
    expect(text).toContain(
      '- Decisions: https://useorgx.com/decisions — change with orgx_decide'
    );
    expect(text).toContain('- Work Ledger: https://useorgx.com/work-ledger');
  });
});
