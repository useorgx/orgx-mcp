import { mkdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

import { chromium } from "playwright";

const publicDir = resolve(process.cwd(), "public");
const origin = "http://orgx-widget-redesign.test";
const outputDir =
  process.env.WIDGET_REDESIGN_EVIDENCE_DIR ||
  resolve(process.cwd(), "artifacts", "widget-redesign-audit");
const requestedWidgets = (process.env.WIDGET_REDESIGN_WIDGETS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const widgets = [
  "artifact-review",
  "task-spawned",
  "search-results",
  "decisions",
].filter(
  (widget) => !requestedWidgets.length || requestedWidgets.includes(widget),
);
const requestedStates = (process.env.WIDGET_REDESIGN_STATES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const states = [
  "loading",
  "empty",
  "populated",
  "long",
  "error",
  "urgent",
  "resolved",
].filter((state) => !requestedStates.length || requestedStates.includes(state));
const requestedThemes = (process.env.WIDGET_REDESIGN_THEMES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const themes = ["light", "dark"].filter(
  (theme) => !requestedThemes.length || requestedThemes.includes(theme),
);
const requestedViewports = (process.env.WIDGET_REDESIGN_VIEWPORTS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "tablet", width: 768, height: 960 },
  { name: "phone", width: 375, height: 812 },
].filter(
  (viewport) =>
    !requestedViewports.length || requestedViewports.includes(viewport.name),
);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function routeAssets(page) {
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const filePath = resolve(publicDir, relativePath);
    if (!filePath.startsWith(`${publicDir}/`)) {
      await route.fulfill({ status: 403, body: "Forbidden" });
      return;
    }
    try {
      await route.fulfill({
        status: 200,
        contentType:
          mimeTypes[extname(filePath).toLowerCase()] ||
          "application/octet-stream",
        body: readFileSync(filePath),
      });
    } catch {
      await route.fulfill({ status: 404, body: "Not found" });
    }
  });
}

async function inspect(page, expectedTheme, state) {
  return page.evaluate(
    ({ theme, fixtureState }) => {
      const root = document.documentElement;
      const interactive = [
        ...document.querySelectorAll(
          'button, a[href], input, select, textarea, [role="button"]',
        ),
      ].filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      });
      const smallTargets = interactive
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            label:
              element.getAttribute("aria-label") ||
              element.textContent?.replace(/\s+/g, " ").trim().slice(0, 42) ||
              element.tagName,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        })
        .filter((target) => target.width < 44 || target.height < 44);
      const text = document.body.innerText.replace(/\s+/g, " ").trim();
      const hasSkeleton = Boolean(
        document.querySelector(
          ".skeleton-wrapper, .review-skeleton, .dispatch-skeleton, .decision-skeleton-card",
        ),
      );
      const visibleSkeleton = [...document.querySelectorAll(
        ".skeleton-wrapper, .review-skeleton, .dispatch-skeleton, .decision-skeleton-card",
      )].some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.opacity !== "0" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      return {
        theme: root.dataset.theme || null,
        colorScheme: getComputedStyle(root).colorScheme,
        overflow: root.scrollWidth - root.clientWidth,
        textLength: text.length,
        hasSkeleton,
        smallTargets,
        stateRendered:
          fixtureState === "loading"
            ? hasSkeleton && visibleSkeleton
            : text.length > 12 && !hasSkeleton,
        expectedTheme: theme,
      };
    },
    { theme: expectedTheme, fixtureState: state },
  );
}

