import { readFileSync, mkdirSync } from "node:fs";
import { extname, resolve } from "node:path";

import { chromium } from "playwright";

const root = process.cwd();
const publicDir = resolve(root, "public");
const widgetDir = resolve(publicDir, "widgets");
const manifest = JSON.parse(
  readFileSync(resolve(widgetDir, "_manifest.json"), "utf8"),
);
const outputDir =
  process.env.WIDGET_THEME_EVIDENCE_DIR ||
  resolve(root, "artifacts", "widget-theme-audit");
const testOrigin = "http://orgx-widget-theme.test";
const requestedWidgets = (process.env.WIDGET_THEME_WIDGETS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const requestedThemes = (process.env.WIDGET_THEME_THEMES || "light,dark")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const themes = ["light", "dark"].filter((theme) =>
  requestedThemes.includes(theme),
);
const requestedViewports = (
  process.env.WIDGET_THEME_VIEWPORTS || "desktop,tablet,phone,zoom-200"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "tablet", width: 768, height: 960 },
  { name: "phone", width: 375, height: 812 },
  { name: "zoom-200", width: 768, height: 960, zoom: 2 },
].filter((viewport) => requestedViewports.includes(viewport.name));
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function mimeType(path) {
  return mimeTypes[extname(path).toLowerCase()] || "application/octet-stream";
}

function channel(value) {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(color) {
  return (
    0.2126 * channel(color[0]) +
    0.7152 * channel(color[1]) +
    0.0722 * channel(color[2])
  );
}

function contrast(left, right) {
  const first = luminance(left);
  const second = luminance(right);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function parseColor(value) {
  const input = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(input)) {
    return [
      Number.parseInt(input.slice(1, 3), 16),
      Number.parseInt(input.slice(3, 5), 16),
      Number.parseInt(input.slice(5, 7), 16),
    ];
  }
  const match = input.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (match) return match.slice(1, 4).map(Number);
  return null;
}

function parseRgbTriplet(value) {
  const values = value.split(",").map((part) => Number(part.trim()));
  return values.length === 3 && values.every(Number.isFinite) ? values : null;
}

async function routeAssets(page) {
  await page.route(`${testOrigin}/**`, async (route) => {
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
        contentType: mimeType(filePath),
        body: readFileSync(filePath),
      });
    } catch {
      await route.fulfill({ status: 404, body: "Not found" });
    }
  });
}

