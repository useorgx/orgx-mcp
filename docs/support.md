# OrgX MCP Support

## Primary support channel

- GitHub Issues: <https://github.com/useorgx/orgx-mcp/issues>

Use GitHub Issues for:

- connector setup problems,
- OAuth callback or discovery issues,
- widget rendering regressions,
- tool contract bugs,
- documentation gaps.

## What to include in a support request

- the MCP client and version,
- the exact tool or endpoint involved,
- the error text or failing behavior,
- reproduction steps,
- whether the problem occurs in local development, production, or both.

Do not include:

- access tokens,
- refresh tokens,
- cookies,
- raw service keys,
- private reviewer credentials.

## Reviewer access

Reviewer credentials and sample workspaces are provisioned outside the repository and should be shared through a secure submission channel.

## Severity guidance

- Functional outage: open an issue with exact failing endpoint/tool and reproduction steps.
- Security-sensitive issue: do not post secrets publicly; use the secure review channel established for the submission or coordinated maintainer contact.
