/** Synchronize review descriptors from the operations actually registered by MCP. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { getPublicOperationContract } from '../src/publicOperationContracts';
import { CHATGPT_PUBLIC_SURFACE } from '../src/toolProfiles';
import { isWidgetOnlyTool } from '../src/widgetToolContract';
import { withConsistentToolVisibility } from '../src/toolVisibility';
import { OUTPUT_TEMPLATE_URIS, WIDGET_URIS } from '../src/toolDefinitions';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'server.json');
const submissionPath = resolve(root, 'chatgpt-app-submission.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const submission = JSON.parse(readFileSync(submissionPath, 'utf8'));

const metered = new Set(['orgx_search', 'orgx_get_next_actions', 'orgx_get_agent_status', 'orgx_get_initiative_progress']);
function justification(id: string, description: string, hints: Record<string, boolean>) {
  const human = isWidgetOnlyTool(id) && id !== 'orgx_panel_snapshot';
  return {
    read_only_justification: metered.has(id)
      ? 'Not strictly read-only: successful calls can record metered MCP allowance usage while leaving work records unchanged.'
      : hints.readOnlyHint
        ? `${description} This operation reads or validates data without changing durable business state.`
        : id === 'orgx_submit_work_receipt'
          ? 'Imports a durable producer receipt. Outcome, verification, and acceptance remain producer claims; import does not complete, verify, or accept work.'
          : human
            ? 'Records a person’s explicit widget interaction. Protected rulings require a version-bound capability carried in hidden widget metadata; models receive no human authority.'
            : `${description} This operation creates records or changes existing planning, work, evidence, or execution state.`,
    open_world_justification: hints.openWorldHint
      ? `${description} The declared operation can start or stop execution, use external providers, or affect connected services under OrgX policy.`
      : 'Operates on OrgX records or deterministic document validation. It does not publish content or start work in connected services.',
    destructive_justification: hints.destructiveHint
      ? `${description} Existing content or workflow state changes; dispatched or canceled attempts cannot necessarily be restored as the same execution.`
      : 'Does not permanently delete records or perform a destructive transition. Producer claims and appended evidence do not establish human acceptance.',
  };
}

const tools = CHATGPT_PUBLIC_SURFACE.map((name) => {
  const contract = getPublicOperationContract(name);
  if (!contract?.inputSchema || !contract.annotations) throw new Error(`Incomplete public contract: ${name}`);
  const meta = withConsistentToolVisibility(name, {
    ...('_meta' in contract ? contract._meta : {}),
    'mcp/securitySchemes': contract.securitySchemes,
    ...(['orgx_submit_work_receipt', 'orgx_get_work_receipt'].includes(name) ? {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.proofReceipt,
      ui: { resourceUri: WIDGET_URIS.proofReceipt },
    } : {}),
  });
  const inputSchema = zodToJsonSchema(z.object(contract.inputSchema).strict(), { $refStrategy: 'none' });
  return { name, title: contract.title, description: contract.description, inputSchema,
    annotations: contract.annotations, securitySchemes: contract.securitySchemes,
    ...(Object.keys(meta).length ? { _meta: meta } : {}),
  };
});
manifest.tools = tools;
submission.tools = Object.fromEntries(tools.map((tool) => [tool.name, {
  annotations: tool.annotations,
  justifications: justification(tool.name, tool.description, tool.annotations),
}]));
const renamed: Record<string, string> = {
  orgx_bootstrap: 'orgx_get_workspace_context', orgx_decide: 'orgx_list_pending_decisions',
  get_initiative_pulse: 'orgx_get_initiative_progress', get_agent_status: 'orgx_get_agent_status',
};
for (const test of submission.test_cases) {
  test.tools_triggered = renamed[test.tools_triggered] ?? test.tools_triggered;
  if (test.tools_triggered === 'orgx_get_workspace_context') {
    test.description = 'Read the connected OrgX workspace context without selecting a workspace.';
    test.expected_output = 'Returns authorized workspace context and typed references without changing session selection or exposing OAuth credentials or human approval tokens.';
  }
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(submissionPath, `${JSON.stringify(submission, null, 2)}\n`);
console.log(`Synchronized ${tools.length} public descriptors (${tools.filter((tool) => !isWidgetOnlyTool(tool.name)).length} model-facing).`);
