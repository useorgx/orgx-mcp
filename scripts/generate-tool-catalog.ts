/**
 * generate-tool-catalog.ts (canonical orgx-mcp)
 *
 * Source-of-truth generator for the STRUCTURAL tool catalog. Reads the tool
 * definitions that live in this repo (toolDefinitions / flywheelTools /
 * toolProfiles / contractTools) and emits dist/tool-catalog.json — the
 * machine-readable surface (id, schema, scopes, profiles, read-only) that the
 * orgx monorepo consumes instead of vendoring this worker's source.
 *
 * Scope: the STATIC tool-definition arrays only. The inline-registered orgx_*
 * core tools (defined programmatically in index.ts) are NOT yet exported as
 * data, so they remain curated downstream for now — tracked follow-up. The
 * monorepo's docs generator layers presentation metadata (categories, response
 * examples) on top of this structural catalog.
 *
 * Run: pnpm catalog:generate
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import {
  CHATGPT_TOOL_DEFINITIONS,
  PLAN_SESSION_TOOLS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  STREAM_TOOL_DEFINITIONS,
} from '../src/toolDefinitions';
import { FLYWHEEL_TOOL_DEFINITIONS } from '../src/flywheelTools';
import { TOOL_PROFILES } from '../src/toolProfiles';
import {
  CONTRACT_TOOL_DEFINITIONS,
  V2_ORGX_TOOL_ID_SET,
} from '../src/contractTools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

type ToolSource =
  | 'chatgpt'
  | 'plan_session'
  | 'client_integration'
  | 'stream'
  | 'flywheel'
  | 'contract';

interface CatalogTool {
  id: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  securityScopes: string[];
  readOnly: boolean;
  source: ToolSource;
  profiles: string[];
}

// ---------------------------------------------------------------------------
// Structural extraction (mirrors the monorepo generator's source-derived path)
// ---------------------------------------------------------------------------

function extractScopes(securitySchemes: unknown): string[] {
  if (!Array.isArray(securitySchemes)) return [];
  const scopes: string[] = [];
  for (const scheme of securitySchemes) {
    if (
      scheme &&
      typeof scheme === 'object' &&
      'scopes' in scheme &&
      Array.isArray((scheme as { scopes: unknown }).scopes)
    ) {
      scopes.push(...((scheme as { scopes: string[] }).scopes));
    }
  }
  return scopes;
}

function isReadOnly(meta: unknown, annotations?: unknown): boolean {
  if (
    annotations &&
    typeof annotations === 'object' &&
    'readOnlyHint' in annotations
  ) {
    return (annotations as Record<string, unknown>).readOnlyHint === true;
  }
  if (meta && typeof meta === 'object' && 'openai/readOnlyHint' in meta) {
    return (meta as Record<string, unknown>)['openai/readOnlyHint'] === true;
  }
  return false;
}

function safeZodToJsonSchema(schema: unknown): Record<string, unknown> {
  try {
    if (schema instanceof z.ZodType) {
      return zodToJsonSchema(schema) as Record<string, unknown>;
    }
    // Object-style shapes, e.g. { param: z.string() }
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
      const wrapped = z.object(schema as z.ZodRawShape);
      return zodToJsonSchema(wrapped) as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function profilesForTool(toolId: string): string[] {
  const profiles: string[] = [];
  for (const [name, profile] of Object.entries(TOOL_PROFILES)) {
    if (name === 'full') continue;
    const tools = (profile as { tools: string[] | null }).tools;
    if (tools === null || tools.includes(toolId)) profiles.push(name);
  }
  return profiles;
}

function processToolDef(
  def: {
    id: string;
    title?: string;
    description?: string;
    inputSchema?: unknown;
    securitySchemes?: unknown;
    _meta?: unknown;
    annotations?: unknown;
  },
  source: ToolSource,
): CatalogTool {
  return {
    id: def.id,
    title: def.title ?? def.id,
    description: def.description ?? '',
    inputSchema: safeZodToJsonSchema(def.inputSchema),
    securityScopes: extractScopes(def.securitySchemes),
    readOnly: isReadOnly(def._meta, def.annotations),
    source,
    profiles: profilesForTool(def.id),
  };
}

function computeSourceHash(): string {
  const files = [
    'src/toolDefinitions.ts',
    'src/flywheelTools.ts',
    'src/toolProfiles.ts',
    'src/contractTools.ts',
  ];
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(readFileSync(path.join(rootDir, file), 'utf-8'));
  }
  return hash.digest('hex').slice(0, 16);
}

function main(): void {
  const tools: CatalogTool[] = [];
  const seen = new Set<string>();

  function addTool(tool: CatalogTool): void {
    if (seen.has(tool.id)) {
      console.warn(`[catalog] duplicate tool ID: ${tool.id} — skipping`);
      return;
    }
    seen.add(tool.id);
    tools.push(tool);
  }

  for (const def of CHATGPT_TOOL_DEFINITIONS as Array<{ id: string }>) {
    addTool(processToolDef(def, 'chatgpt'));
  }
  for (const def of PLAN_SESSION_TOOLS as Array<{ id: string }>) {
    addTool(processToolDef(def, 'plan_session'));
  }
  for (const def of CLIENT_INTEGRATION_TOOL_DEFINITIONS as Array<{ id: string }>) {
    addTool(processToolDef(def, 'client_integration'));
  }
  for (const def of STREAM_TOOL_DEFINITIONS as Array<{ id: string }>) {
    addTool(processToolDef(def, 'stream'));
  }
  for (const def of FLYWHEEL_TOOL_DEFINITIONS as Array<{ id: string }>) {
    addTool(processToolDef(def, 'flywheel'));
  }
  for (const def of CONTRACT_TOOL_DEFINITIONS as Array<{ id: string }>) {
    if (V2_ORGX_TOOL_ID_SET.has(def.id)) {
      addTool(processToolDef(def, 'contract'));
    }
  }

  tools.sort((a, b) => a.id.localeCompare(b.id));

  const catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceHash: computeSourceHash(),
    totalTools: tools.length,
    sources: ['chatgpt', 'plan_session', 'client_integration', 'stream', 'flywheel', 'contract'],
    note:
      'Structural source-array catalog. Inline orgx_* core tools are curated downstream until exported from index.ts as data.',
    tools,
  };

  const outDir = path.join(rootDir, 'dist');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'tool-catalog.json');
  writeFileSync(outPath, JSON.stringify(catalog, null, 2) + '\n');

  console.log(
    `[catalog] OK — ${tools.length} tools, sourceHash ${catalog.sourceHash}`,
  );
  console.log(`[catalog] Output: ${outPath}`);
}

main();
