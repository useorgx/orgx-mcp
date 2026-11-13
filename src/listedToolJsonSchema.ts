/**
 * JSON Schema for listed tools, kept the shape clients already rely on.
 *
 * The MCP SDK converts zod 4 schemas with zod's own toJSONSchema. That
 * output differs from the zod-to-json-schema output clients saw while this
 * server ran on zod 3, and one difference matters: zod 4 leaves
 * `additionalProperties` off every non-strict object in input schemas.
 * ChatGPT's strict mode needs `additionalProperties: false` on every object,
 * so dropping it would change which tools ChatGPT can call strictly.
 *
 * This module converts with the same zod call plus an override that puts
 * back what zod 3 listed:
 *   - stripped objects say `additionalProperties: false` (input and output);
 *     passthrough objects say `true`; catchall objects keep their schema;
 *   - a tool registered with `inputSchema: {}` lists no
 *     `additionalProperties`, as the SDK listed it before;
 *   - in output schemas, a field that may be left out (optional or with a
 *     default) is not listed as required;
 *   - records list `propertyNames` only for keys with their own checks;
 *   - integers do not gain zod's generated safe-integer bounds;
 *   - string formats do not gain zod's generated `pattern` (uuid, guid,
 *     date-time, email and so on); a pattern written in the source stays;
 *     a URL that also has a pattern still says `format: uri`.
 *
 * Shared sub-schemas are inlined instead of zod 3's `#/properties/...`
 * references, and recursive values (JSON values) are listed under
 * `definitions`. Both validate exactly what the references did.
 */
import { z } from 'zod';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';

type JsonSchema = Record<string, unknown>;
type Io = 'input' | 'output';

const EMPTY_OBJECT_JSON_SCHEMA: JsonSchema = { type: 'object', properties: {} };

/** Formats whose zod 4 output adds a `pattern` that zod 3 never listed. */
const FORMAT_PATTERN_FORMATS = new Set([
  'uuid', 'guid', 'email', 'date-time', 'date', 'time', 'duration', 'ipv4', 'ipv6',
  'cidrv4', 'cidrv6', 'base64', 'base64url', 'e164', 'jwt', 'cuid', 'cuid2', 'ulid',
  'xid', 'ksuid', 'nanoid', 'emoji', 'uri', 'url',
]);

interface ZodInternals {
  _zod?: {
    def?: {
      type?: string;
      shape?: Record<string, { _zod?: { optin?: string; optout?: string } }>;
      catchall?: { _zod?: { def?: { type?: string } } };
      format?: string;
      checks?: Array<{ _zod?: { def?: { check?: string; format?: string; pattern?: RegExp } } }>;
      pattern?: RegExp;
    };
    bag?: { patterns?: Set<RegExp> };
  };
}

