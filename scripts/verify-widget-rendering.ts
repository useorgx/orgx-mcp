import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

import {
  chromium,
  type ConsoleMessage,
  type Frame,
  type Page,
} from "playwright";

import { WIDGET_RESOURCES } from "../src/toolDefinitions";
import {
  MCP_APPS_SHARED_COMPONENT_PATHS,
  parseWidgetResourceUri,
  rewriteWidgetHtmlAssetUrls,
  sanitizeMcpAppsHtml,
} from "../src/widgetConfig";

const publicDir = resolve(process.cwd(), "public");
const widgetDir = resolve(publicDir, "widgets");
const testOrigin = "http://orgx-widget.test";

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const sharedComponents = Object.fromEntries(
  MCP_APPS_SHARED_COMPONENT_PATHS.map((path) => [
    path,
    readFileSync(resolve(widgetDir, path), "utf8"),
  ]),
);
const interactionKitCss = readFileSync(
  resolve(widgetDir, "shared/interaction-kit.css"),
  "utf8",
);
const interactionKitJs = readFileSync(
  resolve(widgetDir, "shared/interaction-kit.js"),
  "utf8",
);

type RuntimeVariant = "standalone-demo" | "claude-mcp-error" | "chatgpt-error";

const errorSurfaceWidgets = new Set([
  "artifact-review-widget",
  "decisions-widget",
  "initiative-pulse-widget",
  "plan-session-live-widget",
  "search-results-widget",
]);

interface CheckResult {
  widget: string;
  variant: RuntimeVariant;
  width: number;
  visibleCharacters: number;
  errors: string[];
}

function mimeType(path: string) {
  return mimeTypes[extname(path).toLowerCase()] || "application/octet-stream";
}

function resourceHtml(widgetFile: string) {
  const source = readFileSync(resolve(widgetDir, widgetFile), "utf8");
  const rewritten = rewriteWidgetHtmlAssetUrls(
    source,
    `${testOrigin}/widgets/`,
  );
  return sanitizeMcpAppsHtml(rewritten, {
    interactionKitCss,
    interactionKitJs,
    sharedComponents,
  });
}

function hostErrorPayload(widget: string) {
  return {
    ok: false,
    isError: true,
    status: "error",
    error: {
      message: `Structured host error for ${widget}`,
      code: "host_error_fixture",
    },
  };
}

function claudeHostHtml(widgetFile: string, payload: unknown) {
  const iframeUrl = `${testOrigin}/widgets/${widgetFile}?resource=true&theme=dark`;
  return `<!doctype html>
    <html data-theme="dark"><body style="margin:0;background:#05070d">
      <iframe id="widget" title="OrgX widget" src="${iframeUrl}" style="display:block;width:100%;height:900px;border:0"></iframe>
      <script>
        const iframe = document.getElementById('widget');
        const toolResult = ${JSON.stringify({
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: true,
        })};
        window.addEventListener('message', (event) => {
          if (event.source !== iframe.contentWindow || !event.data || event.data.jsonrpc !== '2.0') return;
          const message = event.data;
          if (message.method === 'ui/initialize' && message.id !== undefined) {
            iframe.contentWindow.postMessage({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: '2026-01-26',
                hostInfo: { name: 'Claude Desktop verification host', version: '1.26832.0' },
                hostCapabilities: { openLinks: {}, serverTools: {} },
                hostContext: {
                  theme: 'dark',
                  platform: 'desktop',
                  userAgent: 'Claude Desktop widget verification',
                  containerDimensions: { width: window.innerWidth, maxHeight: 900 },
                },
              },
            }, '*');
            return;
          }
          if (message.method === 'ui/notifications/initialized') {
            iframe.contentWindow.postMessage({
              jsonrpc: '2.0',
              method: 'ui/notifications/tool-result',
              params: toolResult,
            }, '*');
            return;
          }
          if (message.id !== undefined) {
            iframe.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
          }
        });
      <\/script>
    </body></html>`;
}

