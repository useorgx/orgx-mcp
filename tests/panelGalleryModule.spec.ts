import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MCP_APPS_SHARED_COMPONENT_PATHS } from '../src/widgetConfig';

const widgets = resolve(process.cwd(), 'public/widgets');
const read = (path: string) => readFileSync(resolve(widgets, path), 'utf8');

/**
 * The panel's local preview fixtures (?gallery=true) are their own module so
 * the MCP Apps resource never carries them: panel-app.js loads it on demand.
 */
describe('panel gallery module', () => {
  it('is never inlined into the served panel', () => {
    expect(MCP_APPS_SHARED_COMPONENT_PATHS).not.toContain('shared/panel/panel-gallery.js');
    expect(read('orgx-panel.html')).not.toContain('panel-gallery.js');
  });

  it('holds the fixtures, and panel-app.js loads it only for ?gallery=true', () => {
    const app = read('shared/panel/panel-app.js');
    for (const fixture of ['runGallery', 'FIXTURE_QUEUE', 'galleryWork', 'galleryHistory', 'galleryFocus']) {
      expect(app).not.toContain(fixture);
      expect(read('shared/panel/panel-gallery.js')).toContain(fixture);
    }
    expect(app).toMatch(/if \(isGallery\) \{\s*if \(window\.OrgXPanelGallery\)[\s\S]*?galleryScript\.src = 'shared\/panel\/panel-gallery\.js';/);
  });
});