/** The regexes the source wrote with .regex(), as opposed to format patterns. */
function sourcePatterns(schema: ZodInternals): Set<string> {
  const written = new Set<string>();
  for (const check of schema._zod?.def?.checks ?? []) {
    const def = check._zod?.def;
    if (def?.check === 'string_format' && def.format === 'regex' && def.pattern) {
      written.add(def.pattern.source);
    }
  }
  return written;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/** Marks a branch so zod's final pass keeps the anyOf; removed before listing. */
const KEEP_ANYOF = 'x-orgx-keep-anyof';

function overrideFor(io: Io) {
  return (ctx: { zodSchema: unknown; jsonSchema: JsonSchema }) => override(ctx, io);
}

function override(ctx: { zodSchema: unknown; jsonSchema: JsonSchema }, io: Io): void {
  const schema = ctx.zodSchema as ZodInternals;
  const def = schema._zod?.def;
  const json = ctx.jsonSchema;
  if (!def) return;

  if (def.type === 'object') {
    const shape = def.shape ?? {};
    const catchall = def.catchall?._zod?.def?.type;
    if (!catchall || catchall === 'never') {
      json.additionalProperties = false;
    } else if (catchall === 'unknown' || catchall === 'any') {
      json.additionalProperties = true;
    }
    if (io === 'output' && Array.isArray(json.required)) {
      const required = (json.required as string[]).filter((key) => {
        const field = shape[key]?._zod;
        return field?.optin !== 'optional' && field?.optout !== 'optional';
      });
      if (required.length) json.required = required;
      else delete json.required;
    }
    return;
  }

  if (def.type === 'nullable') {
    // zod 3 listed a nullable union of plain types as
    // anyOf:[{type:[a,b]},{type:null}]; zod 4 folds it into one type array.
    const options = json.anyOf as JsonSchema[] | undefined;
    const inner = options?.[0]?.anyOf as JsonSchema[] | undefined;
    const bare = (part: JsonSchema) => Object.keys(part).length === 1 && typeof part.type === 'string';
    if (options?.length === 2 && options[1]?.type === 'null' && Object.keys(options[1]).length === 1 &&
        Object.keys(options[0]).length === 1 && inner?.every(bare)) {
      json.anyOf = [{ type: inner.map((part) => part.type) }, { type: 'null', [KEEP_ANYOF]: true }];
    }
    return;
  }

  if (def.type === 'number') {
    const bounds = new Set(
      (def.checks ?? [])
        .map((check) => (check._zod?.def as { check?: string; value?: unknown } | undefined))
        .filter((check) => check?.check === 'less_than' || check?.check === 'greater_than')
        .map((check) => check?.value)
    );
    if (json.maximum === MAX_SAFE && !bounds.has(MAX_SAFE)) delete json.maximum;
    if (json.minimum === -MAX_SAFE && !bounds.has(-MAX_SAFE)) delete json.minimum;
    return;
  }

  if (def.type === 'string' && json.format === undefined) {
    const formats = (def.checks ?? []).map((check) => check._zod?.def?.format);
    if (formats.includes('url')) {
      // zod 3 listed the format right after the type.
      const rest = { ...json };
      for (const key of Object.keys(json)) delete json[key];
      Object.assign(json, { type: rest.type, format: 'uri' }, rest);
    }
  }

  if (def.type === 'string' && typeof json.pattern === 'string') {
    const written = sourcePatterns(schema);
    const format = typeof json.format === 'string' ? json.format : def.format;
    const fromFormat = format && FORMAT_PATTERN_FORMATS.has(format);
    if (fromFormat && !written.has(json.pattern)) {
      delete json.pattern;
    }
    if (Array.isArray(json.allOf)) {
      json.allOf = (json.allOf as JsonSchema[]).filter(
        (part) => !(typeof part.pattern === 'string' && fromFormat && !written.has(part.pattern) && Object.keys(part).length === 1)
      );
      if ((json.allOf as JsonSchema[]).length === 0) delete json.allOf;
    }
  }
}

/**
 * Schemas that were already zod 4 under zod 3 (built from `zod/v4`) and so
 * were listed by the SDK's plain zod 4 conversion. They keep that listing.
 */
const LISTED_AS_ZOD4 = new WeakSet<object>();

export function listAsPlainZod4<T extends object>(schema: T): T {
  LISTED_AS_ZOD4.add(schema);
  return schema;
}

export interface ListedJsonSchemaOptions {
  /**
   * 'first-use' (the default, as tools/list) points a reused schema at its
   * first use; 'none' writes it out in full every time, as zod 3's
   * `$refStrategy: 'none'` did. A recursive schema is still referenced.
   */
  refs?: 'first-use' | 'none';
}

/** One listed schema in the shape this server has always listed. */
export function toListedJsonSchema(schema: unknown, io: Io, options: ListedJsonSchemaOptions = {}): JsonSchema {
  if (LISTED_AS_ZOD4.has(schema as object)) {
    return z.toJSONSchema(schema as z.ZodType, { target: 'draft-7', io }) as JsonSchema;
  }
  const json = z.toJSONSchema(schema as z.ZodType, {
    target: 'draft-7',
    io,
    reused: 'ref',
    override: overrideFor(io) as never,
  }) as JsonSchema;
  return inlineFirstUse(json, options.refs ?? 'first-use');
}

/** Key order zod 3 used for arrays: type and items before their bounds. */
const ARRAY_LEAD = ['type', 'items'];
/** Strings: the format right after the type. */
const STRING_LEAD = ['type', 'format'];
/** And for records: values before key checks. */
const RECORD_LEAD = ['type', 'additionalProperties', 'propertyNames'];

/** Per-node clean-up: drop the anyOf marker and plain-string propertyNames, order keys. */
function tidy(node: JsonSchema): JsonSchema {
  delete node[KEEP_ANYOF];
  // Records list propertyNames only for keys with their own checks.
  const names = node.propertyNames as JsonSchema | undefined;
  if (names && typeof names === 'object' && names.type === 'string') {
    const { type: _type, ...checks } = names;
    if (Object.keys(checks).length) node.propertyNames = checks;
    else delete node.propertyNames;
  }
  if ('default' in node) {
    // zod 3 listed a default after the field's own keywords, before its description.
    const { default: fallback, ...rest } = node;
    const keys = Object.keys(rest);
    const trailingDescription = keys[keys.length - 1] === 'description';
    const { description, ...others } = rest;
    node = trailingDescription
      ? { ...others, default: fallback, description }
      : { ...rest, default: fallback };
  }
  const lead = node.type === 'string' && 'format' in node ? STRING_LEAD
    : node.type === 'array' && 'items' in node ? ARRAY_LEAD
    : node.type === 'object' && 'propertyNames' in node && !('properties' in node) ? RECORD_LEAD
    : null;
  if (lead) {
    const ordered: JsonSchema = {};
    for (const key of lead) if (key in node) ordered[key] = node[key];
    for (const [key, value] of Object.entries(node)) if (!(key in ordered)) ordered[key] = value;
    return ordered;
  }
  return node;
}

/**
 * zod 3 listed a schema used more than once in full where it first appeared
 * and pointed later uses at that place (`#/properties/a/items`). zod 4 moves
 * it to `definitions`. Put each definition back at its first use, in the
 * same depth-first order, and point the rest there.
 */
function inlineFirstUse(root: JsonSchema, refs: 'first-use' | 'none'): JsonSchema {
  const definitions = (root.definitions ?? {}) as Record<string, JsonSchema>;
  const placed = new Map<string, string>();
  const inlining = new Set<string>();
  const prefix = '#/definitions/';
  const escape = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

  const visit = (node: unknown, path: string[]): unknown => {
    if (Array.isArray(node)) return node.map((item, index) => visit(item, [...path, String(index)]));
    if (!node || typeof node !== 'object') return node;
    let record = node as JsonSchema;
    // zod 4 writes a reused schema with its own metadata as allOf:[{$ref}].
    const allOf = record.allOf;
    if (Array.isArray(allOf) && allOf.length === 1 && record.$ref === undefined) {
      const only = allOf[0] as JsonSchema;
      if (only && typeof only.$ref === 'string' && Object.keys(only).length === 1) {
        const { allOf: _allOf, ...siblings } = record;
        record = { $ref: only.$ref, ...siblings };
      }
    }
    const ref = record.$ref;
    if (typeof ref === 'string' && ref.startsWith(prefix)) {
      const name = ref.slice(prefix.length);
      const body = definitions[name];
      if (body) {
        const { $ref: _ref, ...rest } = record;
        const seen = placed.get(name);
        // A use with its own fields (a description, a tighter bound) is
        // listed in full, as zod 3 did; only a bare reuse points back.
        if (Object.keys(rest).length && !inlining.has(name)) {
          inlining.add(name);
          const full = tidy({ ...(visit(body, path) as JsonSchema), ...visitEntries(rest, path) });
          inlining.delete(name);
          return full;
        }
        if (seen && (refs === 'first-use' || inlining.has(name))) return { $ref: seen, ...visitEntries(rest, path) };
        if (inlining.has(name)) return { $ref: ref, ...visitEntries(rest, path) };
        if (!seen) placed.set(name, '#/' + path.map(escape).join('/'));
        inlining.add(name);
        const full = visit(body, path);
        inlining.delete(name);
        return full;
      }
    }
    return visitEntries(record, path);
  };
  const visitEntries = (record: JsonSchema, path: string[]): JsonSchema =>
    tidy(Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key, visit(value, [...path, key])])
    ) as JsonSchema);

  // zod 3 listed $schema last.
  const { definitions: _definitions, $schema, ...body } = root;
  const result = visitEntries(body, []);
  if ($schema !== undefined) result.$schema = $schema;
  const unplaced = Object.keys(definitions).filter(
    (name) => !placed.has(name) && JSON.stringify(result).includes(`"${prefix}${name}"`)
  );
  if (unplaced.length) {
    result.definitions = Object.fromEntries(unplaced.map((name) => [name, definitions[name]]));
  }
  return result;
}