async function installAssetRouter(
  page: Page,
  resourceBodies: Map<string, string>,
) {
  await page.route(`${testOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const resourceBody = resourceBodies.get(relativePath);
    if (url.searchParams.get("resource") === "true" && resourceBody) {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: resourceBody,
      });
      return;
    }

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

async function checkWidget(
  page: Page,
  widget: string,
  widgetFile: string,
  variant: RuntimeVariant,
  width: number,
  resourceBodies: Map<string, string>,
): Promise<CheckResult> {
  const errors: string[] = [];
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  };
  const onPageError = (error: Error) => errors.push(`page: ${error.message}`);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  await page.setViewportSize({ width, height: 900 });
  const payload = hostErrorPayload(widget);
  if (variant === "chatgpt-error") {
    await page.addInitScript({
      content: `window.openai = {
        theme: 'dark',
        toolOutput: ${JSON.stringify(payload)},
        setWidgetHeight() {},
        callTool: async () => ({ structuredContent: null }),
        openExternal() {},
        sendFollowUpMessage() {},
        requestDisplayMode: async () => ({ mode: 'inline' }),
      };`,
    });
  }

  const params = new URLSearchParams();
  if (variant === "standalone-demo") params.set("demo", "true");
  if (variant === "chatgpt-error") params.set("resource", "true");
  params.set("theme", "dark");
  const pageUrl =
    variant === "claude-mcp-error"
      ? `${testOrigin}/claude-host.html`
      : `${testOrigin}/widgets/${widgetFile}?${params.toString()}`;
  if (variant === "claude-mcp-error") {
    await page.route(pageUrl, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: claudeHostHtml(widgetFile, payload),
      }),
    );
  }
  const response = await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  if (!response || response.status() !== 200) {
    errors.push(`http: ${response?.status() ?? "no response"}`);
  }
  let target: Page | Frame = page;
  if (variant === "claude-mcp-error") {
    try {
      await page.waitForFunction(
        () => {
          const iframe = document.querySelector("iframe");
          return (
            iframe &&
            iframe.contentDocument?.documentElement?.dataset.protocol ===
              "mcp-apps-sdk"
          );
        },
        undefined,
        { timeout: 5000 },
      );
    } catch {
      errors.push("runtime: Claude MCP Apps iframe did not initialize");
    }
    target = page.frames().find((frame) => frame !== page.mainFrame()) || page;
  }
  await page.waitForTimeout(750);

  const diagnostics = await target.evaluate(() => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    const visible: string[] = [];
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (parent?.closest("script, style")) continue;
      visible.push(walker.currentNode.textContent || "");
    }
    const visibleText = visible.join(" ").replace(/\s+/g, " ").trim();
    return {
      visibleText,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      protocol: document.documentElement.getAttribute("data-protocol"),
      smallTargets: Array.from(
        document.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [role="button"]',
        ),
      )
        .filter((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            label:
              element.getAttribute("aria-label") ||
              element.textContent?.trim().slice(0, 60) ||
              element.tagName,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        })
        .filter((control) => control.width < 44 || control.height < 44),
    };
  });

  if (!diagnostics.visibleText) errors.push("render: no visible text");
  if (
    diagnostics.visibleText.includes(
      "Cannot specify both `message` and `error` params",
    )
  ) {
    errors.push("render: MCP SDK source leaked into visible content");
  }
  for (const token of ["[object Object]", "undefined", "NaN"]) {
    if (diagnostics.visibleText.includes(token))
      errors.push(`render: leaked ${token}`);
  }
  if (diagnostics.overflow > 1) {
    errors.push(`layout: ${diagnostics.overflow}px horizontal overflow`);
  }
  if (diagnostics.smallTargets.length) {
    errors.push(
      `interaction: undersized targets ${JSON.stringify(diagnostics.smallTargets)}`,
    );
  }
  if (variant === "chatgpt-error" && diagnostics.protocol !== "chatgpt") {
    errors.push(`runtime: expected chatgpt, received ${diagnostics.protocol}`);
  }
  if (
    variant === "claude-mcp-error" &&
    diagnostics.protocol !== "mcp-apps-sdk"
  ) {
    errors.push(
      `runtime: expected mcp-apps-sdk, received ${diagnostics.protocol}`,
    );
  }
  if (
    variant !== "standalone-demo" &&
    errorSurfaceWidgets.has(widget) &&
    !diagnostics.visibleText.includes(`Structured host error for ${widget}`)
  ) {
    errors.push("render: structured host error message was not shown");
  }

  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  return {
    widget,
    variant,
    width,
    visibleCharacters: diagnostics.visibleText.length,
    errors,
  };
}

async function main() {
  const resourceBodies = new Map<string, string>();
  const resources = WIDGET_RESOURCES.map((resource) => {
    const { widgetFile } = parseWidgetResourceUri(resource.uri);
    resourceBodies.set(`widgets/${widgetFile}`, resourceHtml(widgetFile));
    return { widget: resource.name, widgetFile };
  }).filter(
    (resource) =>
      !process.env.WIDGET_FILTER ||
      resource.widget.includes(process.env.WIDGET_FILTER),
  );

  const browser = await chromium.launch({ headless: true });
  const results: CheckResult[] = [];
  try {
    for (const width of [1280, 375]) {
      for (const variant of [
        "standalone-demo",
        "claude-mcp-error",
        "chatgpt-error",
      ] as const) {
        if (
          process.env.VARIANT_FILTER &&
          !variant.includes(process.env.VARIANT_FILTER)
        )
          continue;
        for (const resource of resources) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            colorScheme: "dark",
          });
          const page = await context.newPage();
          await installAssetRouter(page, resourceBodies);
          results.push(
            await checkWidget(
              page,
              resource.widget,
              resource.widgetFile,
              variant,
              width,
              resourceBodies,
            ),
          );
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  const failures = results.filter((result) => result.errors.length > 0);
  for (const result of results) {
    const status = result.errors.length ? "✗" : "✓";
    console.log(
      `${status} ${result.widget} ${result.variant} ${result.width}px (${result.visibleCharacters} visible chars)${
        result.errors.length ? ` — ${result.errors.join("; ")}` : ""
      }`,
    );
  }
  console.log(
    `\n${results.length - failures.length}/${results.length} widget render checks passed.`,
  );
  if (failures.length) process.exitCode = 1;
}

void main();
