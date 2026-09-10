import { CHATGPT_PUBLIC_SURFACE } from '../toolProfiles';
import { CANONICAL_OUTPUT_SCHEMAS } from './canonical';
import {
  makeCompactAdvertisedSchema,
  makeErrorCompatibleSchema,
  makePortableJsonAdvertisedSchema,
  type OutputSchema,
  type SourceOutputSchema,
} from './shared';
import { WIDGET_OUTPUT_SCHEMAS } from './widgets';

type ChatGptPublicTool = (typeof CHATGPT_PUBLIC_SURFACE)[number];

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
  'get_agent_status',
  'get_initiative_pulse',
  'get_operator_chronicle',
  'check_execution_readiness',
  'orgx_bootstrap',
  'orgx_inspect',
  'orgx_search',
  'orgx_recommend',
  'orgx_decide',
]);

const rawOutputSchemas = {
  ...CANONICAL_OUTPUT_SCHEMAS,
  ...WIDGET_OUTPUT_SCHEMAS,
} satisfies Record<ChatGptPublicTool, SourceOutputSchema>;

const outputSchemas = Object.fromEntries(
  Object.entries(rawOutputSchemas).map(([name, schema]) => {
    const errorCompatibleSchema = makeErrorCompatibleSchema(schema);
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
> = Object.freeze(outputSchemas);

export function getOpenAiOutputSchema(
  toolName: string
): OutputSchema | undefined {
  return Object.prototype.hasOwnProperty.call(OPENAI_OUTPUT_SCHEMAS, toolName)
    ? OPENAI_OUTPUT_SCHEMAS[toolName as ChatGptPublicTool]
    : undefined;
}
