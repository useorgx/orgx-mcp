import { z } from 'zod';
import { CHATGPT_PUBLIC_SURFACE } from '../toolProfiles';
import { feedBindingForTool } from '../live/streamGrant';
import { CANONICAL_OUTPUT_SCHEMAS } from './canonical';
import {
  makeCompactAdvertisedSchema,
  makeErrorCompatibleSchema,
  makePortableJsonAdvertisedSchema,
  streamGrantSchema,
  jsonValueSchema,
  type OutputSchema,
  type SourceOutputSchema,
} from './shared';
import { OUTPUT_SCHEMA_ALIASES, V2_OUTPUT_SCHEMAS } from './v2';
import { WIDGET_OUTPUT_SCHEMAS } from './widgets';
import { WORKFLOW_TOOL_ADAPTERS, EXTENDED_WORKFLOW_TOOL_ADAPTERS, WORKFLOW_OUTPUT_SCHEMAS } from '../workflowTools';
import { RECEIPT_OPERATION_OUTPUT_SCHEMAS } from '../receiptOperationTools';
import { WIDGET_OPERATION_OUTPUT_SCHEMAS } from '../widgetOperations';
import { WORKFLOW_COMPLETION_OUTPUT_SCHEMA } from '../workflowCompletion';

type ChatGptPublicTool = (typeof CHATGPT_PUBLIC_SURFACE)[number];

const liveSchemas = new WeakMap<SourceOutputSchema, SourceOutputSchema>();
function withStreamGrant(schema: SourceOutputSchema): SourceOutputSchema {
  const cached = liveSchemas.get(schema);
  if (cached) return cached;
  const extended = schema.extend({ live: streamGrantSchema.optional() });
  liveSchemas.set(schema, extended);
  return extended;
}

const SCAFFOLD_TYPED_SCALAR_PROPERTIES = new Set([
  'ok',
  'error_kind',
  'resolution_hint',
  'request_id',
  'billing_url',
  'pricing_url',
  'mode',
  'response_mode',
  'summary',
  'initiative_id',
  'live_url',
  'idempotency_key',
  'entity_plan_count',
  'entity_plan_preview_count',
  'created_preview_count',
  'created_count',
  'failed_preview_count',
  'failed_count',
  'ref_map_count',
  'ref_map_truncated',
  'scaffold_stream_url',
  'scaffold_session_id',
  'estimated_time_seconds',
  'estimated_cost',
  'tool_id',
  'error_type',
]);

// These tools return API-owned nested projections that evolve independently
// of the MCP worker. Keep their named top-level contract closed, but advertise
// nested values as opaque so strict JSON Schema clients do not reject newer
// response fields that the server's full Zod validators already accept.
const COMPACT_NESTED_OUTPUT_TOOLS = new Set<ChatGptPublicTool>([
  ...WORKFLOW_TOOL_ADAPTERS.map((tool) => tool.id),
  ...EXTENDED_WORKFLOW_TOOL_ADAPTERS.map((tool) => tool.id),
  ...Object.keys(RECEIPT_OPERATION_OUTPUT_SCHEMAS),
  ...Object.keys(WIDGET_OPERATION_OUTPUT_SCHEMAS),
  'get_agent_status',
  'get_morning_brief',
  'get_initiative_pulse',
  'get_operator_chronicle',
  'check_execution_readiness',
  'orgx_bootstrap',
  'orgx_widget_select_workspace',
  'orgx_inspect',
  'orgx_search',
  'orgx_recommend',
  'orgx_decide',
  // The artifact record and its canonical review contract are both app-owned.
  'review_artifact',
]);

