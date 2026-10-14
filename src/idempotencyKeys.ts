/**
 * Required idempotency keys for public write operations.
 *
 * Every mutating operation on the default surface declares a required
 * `idempotency_key`. Agents retry after timeouts and lost responses; without a
 * key a retried create or dispatch can apply twice. With one, OrgX applies a
 * keyed write at most once and replays the original outcome.
 *
 * A missing key must come back as a structured, actionable validation error,
 * not as an opaque SDK schema failure and never as a silently derived key.
 * `installIdempotencyKeyGuard` lets a call whose only schema problem is the
 * missing key reach a guard that returns the typed `idempotency_key_required`
 * remedy. If the SDK's validation hook ever changes, the required zod field
 * still rejects the call, with the same explanation in the message.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { toolError } from './authHelpers';
import { IDEMPOTENCY_KEY_PLACEHOLDER } from './idempotencyKeySchema';
import { buildRemedy, typedRemedyDetails } from './remedyErrors';

export {
  IDEMPOTENCY_KEY_DESCRIPTION,
  IDEMPOTENCY_KEY_REQUIRED_MESSAGE,
  idempotencyKeySchema,
  receiptIdempotencyKeySchema,
} from './idempotencyKeySchema';

/** True when a registered input schema declares a required idempotency_key. */
export function requiresIdempotencyKey(inputSchema: unknown): boolean {
  if (!inputSchema || typeof inputSchema !== 'object') return false;
  const shape = inputSchema instanceof z.ZodObject
    ? inputSchema.shape as Record<string, unknown>
    : inputSchema as Record<string, unknown>;
  const field = shape.idempotency_key;
  return field instanceof z.ZodType && !field.isOptional();
}

export function isMissingIdempotencyKey(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return true;
  const value = (args as Record<string, unknown>).idempotency_key;
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/** The structured validation error returned for a write sent without a key. */
export function idempotencyKeyRequiredResult(toolId: string, args: Record<string, unknown> = {}): CallToolResult {
  const diagnostic = buildRemedy('idempotency_key_required', { toolId, args });
  return toolError(`${toolId} requires idempotency_key. ${diagnostic.remedy}`, {
    code: 'idempotency_key_required',
    status: 400,
    details: {
      ...typedRemedyDetails(diagnostic),
      field: 'idempotency_key',
    },
  });
}

type Handler = (...args: unknown[]) => unknown;
type RegisteredTool = { inputSchema?: unknown };
type GuardableServer = {
  registerTool: (name: string, config: Record<string, unknown>, handler: Handler) => unknown;
  validateToolInput?: (tool: RegisteredTool, args: unknown, toolName: string) => Promise<unknown>;
};

const guarded = new WeakSet<object>();

export type IdempotencyKeyGuardOptions = {
  /**
   * Authorization runs before the key check, so a caller without the grant
   * learns about the grant first. Return a result to stop the call.
   */
  authorize?: (toolName: string, args: Record<string, unknown>) => CallToolResult | null | Promise<CallToolResult | null>;
};

/**
 * Install on an McpServer before tools register. Tools whose input schema
 * requires `idempotency_key` get a guard that returns the typed remedy when the
 * key is missing; every other schema failure keeps the SDK's normal error.
 */
export function installIdempotencyKeyGuard(mcpServer: unknown, options: IdempotencyKeyGuardOptions = {}): void {
  const server = mcpServer as GuardableServer;
  if (!server || guarded.has(server as object)) return;
  guarded.add(server as object);
  const keyedTools = new Set<string>();

  const originalRegister = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => {
    if (!requiresIdempotencyKey(config?.inputSchema)) {
      keyedTools.delete(name);
      return originalRegister(name, config, handler);
    }
    keyedTools.add(name);
    const guardedHandler: Handler = async (...callArgs: unknown[]) => {
      const input = callArgs[0];
      if (isMissingIdempotencyKey(input)) {
        const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
        const blocked = await options.authorize?.(name, record);
        if (blocked) return blocked;
        return idempotencyKeyRequiredResult(name, record);
      }
      return handler(...callArgs);
    };
    return originalRegister(name, config, guardedHandler);
  };

  const originalValidate = server.validateToolInput?.bind(server);
  if (!originalValidate) return;
  server.validateToolInput = async (tool, args, toolName) => {
    if (!keyedTools.has(toolName) || !isMissingIdempotencyKey(args) || !args || typeof args !== 'object' || Array.isArray(args)) {
      return originalValidate(tool, args, toolName);
    }
    let parsed: unknown;
    try {
      parsed = await originalValidate(tool, { ...(args as Record<string, unknown>), idempotency_key: IDEMPOTENCY_KEY_PLACEHOLDER }, toolName);
    } catch {
      // Other fields are invalid too: report every issue the normal way.
      return originalValidate(tool, args, toolName);
    }
    if (!parsed || typeof parsed !== 'object') return parsed;
    const { idempotency_key: _placeholder, ...rest } = parsed as Record<string, unknown>;
    return rest;
  };
}