async function auditWidgetCase(browser, widget, state, theme, viewport) {
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme === "light" ? "dark" : "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await routeAssets(page);
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(
    `${origin}/widgets/${widget}.html?state=${state}&theme=${theme}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForTimeout(state === "loading" ? 180 : 650);
  const diagnostics = await inspect(page, theme, state);
  if (diagnostics.theme !== theme) {
    errors.push(`theme expected ${theme}, received ${diagnostics.theme}`);
  }
  if (diagnostics.colorScheme !== theme) {
    errors.push(
      `color-scheme expected ${theme}, received ${diagnostics.colorScheme}`,
    );
  }
  if (diagnostics.overflow > 1) {
    errors.push(`${diagnostics.overflow}px horizontal overflow`);
  }
  if (!diagnostics.stateRendered) errors.push(`${state} state did not render`);
  if (diagnostics.smallTargets.length) {
    errors.push(
      `${diagnostics.smallTargets.length} targets below 44px: ${diagnostics.smallTargets
        .slice(0, 3)
        .map((target) => `${target.label} ${target.width}x${target.height}`)
        .join(", ")}`,
    );
  }
  if (
    widget === "artifact-review" &&
    ["populated", "urgent"].includes(state)
  ) {
    const evidenceTab = page.locator('[data-view-tab="evidence"]');
    const historyTab = page.locator('[data-view-tab="history"]');
    const previewTab = page.locator('[data-view-tab="preview"]');
    await evidenceTab.click();
    const evidenceText = await page
      .locator('[data-view-panel="evidence"]')
      .innerText();
    if (!/Verification (cleared|held)/.test(evidenceText)) {
      errors.push("artifact evidence view did not expose its verification verdict");
    }
    if (state === "urgent") {
      const approvalDisabled = await page
        .locator('[data-action="approve"]')
        .isDisabled();
      if (!approvalDisabled) {
        errors.push("held verification did not disable approval");
      }
    }
    if (
      ["desktop", "phone"].includes(viewport.name) &&
      ["populated", "urgent"].includes(state)
    ) {
      const targetDir = resolve(outputDir, theme, viewport.name, "viewer");
      mkdirSync(targetDir, { recursive: true });
      await page.screenshot({
        path: resolve(targetDir, `artifact-review-${state}-evidence.png`),
        fullPage: true,
      });
    }
    await historyTab.click();
    const historyText = await page
      .locator('[data-view-panel="history"]')
      .innerText();
    if (
      !historyText.includes("v3") ||
      !historyText.toLowerCase().includes("current")
    ) {
      errors.push(
        `artifact history view did not identify the current revision: ${JSON.stringify(
          historyText,
        )}`,
      );
    }
    if (
      ["desktop", "phone"].includes(viewport.name) &&
      state === "populated"
    ) {
      const targetDir = resolve(outputDir, theme, viewport.name, "viewer");
      mkdirSync(targetDir, { recursive: true });
      await page.screenshot({
        path: resolve(targetDir, "artifact-review-populated-history.png"),
        fullPage: true,
      });
    }
    await previewTab.focus();
    await previewTab.press("ArrowRight");
    if ((await evidenceTab.getAttribute("aria-selected")) !== "true") {
      errors.push("artifact viewer arrow-key navigation did not select evidence");
    }
    await previewTab.click();
  }
  if (
    ["desktop", "phone"].includes(viewport.name) &&
    ["loading", "populated", "error"].includes(state)
  ) {
    const targetDir = resolve(outputDir, theme, viewport.name, state);
    mkdirSync(targetDir, { recursive: true });
    await page.screenshot({
      path: resolve(targetDir, `${widget}.png`),
      fullPage: true,
    });
  }
  await context.close();
  return { widget, state, theme, viewport: viewport.name, errors };
}

async function auditGallery(browser, theme, viewport) {
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme === "light" ? "dark" : "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await routeAssets(page);
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  await page.goto(
    `${origin}/widgets/index.html?theme=${theme}&widget=artifact-review&state=populated&previewTheme=${theme}&viewport=${viewport.name}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForTimeout(900);
  const diagnostics = await inspect(page, theme, "populated");
  if (diagnostics.overflow > 1) {
    errors.push(`${diagnostics.overflow}px horizontal overflow`);
  }
  if (diagnostics.smallTargets.length) {
    errors.push(
      `${diagnostics.smallTargets.length} gallery targets below 44px`,
    );
  }
  const frameText = await page
    .locator("#previewFrame")
    .contentFrame()
    .locator("body")
    .innerText();
  if (!frameText.includes("Does this evidence meet the bar")) {
    errors.push("selected preview did not reach populated artifact state");
  }
  if (["desktop", "phone"].includes(viewport.name)) {
    const targetDir = resolve(outputDir, theme, viewport.name, "gallery");
    mkdirSync(targetDir, { recursive: true });
    await page.screenshot({
      path: resolve(targetDir, "index.png"),
      fullPage: true,
    });
  }
  await context.close();
  return {
    widget: "gallery",
    state: "populated",
    theme,
    viewport: viewport.name,
    errors,
  };
}

async function auditArtifactContractVariant(browser, theme, variant) {
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: 920, height: 840 },
    colorScheme: theme === "light" ? "dark" : "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await routeAssets(page);
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  await page.goto(
    `${origin}/widgets/artifact-review.html?state=populated&theme=${theme}&artifactKind=${variant}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForTimeout(280);
  if (variant === "diff") {
    if ((await page.locator(".diff-preview .is-add").count()) !== 1) {
      errors.push("diff renderer did not identify the added line");
    }
    if ((await page.locator(".diff-preview .is-remove").count()) !== 1) {
      errors.push("diff renderer did not identify the removed line");
    }
  } else if (variant === "structured") {
    const text = await page.locator(".structured-preview").innerText();
    if (
      !text.toLowerCase().includes("proof boundary") ||
      text.includes('{"owner"')
    ) {
      errors.push("structured renderer fell back to a JSON wall");
    }
  } else if (variant === "video") {
    if ((await page.locator("video[controls]").count()) !== 1) {
      errors.push("video renderer did not expose native controls");
    }
  } else {
    await page.locator('[data-view-tab="evidence"]').click();
    const evidenceText = await page
      .locator('[data-view-panel="evidence"]')
      .innerText();
    if (variant === "not-scored") {
      if (!evidenceText.includes("Not scored yet")) {
        errors.push("not-scored evidence did not stay neutral");
      }
      if (
        (await page.locator(".evidence-meter").getAttribute("aria-valuenow")) !==
          null ||
        (await page.locator(".evidence-meter__threshold").count()) !== 0
      ) {
        errors.push("not-scored evidence invented a score or threshold");
      }
    }
    if (
      variant === "policy-review" &&
      !evidenceText.includes("Auto-approved by policy")
    ) {
      errors.push("policy approval was presented as a human review");
    }
  }
  const diagnostics = await inspect(page, theme, "populated");
  if (diagnostics.overflow > 1) {
    errors.push(`${diagnostics.overflow}px horizontal overflow`);
  }
  if (diagnostics.smallTargets.length) {
    errors.push(
      `${diagnostics.smallTargets.length} variant targets below 44px`,
    );
  }
  await context.close();
  return {
    widget: `artifact-review-${variant}`,
    state: "populated",
    theme,
    viewport: "contract",
    errors,
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const theme of themes) {
      for (const viewport of viewports) {
        for (const widget of widgets) {
          for (const state of states) {
            results.push(
              await auditWidgetCase(
                browser,
                widget,
                state,
                theme,
                viewport,
              ),
            );
          }
        }
        results.push(await auditGallery(browser, theme, viewport));
      }
      if (
        !requestedWidgets.length ||
        requestedWidgets.includes("artifact-review")
      ) {
        for (const variant of [
          "diff",
          "structured",
          "video",
          "not-scored",
          "policy-review",
        ]) {
          results.push(
            await auditArtifactContractVariant(browser, theme, variant),
          );
        }
      }
    }
  } finally {
    await browser.close();
  }
  const failures = results.filter((result) => result.errors.length);
  for (const failure of failures) {
    console.error(
      `✗ ${failure.widget} ${failure.state} ${failure.theme} ${failure.viewport}: ${failure.errors.join("; ")}`,
    );
  }
  console.log(
    `${results.length - failures.length}/${results.length} redesign state cases passed.`,
  );
  console.log(`Evidence: ${outputDir}`);
  if (failures.length) process.exitCode = 1;
}

await main();
