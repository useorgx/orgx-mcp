import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const packageJson = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8')
) as {
  homepage?: string;
  repository?: { type?: string; url?: string };
  bugs?: { url?: string };
};
const serverJson = JSON.parse(
  readFileSync(resolve(root, 'server.json'), 'utf8')
) as {
  name?: string;
  repository?: { url?: string; source?: string };
  vendor?: { url?: string };
  websiteUrl?: string;
};
const glamaJson = JSON.parse(
  readFileSync(resolve(root, 'glama.json'), 'utf8')
) as {
  maintainers?: string[];
};

describe('canonical GitHub presence', () => {
  it('keeps package metadata aligned to useorgx/orgx-mcp', () => {
    expect(packageJson.homepage).toBe('https://mcp.useorgx.com');
    expect(packageJson.repository).toEqual({
      type: 'git',
      url: 'https://github.com/useorgx/orgx-mcp.git',
    });
    expect(packageJson.bugs).toEqual({
      url: 'https://github.com/useorgx/orgx-mcp/issues',
    });
  });

  it('keeps MCP registry metadata aligned to the canonical org', () => {
    expect(serverJson.name).toBe('com.useorgx/orgx-mcp');
    expect(serverJson.websiteUrl).toBe('https://useorgx.com');
    expect(serverJson.vendor?.url).toBe('https://useorgx.com');
    expect(serverJson.repository).toEqual({
      url: 'https://github.com/useorgx/orgx-mcp',
      source: 'github',
    });
  });

  it('keeps Glama listing ownership explicit', () => {
    expect(glamaJson.$schema).toBe(
      'https://glama.ai/mcp/schemas/connector.json'
    );
    expect(glamaJson.maintainers).toContainEqual({
      email: 'reviewers@useorgx.com',
    });
  });

  it('keeps external listing sources free of legacy GitHub org links', () => {
    const staleOrgPattern =
      /github\.com\/(?:OrgX-ai|orgx-ai)\/|https?:\/\/(?:[^/]+\.)?orgx\.ai/i;
    const listingSources = [
      'README.md',
      'docs/github-presence.md',
      'docs/anthropic-directory.md',
      'server.json',
      'glama.json',
      'package.json',
    ];

    for (const filePath of listingSources) {
      const content = readFileSync(resolve(root, filePath), 'utf8');
      expect(content, `${filePath} has a stale legacy org reference`).not.toMatch(
        staleOrgPattern
      );
    }
  });
});
