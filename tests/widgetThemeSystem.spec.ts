import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const widgetRoot = join(__dirname, "..", "public", "widgets");
const themeCss = readFileSync(
  join(widgetRoot, "shared", "widget-theme.css"),
  "utf8",
);
const runtime = readFileSync(
  join(widgetRoot, "shared", "widget-runtime.js"),
  "utf8",
);
const interactionKit = readFileSync(
  join(widgetRoot, "shared", "interaction-kit.css"),
  "utf8",
);

const accents: Record<string, string> = {
  "agent-status.html": "lime",
  "artifact-review.html": "amber",
  "daily-brief.html": "iris",
  "decisions.html": "amber",
  "index.html": "neutral",
  "initiative-pulse.html": "teal",
  "morning-brief.html": "teal",
  "plan-session-live.html": "iris",
  "scaffold-streaming.html": "iris",
  "scaffolded-initiative.html": "iris",
  "search-results.html": "teal",
  "task-spawned.html": "iris",
};

describe("shared widget theme system", () => {
  const widgetFiles = readdirSync(widgetRoot)
    .filter((file) => file.endsWith(".html"))
    .sort();

  it("covers every public widget with one shared theme contract", () => {
    expect(widgetFiles).toEqual(Object.keys(accents).sort());

    for (const file of widgetFiles) {
      const html = readFileSync(join(widgetRoot, file), "utf8");
      expect(html, file).toContain(`data-accent="${accents[file]}"`);
      expect(html, file).toContain('href="shared/widget-theme.css"');
      expect(
        html.lastIndexOf('href="shared/widget-theme.css"'),
        `${file} must load the canonical theme after widget-specific CSS`,
      ).toBeGreaterThan(html.lastIndexOf("</style>"));
    }
  });

  it("defines explicit, automatic, semantic, and accessible theme tokens", () => {
    expect(themeCss).toMatch(/:root\[data-theme=["']light["']\]/);
    expect(themeCss).toContain("@media (prefers-color-scheme: dark)");
    expect(themeCss).toMatch(/:root\[data-theme=["']dark["']\]/);
    expect(themeCss).toContain("--ox-text-muted: #526078");
    expect(themeCss).toContain("--ox-text-muted: #aab4c4");
    expect(themeCss).toContain("--ox-placeholder");
    expect(themeCss).toContain("--ox-focus-ring");
    expect(themeCss).toContain("@media (forced-colors: active)");
  });

  it("uses accessible foregrounds while preserving canonical accent RGB", () => {
    expect(themeCss).toContain("--ox-primary: #4d7c0f");
    expect(themeCss).toContain("--ox-primary-rgb: 191, 255, 0");
    expect(themeCss).toContain("--ox-primary: #0f766e");
    expect(themeCss).toContain("--ox-primary-rgb: 0, 201, 167");
    expect(themeCss).toContain("--ox-primary: #4f46e5");
    expect(themeCss).toContain("--ox-primary-rgb: 99, 102, 241");
    expect(themeCss).toContain("--ox-primary: #a16207");
    expect(themeCss).toContain("--ox-primary-rgb: 251, 191, 36");
  });

  it("syncs URL, ChatGPT, MCP Apps, and system theme changes", () => {
    expect(runtime).toContain("get('theme')");
    expect(runtime).toContain("global.openai && global.openai.theme");
    expect(runtime).toContain("'openai:set_globals'");
    expect(runtime).toContain("applyTheme(context.theme, 'host')");
    expect(runtime).toContain("matchMedia('(prefers-color-scheme: dark)')");
    expect(runtime).toContain(
      "addEventListener('change', onColorSchemeChange)",
    );
  });

  it("keeps compact controls touch-safe without painting quiet-control glints", () => {
    expect(interactionKit).toMatch(
      /\.ox-action-btn--sm,[\s\S]*?min-height:\s*44px/,
    );
    expect(interactionKit).toMatch(
      /\.ox-icon-btn--sm\s*\{[\s\S]*?width:\s*44px/,
    );
    expect(interactionKit).toMatch(
      /\.ox-link-btn--quiet::before\s*\{[\s\S]*?display:\s*none/,
    );
  });
});