const compatibilityOutputSchemas: Record<string, SourceOutputSchema> = {
  ...CANONICAL_OUTPUT_SCHEMAS,
  ...WIDGET_OUTPUT_SCHEMAS,
};
const operationOutputSchemas = Object.fromEntries(
  [...WORKFLOW_TOOL_ADAPTERS, ...EXTENDED_WORKFLOW_TOOL_ADAPTERS].map((tool) => {
    const target = tool.outputSchemaToolId;
    const schema = WORKFLOW_OUTPUT_SCHEMAS[tool.id] ?? compatibilityOutputSchemas[target]
      ?? compatibilityOutputSchemas[OUTPUT_SCHEMA_ALIASES[target]] ?? V2_OUTPUT_SCHEMAS[target];
    if (!schema) throw new Error(`Missing output schema for operation ${tool.id} (${target})`);
    return [tool.id, schema];
  })
);
const rawOutputSchemas: Record<string, SourceOutputSchema> = {
  ...compatibilityOutputSchemas,
  ...operationOutputSchemas,
  ...RECEIPT_OPERATION_OUTPUT_SCHEMAS,
  ...WIDGET_OPERATION_OUTPUT_SCHEMAS,
  orgx_complete_work_with_proof: WORKFLOW_COMPLETION_OUTPUT_SCHEMA,
  orgx_open_artifact_review: z.object({
    artifact: z.record(jsonValueSchema).nullable(),
    reviewContract: z.record(jsonValueSchema).nullable().optional(),
    reviewContractSource: z.enum(['canonical', 'entity_fallback']).optional(),
    available_actions: z.array(z.object({ id: z.enum(['approve', 'request_changes']) }).catchall(jsonValueSchema)).optional(),
  }).strict(),
  orgx_widget_select_workspace: CANONICAL_OUTPUT_SCHEMAS.orgx_bootstrap,
};

const outputSchemas = Object.fromEntries(
  Object.entries(rawOutputSchemas).map(([name, schema]) => {
    const transportSchema = feedBindingForTool(name)
      ? withStreamGrant(schema)
      : schema;
    const errorCompatibleSchema = makeErrorCompatibleSchema(transportSchema);
    return [
      name,
      name === 'scaffold_initiative'
        ? makeCompactAdvertisedSchema(
            errorCompatibleSchema,
            SCAFFOLD_TYPED_SCALAR_PROPERTIES
          )
        : COMPACT_NESTED_OUTPUT_TOOLS.has(name as ChatGptPublicTool)
        ? makePortableJsonAdvertisedSchema(errorCompatibleSchema)
        : errorCompatibleSchema,
    ];
  })
) as Record<ChatGptPublicTool, OutputSchema>;

export const OPENAI_OUTPUT_SCHEMAS: Readonly<
  Record<ChatGptPublicTool, OutputSchema>
> = Object.freeze(Object.fromEntries(CHATGPT_PUBLIC_SURFACE.map((name) => [name, outputSchemas[name]])));

export function getOpenAiOutputSchema(
  toolName: string
): OutputSchema | undefined {
  return Object.prototype.hasOwnProperty.call(OPENAI_OUTPUT_SCHEMAS, toolName)
    ? OPENAI_OUTPUT_SCHEMAS[toolName as ChatGptPublicTool]
    : undefined;
}

/**
 * The output contract for any published tool: the reviewed ChatGPT registry
 * first, then an alias to it, then the v2 registry. Returns undefined for a
 * tool with no verified contract, so nothing is ever invented.
 */
export function getToolOutputSchema(
  toolName: string
): OutputSchema | undefined {
  const reviewed = getOpenAiOutputSchema(toolName);
  if (reviewed) return reviewed;
  if (Object.prototype.hasOwnProperty.call(outputSchemas, toolName)) return outputSchemas[toolName];
  const aliasTarget = Object.prototype.hasOwnProperty.call(
    OUTPUT_SCHEMA_ALIASES,
    toolName
  )
    ? OUTPUT_SCHEMA_ALIASES[toolName]
    : undefined;
  if (aliasTarget) {
    const aliasSchema = getOpenAiOutputSchema(aliasTarget)
      ?? (Object.prototype.hasOwnProperty.call(outputSchemas, aliasTarget) ? outputSchemas[aliasTarget] : undefined);
    if (aliasSchema) return aliasSchema;
  }
  const schema = Object.prototype.hasOwnProperty.call(V2_OUTPUT_SCHEMAS, toolName)
    ? V2_OUTPUT_SCHEMAS[toolName] : undefined;
  return schema && feedBindingForTool(toolName)
    ? withStreamGrant(schema) : schema;
}