/**
 * The SDK wraps `inputSchema: {}` in an empty zod-mini object, which it
 * always listed without additionalProperties. A zod object written in
 * the source (it has `.strict`) is listed like any other object.
 */
function listedInput(input: unknown): JsonSchema {
  const json = toListedJsonSchema(input, 'input');
  const object = input as { strict?: unknown; _zod?: { def?: { shape?: object } } };
  const sdkEmptyShape = typeof object.strict !== 'function' &&
    Object.keys(object._zod?.def?.shape ?? {}).length === 0;
  if (sdkEmptyShape) delete json.additionalProperties;
  return json;
}

interface RegisteredToolLike {
  enabled?: boolean;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  execution?: unknown;
  _meta?: unknown;
}

/**
 * Replace the SDK's tools/list handler with one that lists the same tools
 * in the same order and fields, converting schemas with toListedJsonSchema.
 * Call after the first tool is registered; safe to call more than once.
 */
export function installListedToolSchemas(server: McpServer): void {
  const tools = (server as unknown as { _registeredTools?: Record<string, RegisteredToolLike> })._registeredTools;
  if (!tools) return;
  const registry = server as unknown as { _registeredTools: Record<string, RegisteredToolLike> };
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.entries(registry._registeredTools)
      .filter(([, tool]) => tool.enabled)
      .map(([name, tool]) => {
        const input = normalizeObjectSchema(tool.inputSchema as never);
        const definition: Record<string, unknown> = {
          name,
          title: tool.title,
          description: tool.description,
          inputSchema: input ? listedInput(input) : EMPTY_OBJECT_JSON_SCHEMA,
          annotations: tool.annotations,
          execution: tool.execution,
          _meta: tool._meta,
        };
        if (tool.outputSchema) {
          const output = normalizeObjectSchema(tool.outputSchema as never);
          if (output) definition.outputSchema = toListedJsonSchema(output, 'output');
        }
        return definition;
      }),
  }) as never);
}
