import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type OperationHandler = (...args: unknown[]) => unknown;
export interface PrivateOperation {
  config: Record<string, unknown>;
  handler: OperationHandler;
}

/**
 * Reuse a compatibility implementation without publishing its router. Only
 * fixed operation adapters can reach these callbacks; they are never listed
 * or installed in the SDK's callable registry.
 */
export function capturePrivateOperations(
  server: McpServer,
  publicTools: ReadonlySet<string> | null,
  adapterIds: ReadonlySet<string>,
): { operations: Map<string, PrivateOperation>; finish(): void } {
  const target = server as unknown as {
    registerTool(name: string, config: Record<string, unknown>, handler: OperationHandler): unknown;
  };
  const original = target.registerTool;
  const operations = new Map<string, PrivateOperation>();
  target.registerTool = function (name, config, handler) {
    operations.set(name, { config, handler });
    if (adapterIds.has(name) || (publicTools && !publicTools.has(name))) {
      return { enable() {}, disable() {}, remove() {}, update() {} };
    }
    return original.call(target, name, config, handler);
  };
  return { operations, finish: () => { target.registerTool = original; } };
}

/** Never put capability tokens in model-visible text or structured content. */
export function separateOperationWidgetMeta(value: Record<string, unknown>): {
  data: Record<string, unknown>; meta: Record<string, unknown> | undefined;
} {
  const { _widget_meta: topMeta, ...top } = value;
  const rawData = top.data;
  const nested = rawData && typeof rawData === 'object' && !Array.isArray(rawData)
    ? rawData as Record<string, unknown> : null;
  const { _widget_meta: nestedMeta, ...cleanNested } = nested ?? {};
  const rawMeta = topMeta ?? nestedMeta;
  const tokens = rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
    ? rawMeta as Record<string, unknown> : null;
  return {
    data: { ...top, ...(nested ? { data: cleanNested } : {}) },
    meta: tokens ? { 'orgx/widgetApproval': tokens } : undefined,
  };
}
