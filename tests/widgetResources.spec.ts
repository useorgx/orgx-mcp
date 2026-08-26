import { describe, expect, it } from 'vitest';

import {
  OUTPUT_TEMPLATE_URIS,
  SCAFFOLD_INITIATIVE_WIDGET_META,
  WIDGET_RESOURCES,
  WIDGET_URIS,
} from '../src/toolDefinitions';
import { WIDGET_BUILD_VERSION } from '../src/generated/widgetBuildInfo';

describe('widget resources', () => {
  it('registers scaffolded initiative widget URIs', () => {
    expect(WIDGET_URIS.scaffoldedInitiative).toBe(
      `ui://widget/scaffolded-initiative.html?v=${WIDGET_BUILD_VERSION}`
    );
    expect(OUTPUT_TEMPLATE_URIS.scaffoldedInitiative).toBe(
      `ui://widget/scaffolded-initiative.skybridge.html?v=${WIDGET_BUILD_VERSION}`
    );
  });

  it('includes scaffolded initiative in the resource registry', () => {
    expect(WIDGET_RESOURCES).toContainEqual({
      name: 'scaffolded-initiative-widget',
      uri: WIDGET_URIS.scaffoldedInitiative,
      title: 'Scaffolded Initiative Widget',
    });
  });

  it('exposes scaffold_initiative widget metadata', () => {
    expect(SCAFFOLD_INITIATIVE_WIDGET_META).toMatchObject({
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.scaffoldedInitiative,
      ui: {
        resourceUri: WIDGET_URIS.scaffoldedInitiative,
        visibility: ['model', 'app'],
      },
    });
  });
});
