# MCP Widget Handoff Proof Cards

## Purpose

OrgX widgets should make autonomous work feel inspectable, not decorative. When an MCP tool returns a widget, the UI should expose the same proof that exists in the tool result: artifacts, tasks, review state, summaries, and live links. The widget can make this easier to scan, but it must not hide or replace the raw result.

This contract supports the onboarding activation loop:

1. A user installs OrgX through the wizard.
2. OrgX creates or resumes meaningful work.
3. The user's configured AI surface receives an MCP widget with proof cards.
4. The user can review artifacts, open `/live`, and continue from the exact state in ChatGPT, Cursor, Codex, Claude, VS Code, Windsurf, or Zed.

## Payload Contract

Every widget payload that represents produced work should include:

```ts
type WidgetProofCard = {
  id: string | null;
  title: string;
  status: string;
  artifact_type: string | null;
  summary: string | null;
  created_at: string | null;
  created_by_name: string | null;
  primary_url: string | null;
  primary_label: string | null;
  task_url: string | null;
  live_url: string | null;
  needs_review: boolean;
};
```

Use `src/widgetArtifactProof.ts` as the source of truth. The helper emits:

- `proof_cards`: compact, stable cards for UI rendering.
- `recent_artifacts` or `artifacts_produced`: legacy-compatible artifact rows with links.
- `review_items`: proof cards or artifacts that need operator attention.
- `artifact_summary`: `total`, `approved`, `in_review`, and `needs_review` counts.
- `proof_handoff`: continuation prompts and live link metadata.
- `widget_state_contract`: loading, full, empty, error, and partial-state rules.

## Interaction Rules

Proof cards are not marketing cards. They are receipts.

- Show the artifact title, status, type, and one human-readable summary line.
- Prefer `primary_url`; fall back to `task_url`; then fall back to `live_url`.
- Mark `draft`, `review`, `in_review`, and `changes_requested` as reviewable.
- Preserve task links and live links even when an artifact link is unavailable.
- Keep the raw MCP tool result available below or alongside the widget in clients that support both.
- Never summarize away missing data. If a link, summary, or creator is absent, show the remaining proof and label the missing part as pending.

## Visual States

Loading:

- Render skeleton rows immediately.
- Keep the previous tool result visible until the new payload lands.
- Fade content in after hydration to avoid a flash between empty and complete states.

Full:

- Show proof cards first, then summary counts, then secondary activity.
- Use the existing domain avatars and domain dots from `widget-foundation.css`.
- Keep links visibly actionable without creating nested preview frames.

Empty:

- Say that no artifacts have landed yet.
- Route the user to create or run the next task, not to a generic dashboard.

Error:

- Keep the raw tool result visible.
- Show concise recovery copy.
- Preserve any available artifact, task, or live links.

Partial:

- Render available proof cards.
- Mark missing links or missing review metadata as pending.
- Avoid hiding the entire proof section because one artifact is incomplete.

## Surface Continuation

`proof_handoff.surface_prompts` must include prompts for:

- ChatGPT
- Cursor
- Codex
- Claude
- VS Code
- Windsurf
- Zed

Each prompt should tell the user to continue from the returned proof cards, cite the artifact or task link used, and inspect review items before proposing more work. The goal is a seamless jump from wizard setup to the user's configured AI tool without making the user infer what OrgX just did.

## CSP And Border Constraints

Widget CSP and border preferences are configured in `src/widgetConfig.ts`.

- Use the allowlisted resource and connect domains from `buildWidgetCsp`.
- Honor OpenAI and MCP Apps border preferences.
- Do not create a decorative frame around the main widget content.
- Keep proof cards inside the existing widget shell and panel system.

## Implementation Notes

Current consumers:

- `public/widgets/initiative-pulse.html` reads `proof_cards` and `recent_artifacts`.
- `public/widgets/morning-brief.html` reads `proof_cards`, `artifacts_produced`, and `review_items`.
- `public/widgets/agent-status.html` reads `proof_cards`, `artifacts`, and legacy output arrays.

The helpers are intentionally additive. Existing clients that only understand legacy artifact arrays continue to work, while newer surfaces can render `proof_cards` directly.
