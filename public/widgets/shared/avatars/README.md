# Agent avatars

Static renders for the seven OrgX agents in six forms, served to widgets and
plugins at `https://mcp.useorgx.com/widgets/shared/avatars/`.

`<agent>-<form>-<size>.webp`

- agent: `pace`, `eli`, `mark`, `sage`, `orion`, `dana`, `xandy`
- form: `base`, `strategic`, `proactive`, `working`, `asking`, `verifying`
- size: `48`, `96`, `192` (square, cropped for a round frame)

`<ox-avatar>` from `@useorgx/orgx-ui-kit` reads this folder by default and
uses the 2x file for high-density screens. Forms map to state: working is a
run in progress, asking needs the person, verifying is checking proof.
