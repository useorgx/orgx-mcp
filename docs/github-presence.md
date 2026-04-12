# GitHub Presence

OrgX MCP uses `useorgx` as the canonical public GitHub organization.

## Canonical Public Surface

- GitHub organization: `https://github.com/useorgx`
- GitHub repository: `https://github.com/useorgx/orgx-mcp`
- Product site: `https://useorgx.com`
- MCP endpoint: `https://mcp.useorgx.com`
- Support tracker: `https://github.com/useorgx/orgx-mcp/issues`

## Listing Sources

Keep these files aligned before publishing or updating external directory listings:

- MCP Registry: `server.json`
- Glama: `glama.json`
- Anthropic directory handoff: `docs/anthropic-directory.md`
- README directory links: `README.md`
- npm/package metadata for tooling consumers: `package.json`

## Legacy Org Handling

The old `OrgX-ai` GitHub surface must not be used in new public links.

If a legacy `OrgX-ai` repository or organization page is discovered, handle it as an external admin task:

1. Transfer or rename the legacy repository into `useorgx` when GitHub permits it.
2. If transfer is not available, archive the legacy repository and replace its README with a redirect to `https://github.com/useorgx/orgx-mcp`.
3. Set the legacy repository homepage to `https://github.com/useorgx/orgx-mcp`.
4. Remove stale legacy links from registry submissions, marketplace profiles, docs, and launch collateral.
5. Verify `gh repo view useorgx/orgx-mcp --json homepageUrl,url,repositoryTopics` after the update.

`OrgX-ai/orgx-mcp` did not resolve through GitHub during the 2026-04-12 Phase 0 verification, so the repo-level redirect could not be applied from this repository.

## Verification

Run these checks before merging canonical presence changes:

```bash
rg -n "github\\.com/(OrgX-ai|orgx-ai)/|https?://([^/]+\\.)?orgx\\.ai" README.md docs server.json glama.json package.json
pnpm directory:preflight
```

The first command should return no matches. Mentions of legacy org names inside this playbook are allowed only when documenting redirect handling.
