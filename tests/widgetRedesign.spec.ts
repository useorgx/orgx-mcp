import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const widget = (name: string) =>
  readFileSync(
    resolve(process.cwd(), "public", "widgets", `${name}.html`),
    "utf8",
  );

describe("OrgX compact widget redesign", () => {
  it("composes artifact review as evidence beside consequence with recoverable actions", () => {
    const html = widget("artifact-review");
    expect(html).toContain('class="review-desk');
    expect(html).toContain("Does this evidence meet the bar to advance?");
    expect(html).toContain('aria-controls="artifact-change-composer"');
    expect(html).toContain("Recording approval and advancing the artifact");
    expect(html).toContain("Your note is preserved; try again.");
    expect(html).toContain("event.key !== 'Escape'");
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toContain('role="tablist" aria-label="Artifact viewer"');
    expect(html).toContain('data-view-panel="evidence"');
    expect(html).toContain('data-view-panel="history"');
    expect(html).toContain("function resolveEvidence(artifact, reviewContract)");
    expect(html).toContain("Approval is blocked until required verification evidence clears.");
    expect(html).toContain("function resolveReviewerSignal(review)");
    expect(html).toContain("Auto-approved by policy");
    expect(html).toContain("function renderDiff(text)");
    expect(html).toContain("<video controls preload=");
    expect(html).toContain("https://useorgx.com/live/");
    expect(html).not.toContain('data-view-tab="raw"');
  });

  it("renders task spawn as a compact dispatch receipt and proof spine", () => {
    const html = widget("task-spawned");
    expect(html).toContain('class="dispatch-spine"');
    expect(html).toContain("Owner");
    expect(html).toContain("Execution surface");
    expect(html).toContain("Receipt");
    expect(html).toContain("The execution link remains the proof boundary.");
    expect(html).toContain("Execution complete");
  });

  it("compresses search into one leading match and quiet continuation rows", () => {
    const html = widget("search-results");
    expect(html).toContain(".result-card:first-child");
    expect(html).toContain("-webkit-line-clamp: 2");
    expect(html).toContain("Organizational memory is temporarily unavailable");
    expect(html).toContain("completed launch proof");
  });

  it("shows one consequential decision and progressively discloses evidence", () => {
    const html = widget("decisions");
    expect(html).toContain("var itemsPerPage = 1");
    expect(html).toContain('<details class="decision-evidence">');
    expect(html).toContain("Evidence and consequence");
    expect(html).toContain("data-reject-id=");
    expect(html).toContain("CSS.escape(decisionId)");
    expect(html).toContain("Decision queue unavailable");
  });

  it("turns the gallery into a searchable, stateful QA workbench", () => {
    const html = widget("index");
    expect(html).toContain('aria-label="Widget QA workbench"');
    expect(html).toContain('id="catalogSearch"');
    expect(html).toContain('id="stateSelect"');
    expect(html).toContain('id="previewTheme"');
    expect(html).toContain('id="viewportSelect"');
    expect(html).toContain("history.replaceState");
    expect(html).toContain("ArrowDown");
    expect(html).toContain('role="listbox"');
  });

  it("keeps every redesigned widget on a deterministic seven-state audit matrix", () => {
    const audit = readFileSync(
      resolve(process.cwd(), "scripts", "audit-widget-redesign.mjs"),
      "utf8",
    );
    for (const state of [
      "loading",
      "empty",
      "populated",
      "long",
      "error",
      "urgent",
      "resolved",
    ]) {
      expect(audit).toContain(`"${state}"`);
    }
    for (const viewport of ["desktop", "tablet", "phone"]) {
      expect(audit).toContain(`name: "${viewport}"`);
    }
  });
});
