// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import "../public/widgets/shared/widget-runtime.js";
import {
  detectProtocol,
  extractStructuredWidgetData,
  McpAppsSDKBridge,
} from "../public/widgets/shared/utils.js";

describe("official MCP Apps widget bridge", () => {
  afterEach(() => {
    (window as unknown as { OrgXWidgetRuntime: { __resetForTests(): void } })
      .OrgXWidgetRuntime.__resetForTests();
    delete (window as unknown as { McpApps?: unknown }).McpApps;
  });

  it("connects once, applies host styles, and calls official SDK methods", async () => {
    let app: {
      connect: ReturnType<typeof vi.fn>;
      getHostContext: ReturnType<typeof vi.fn>;
      callServerTool: ReturnType<typeof vi.fn>;
      openLink: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      ontoolresult?: (result: unknown) => void;
      onhostcontextchanged?: (context: Record<string, unknown>) => void;
    } | null = null;
    const applyHostStyleVariables = vi.fn();
    const applyHostFonts = vi.fn();
    const applyDocumentTheme = vi.fn();

    class FakeApp {
      connect = vi.fn().mockResolvedValue(undefined);
      getHostContext = vi.fn().mockReturnValue({
        theme: "dark",
        styles: {
          variables: { "--color-background-primary": "#111" },
          css: { fonts: "@font-face { font-family: Host; }" },
        },
      });
      callServerTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"approved":true}' }],
      });
      openLink = vi.fn().mockResolvedValue(undefined);
      close = vi.fn();
      ontoolresult?: (result: unknown) => void;
      onhostcontextchanged?: (context: Record<string, unknown>) => void;

      constructor() {
        app = this;
      }
    }

    (window as unknown as { McpApps: unknown }).McpApps = {
      App: FakeApp,
      applyHostStyleVariables,
      applyHostFonts,
      applyDocumentTheme,
    };

    const bridge = new McpAppsSDKBridge();
    const firstConnect = bridge.connect();
    const secondConnect = bridge.connect();
    expect(secondConnect).toBe(firstConnect);
    await firstConnect;

    expect(app).not.toBeNull();
    expect(app!.connect).toHaveBeenCalledTimes(1);
    expect(app!.getHostContext).toHaveBeenCalledTimes(1);
    expect(applyHostStyleVariables).toHaveBeenCalledWith({
      "--color-background-primary": "#111",
    });
    expect(applyHostFonts).toHaveBeenCalledWith(
      "@font-face { font-family: Host; }"
    );
    expect(applyDocumentTheme).toHaveBeenCalledWith("dark");

    app!.onhostcontextchanged?.({ theme: "light" });
    expect(applyDocumentTheme).toHaveBeenLastCalledWith("light");

    await expect(
      bridge.callServerTool({
        name: "approve_decision",
        arguments: { id: "d1" },
      })
    ).resolves.toEqual({ approved: true });
    expect(app!.callServerTool).toHaveBeenCalledWith({
      name: "approve_decision",
      arguments: { id: "d1" },
    });

    await bridge.openLink("https://useorgx.com/live");
    expect(app!.openLink).toHaveBeenCalledWith({
      url: "https://useorgx.com/live",
    });
  });

  it("uses the same structured-data extraction for pushed and called results", () => {
    expect(
      extractStructuredWidgetData({ structuredContent: { status: "ready" } })
    ).toEqual({ status: "ready" });
    expect(
      extractStructuredWidgetData({
        content: [{ type: "text", text: '{"status":"blocked"}' }],
      })
    ).toEqual({ status: "blocked" });
    expect(
      extractStructuredWidgetData(
        { content: [{ type: "text", text: "Human result" }] },
        true
      )
    ).toEqual({ text: "Human result" });
  });

  it("keeps standalone previews standalone when the SDK bundle is loaded", () => {
    (window as unknown as { McpApps: unknown }).McpApps = {
      App: class FakeApp {},
    };
    expect(window.parent).toBe(window);
    expect(detectProtocol()).toBe("standalone");
  });
});
