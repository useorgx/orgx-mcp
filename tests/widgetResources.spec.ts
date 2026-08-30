import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  OUTPUT_TEMPLATE_URIS,
  SCAFFOLD_INITIATIVE_WIDGET_META,
  WIDGET_RESOURCES,
  WIDGET_URIS,
} from '../src/toolDefinitions';
import { WIDGET_BUILD_VERSION } from '../src/generated/widgetBuildInfo';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactReviewHtml = readFileSync(
  resolve(root, 'public/widgets/artifact-review.html'),
  'utf8'
);
const workerSource = readFileSync(resolve(root, 'src/index.ts'), 'utf8');

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

  it('keeps artifact media and outbound links inside the declared CSP allowlists', () => {
    expect(artifactReviewHtml).toContain("'https://cdn.useorgx.com'");
    expect(artifactReviewHtml).toContain('ALLOWED_ARTIFACT_MEDIA_ORIGINS');
    expect(artifactReviewHtml).toContain('ALLOWED_ARTIFACT_LINK_ORIGINS');
    expect(artifactReviewHtml).toContain(
      'return hasAllowedHttpsOrigin(value, ALLOWED_ARTIFACT_MEDIA_ORIGINS);'
    );
    expect(artifactReviewHtml).toContain(
      'evidence.sourceUrl && isAllowedArtifactLinkUrl(evidence.sourceUrl)'
    );
    expect(artifactReviewHtml).not.toContain(
      'return /^https?:\\/\\//i.test(value)'
    );
  });

  it('publishes standard ui.domain metadata only through the explicit ChatGPT profile', () => {
    expect(workerSource).toContain(
      'buildMcpAppsMeta(this.env, activeProfile)'
    );
    expect(workerSource).toContain(
      "activeProfile === 'chatgpt' ? mcpAppsContentMeta : widgetMeta"
    );
  });
});