async function auditCase(browser, widget, file, theme, viewport) {
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

  const params = new URLSearchParams({
    demo: "true",
    theme,
    audit: "true",
  });
  const response = await page.goto(
    `${testOrigin}/widgets/${file}?${params.toString()}`,
    { waitUntil: "domcontentloaded" },
  );
  if (!response || response.status() !== 200) {
    errors.push(`http: ${response?.status() ?? "no response"}`);
  }
  await page.waitForTimeout(1200);
  if (viewport.zoom) {
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = String(zoom);
    }, viewport.zoom);
    await page.waitForTimeout(100);
  }

  const diagnostics = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    const visibleText = document.body.innerText.replace(/\s+/g, " ").trim();
    const smallTargets = [];
    const lowContrastText = [];

    const parseRgba = (value) => {
      const match = value.match(
        /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/,
      );
      return match
        ? [
            Number(match[1]),
            Number(match[2]),
            Number(match[3]),
            match[4] === undefined ? 1 : Number(match[4]),
          ]
        : null;
    };
    const blend = (foreground, background) => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3]);
      if (!alpha) return [0, 0, 0, 0];
      return [
        (foreground[0] * foreground[3] +
          background[0] * background[3] * (1 - foreground[3])) /
          alpha,
        (foreground[1] * foreground[3] +
          background[1] * background[3] * (1 - foreground[3])) /
          alpha,
        (foreground[2] * foreground[3] +
          background[2] * background[3] * (1 - foreground[3])) /
          alpha,
        alpha,
      ];
    };
    const channel = (value) => {
      const normalized = value / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color) =>
      0.2126 * channel(color[0]) +
      0.7152 * channel(color[1]) +
      0.0722 * channel(color[2]);
    const contrastRatio = (left, right) => {
      const first = luminance(left);
      const second = luminance(right);
      return (
        (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
      );
    };
    const effectiveBackground = (element) => {
      const layers = [];
      let hasImage = false;
      for (let current = element; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.backgroundImage !== "none") hasImage = true;
        const color = parseRgba(style.backgroundColor);
        if (color && color[3] > 0) {
          layers.push(color);
          if (color[3] === 1) break;
        }
      }
      let background =
        rootStyle.colorScheme === "dark" ? [2, 4, 10, 1] : [248, 250, 252, 1];
      for (const color of layers.reverse()) {
        background = blend(color, background);
      }
      return { color: background, hasImage };
    };

    for (const element of document.querySelectorAll(
      'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])',
    )) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        rect.width === 0 ||
        rect.height === 0
      ) {
        continue;
      }
      if (rect.width < 44 || rect.height < 44) {
        smallTargets.push({
          tag: element.tagName.toLowerCase(),
          label:
            element.getAttribute("aria-label") ||
            element.textContent?.replace(/\s+/g, " ").trim().slice(0, 50) ||
            "(unlabelled)",
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }

    for (const element of document.body.querySelectorAll("*")) {
      if (
        ["SCRIPT", "STYLE", "NOSCRIPT", "SVG"].includes(element.tagName) ||
        element.closest(
          '[aria-hidden="true"], [hidden], :disabled, [aria-disabled="true"]',
        ) ||
        !Array.from(element.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
        )
      ) {
        continue;
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0 ||
        rect.width === 0 ||
        rect.height === 0
      ) {
        continue;
      }
      const text = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length < 2) continue;
      const foreground = parseRgba(style.color);
      const background = effectiveBackground(element);
      if (!foreground || !background.color || background.hasImage) continue;
      let opacity = 1;
      for (let current = element; current; current = current.parentElement) {
        opacity *= Number(getComputedStyle(current).opacity) || 0;
      }
      if (opacity <= 0.05) continue;
      foreground[3] *= opacity;
      const paintedForeground = blend(foreground, background.color);
      const ratio = contrastRatio(paintedForeground, background.color);
      const fontSize = Number.parseFloat(style.fontSize);
      const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
      const threshold =
        fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700) ? 3 : 4.5;
      if (ratio + 0.02 < threshold) {
        lowContrastText.push({
          text: text.slice(0, 60),
          ratio: Number(ratio.toFixed(2)),
          threshold,
          selector: element.id
            ? `#${element.id}`
            : `${element.tagName.toLowerCase()}.${Array.from(element.classList)
                .slice(0, 2)
                .join(".")}`,
        });
      }
    }
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      themeSource:
        document.documentElement.getAttribute("data-theme-source") ||
        "document",
      colorScheme: rootStyle.colorScheme,
      visibleCharacters: visibleText.length,
      overflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      bodyBackground: bodyStyle.backgroundColor,
      tokens: {
        panel: rootStyle.getPropertyValue("--ox-panel-solid"),
        text: rootStyle.getPropertyValue("--ox-text"),
        muted: rootStyle.getPropertyValue("--ox-text-muted"),
        dim: rootStyle.getPropertyValue("--ox-text-dim"),
        primary: rootStyle.getPropertyValue("--ox-primary"),
        primaryRgb: rootStyle.getPropertyValue("--ox-primary-rgb"),
        primaryFillRgb: rootStyle.getPropertyValue("--ox-primary-fill-rgb"),
        primaryContrast: rootStyle.getPropertyValue("--ox-primary-contrast"),
      },
      smallTargets,
      lowContrastText: lowContrastText.slice(0, 20),
    };
  });

  if (diagnostics.theme !== theme) {
    errors.push(`theme: expected ${theme}, received ${diagnostics.theme}`);
  }
  if (diagnostics.colorScheme !== theme) {
    errors.push(
      `color-scheme: expected ${theme}, received ${diagnostics.colorScheme}`,
    );
  }
  if (!diagnostics.visibleCharacters) errors.push("render: no visible text");
  if (diagnostics.overflow > 1) {
    errors.push(`layout: ${diagnostics.overflow}px horizontal overflow`);
  }
  if (diagnostics.lowContrastText.length) {
    const example = diagnostics.lowContrastText[0];
    errors.push(
      `rendered text contrast: ${diagnostics.lowContrastText.length} sampled failures; ` +
        `"${example.text}" ${example.ratio}:1`,
    );
  }

  const panel = parseColor(diagnostics.tokens.panel);
  const text = parseColor(diagnostics.tokens.text);
  const muted = parseColor(diagnostics.tokens.muted);
  const dim = parseColor(diagnostics.tokens.dim);
  const primary = parseColor(diagnostics.tokens.primary);
  const primaryFill = parseRgbTriplet(diagnostics.tokens.primaryFillRgb);
  const primaryContrast = parseColor(diagnostics.tokens.primaryContrast);
  const ratios = {
    text: panel && text ? contrast(text, panel) : 0,
    muted: panel && muted ? contrast(muted, panel) : 0,
    dim: panel && dim ? contrast(dim, panel) : 0,
    primary: panel && primary ? contrast(primary, panel) : 0,
    primaryAction:
      primaryFill && primaryContrast
        ? contrast(primaryFill, primaryContrast)
        : 0,
  };
  for (const [name, ratio] of Object.entries(ratios)) {
    if (ratio < 4.5) {
      errors.push(`contrast: ${name} ${ratio.toFixed(2)}:1`);
    }
  }

  if (
    (viewport.name === "desktop" || viewport.name === "phone") &&
    diagnostics.visibleCharacters
  ) {
    const targetDir = resolve(outputDir, theme, viewport.name);
    mkdirSync(targetDir, { recursive: true });
    await page.screenshot({
      path: resolve(targetDir, `${widget}.png`),
      fullPage: true,
    });
  }

  await context.close();
  return {
    widget,
    theme,
    viewport: viewport.name,
    width: viewport.width,
    visibleCharacters: diagnostics.visibleCharacters,
    themeSource: diagnostics.themeSource,
    ratios: Object.fromEntries(
      Object.entries(ratios).map(([name, ratio]) => [
        name,
        Number(ratio.toFixed(2)),
      ]),
    ),
    smallTargets: diagnostics.smallTargets,
    lowContrastText: diagnostics.lowContrastText,
    errors,
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const [widget, entry] of Object.entries(manifest.widgets)) {
      if (requestedWidgets.length && !requestedWidgets.includes(widget)) {
        continue;
      }
      const file = entry.file.replace(/^public\/widgets\//, "");
      for (const theme of themes) {
        for (const viewport of viewports) {
          results.push(await auditCase(browser, widget, file, theme, viewport));
        }
      }
    }
  } finally {
    await browser.close();
  }

  const failures = results.filter((result) => result.errors.length);
  const smallTargetCases = results.filter(
    (result) => result.smallTargets.length,
  );
  for (const result of results) {
    const status = result.errors.length ? "✗" : "✓";
    console.log(
      `${status} ${result.widget} ${result.theme} ${result.viewport} ` +
        `contrast=${Object.values(result.ratios).join("/")} ` +
        `targets<44=${result.smallTargets.length}` +
        (result.errors.length ? ` — ${result.errors.join("; ")}` : ""),
    );
  }
  console.log(
    `\n${results.length - failures.length}/${results.length} theme render cases passed.`,
  );
  console.log(
    `${smallTargetCases.length}/${results.length} cases contain a visible target below 44px.`,
  );
  for (const result of results.filter(
    (entry) => entry.smallTargets.length,
  )) {
    console.log(
      `  ${result.widget} ${result.theme} ${result.viewport}: ${result.smallTargets
        .map(
          (target) =>
            `${target.tag} "${target.label}" ${target.width}x${target.height}`,
        )
        .join("; ")}`,
    );
  }
  for (const result of results.filter(
    (entry) =>
      entry.theme === "light" &&
      entry.viewport === "desktop" &&
      entry.lowContrastText.length,
  )) {
    console.log(
      `  ${result.widget} low contrast: ${result.lowContrastText
        .slice(0, 5)
        .map((entry) => `${entry.selector} "${entry.text}" ${entry.ratio}:1`)
        .join("; ")}`,
    );
  }
  console.log(`Evidence: ${outputDir}`);
  if (failures.length) process.exitCode = 1;
}

await main();
