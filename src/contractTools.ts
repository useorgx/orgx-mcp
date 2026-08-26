import { z } from 'zod';

import {
  FOUNDER_TEAM_ARTIFACT_TYPE_SUMMARY,
  FOUNDER_TEAM_COMPANY_STAGES,
} from './artifactContracts';
import { LOOP_VALIDATION_RUNGS } from './loopReliabilityValidation';
import {
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  OUTPUT_TEMPLATE_URIS,
  PLAN_SESSION_TOOLS,
  SECURITY_SCHEMES,
  STREAM_TOOL_DEFINITIONS,
  WIDGET_URIS,
  entityTypeEnum,
  lifecycleEntityTypeEnum,
} from './toolDefinitions';
import { FLYWHEEL_TOOL_DEFINITIONS } from './flywheelTools';

export const V2_ORGX_TOOL_IDS = [
  'orgx_bootstrap',
  'orgx_inspect',
  'orgx_search',
  'orgx_recommend',
  'orgx_write',
  'orgx_attach',
  'orgx_act',
  'orgx_emit_activity',
  'orgx_request_attention',
  'orgx_poll_attention',
  'orgx_ack_attention',
  'orgx_request_question',
  'orgx_poll_question',
  'orgx_plan',
  'orgx_spawn',
  'orgx_decide',
  'orgx_expect',
  'orgx_submit_receipt',
  'orgx_create_work',
  'orgx_complete_work',
  'orgx_events_tail',
  'orgx_tail',
] as const;

export const V2_ORGX_TOOL_ID_SET = new Set<string>(V2_ORGX_TOOL_IDS);

export const CONTRACT_TOOL_DEFINITIONS = [
  {
    id: 'orgx_bootstrap',
    title: 'Bootstrap OrgX Contract',
    description:
      'Use at the start of a fresh session, after reconnecting, or before continuing work another agent left behind. Establishes OrgX session context, discovers granted scopes, returns the v2 tool routing map, and persists workspace/session continuity when the selected context changes. Pass initiative_id to bind an initiative and receive its compiled work context, including resolved decisions, acceptance checks, blockers, and artifact state. Also known as: bootstrap, setup, tool routing. USE WHEN: first call in a fresh session, after reconnecting, or before performing a multi-step workflow. NEXT: use orgx_search, orgx_inspect, or orgx_recommend based on the returned routing map. DO NOT USE WHEN: you already have session context and need to read or mutate work. Updates private session state; it does not change business records.',
    inputSchema: {
      workspace_id: z.string().optional().describe('Canonical workspace UUID to bind as the active session workspace'),
      initiative_id: z.string().optional().describe('Optional initiative UUID to bind and hydrate as the active work context'),
      conversation_id: z.string().optional().describe('Optional client conversation/session identifier for continuity'),
      client_name: z.string().optional().describe('Optional MCP client name, such as codex, chatgpt, cursor, or claude'),
      timezone: z.string().optional().describe('Optional user timezone for date-sensitive readouts'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Bootstrapping OrgX contract...',
      'openai/toolInvocation/invoked': 'OrgX contract ready',
      'openai/readOnlyHint': false,
      'openai/visibility': 'public',
    },
  },
  {
    id: 'orgx_inspect',
    title: 'Inspect OrgX Entity',
    description:
      'Use when the user names a specific task, milestone, initiative, decision, artifact, or plan session and you need its real state — decisions, owners, linked proof — before acting. Hydrates one OrgX entity with execution context. Also known as: Inspect OrgX Entity, inspect initiative, get full entity context. USE WHEN: continuing work on a named entity or verifying state before a lifecycle change. NEXT: use orgx_search for related records or orgx_recommend for a read-only next-step assessment. DO NOT USE WHEN: browsing or searching many records; use orgx_search. Read-only.',
    inputSchema: {
      type: z
        .enum(entityTypeEnum.options)
        .describe('Entity type to inspect'),
      id: z.string().min(1).describe('Entity UUID or accepted short ID prefix'),
      hydrate_context: z.boolean().optional().describe('Include linked context where available; default true'),
      max_chars: z.number().int().min(1000).max(50000).optional().describe('Approximate maximum hydrated context characters'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.anyReadRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.searchResults,
      'openai/toolInvocation/invoking': 'Inspecting OrgX entity...',
      'openai/toolInvocation/invoked': 'OrgX entity inspected',
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.searchResults },
    },
  },
  {
    id: 'orgx_search',
    title: 'Search OrgX',
    description:
      "Use when context was lost between sessions, another agent's work must be continued, or the answer may already exist in team memory. Finds OrgX entities, decisions, artifacts, and memory. A query without type runs a mixed relevance search and records metered MCP allowance usage; typed searches provide exhaustive cursor/offset pagination without changing business records. Also known as: Search OrgX, find initiative ID, list work, browse OrgX. USE WHEN: browsing work, searching memory, finding IDs, or listing related records. NEXT: use structuredContent.next_call exactly when pagination.has_more=true, orgx_inspect for one selected result, or orgx_recommend when the user asks what to do next. DO NOT USE WHEN: you already know the exact entity and need full context; use orgx_inspect.",
    inputSchema: {
      query: z.string().optional().describe('Search query for memory or title/text matching'),
      type: z.enum(entityTypeEnum.options).optional().describe('Optional entity type filter, such as task, milestone, decision, artifact, or initiative. Omit with query for a mixed relevance search across memory-backed entity types.'),
      status: z.string().optional().describe('Optional status filter'),
      initiative_id: z.string().optional().describe('Optional initiative UUID scope'),
      workspace_id: z.string().optional().describe('Optional workspace UUID scope'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum records to return'),
      offset: z.number().int().min(0).optional().describe('Typed-search pagination offset. Prefer cursor when next_call returns one.'),
      cursor: z.string().min(1).optional().describe('Opaque typed-search cursor returned by pagination.next_cursor or next_call.'),
      fields: z.array(z.string()).optional().describe('Optional compact field list'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.anyReadRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.searchResults,
      'openai/toolInvocation/invoking': 'Searching OrgX...',
      'openai/toolInvocation/invoked': 'OrgX search complete',
      'openai/readOnlyHint': false,
      ui: { resourceUri: WIDGET_URIS.searchResults },
    },
  },
  {
    id: 'orgx_recommend',
    title: 'Recommend Next OrgX Action',
    description:
      'Use when the user asks what to do next, wants a brief, or returns after time away and needs priorities. Recommends next work, summarizes operator-chronicle/morning-brief signals, and reads prioritization context. The default next_action mode records metered MCP allowance usage; it does not change business records. USE WHEN: user asks what to do next, wants a brief, asks what changed yesterday/week/30 days, or needs priority guidance. mode=morning_brief returns the operator chronicle when available. NEXT: present the recommendation and ask for explicit confirmation before any separate action. DO NOT USE WHEN: the user already specified a concrete action.',
    inputSchema: {
      mode: z.enum(['next_action', 'morning_brief']).optional().describe('Recommendation mode; default next_action'),
      period: z.enum(['day', 'week', '30d']).optional().describe('Reporting period for mode=morning_brief; default 30d'),
      entity_type: z.enum(['workspace', 'initiative', 'workstream', 'milestone', 'task']).optional().describe('Recommendation scope type'),
      entity_id: z.string().optional().describe('Scoped entity ID'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      limit: z.number().int().min(1).max(20).optional().describe('Maximum recommendations'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.morningBrief,
      'openai/toolInvocation/invoking': 'Building OrgX recommendation...',
      'openai/toolInvocation/invoked': 'OrgX recommendation ready',
      'openai/readOnlyHint': false,
      ui: { resourceUri: WIDGET_URIS.morningBrief },
    },
  },
  {
    id: 'orgx_write',
    title: 'Write OrgX Entity',
    description:
      'Create or update one OrgX record (snake_case fields).\n\n' +
      'Operations: create (default) uses per-type fields; update REQUIRES id + fields.\n\n' +
      'Create requirements: workspace name/title; initiative title/name + workspace_id + goal_ids when the workspace enforces primary objectives; workstream title + initiative_id; milestone title + workstream_id; task title + workstream_id + milestone_id when the workspace requires backlog milestones; decision title; artifact target + artifact_type + artifact_url/external_url; blocker run_id + metadata.description; skill/studio records title.\n\n' +
      'Retry behavior: pass idempotency_key on creates. A key match returns the same UUID as an idempotent replay, without creating a duplicate.\n\n' +
      'Initiative constraints: priority accepts low|medium|high|urgent, not portfolio labels such as active/critical/maintenance/hold. due_date is not accepted on initiative create; store portfolio urgency and target dates in metadata.\n\n' +
      'USE WHEN: adding/editing records. Initiative writes can publish a public live link, and update patches overwrite the supplied fields. NEXT: orgx_act to launch/complete the record. DO NOT USE for lifecycle changes — use orgx_act or orgx_attach.',
    inputSchema: {
      operation: z.enum(['create', 'update']).optional().describe('Write operation. Defaults to "create". Set "update" (with id + fields) to patch an existing entity.'),
      type: z.string().min(1).describe('Entity type to write: workspace, task, milestone, decision, artifact, skill, blocker, studio_brand, studio_content, initiative, workstream, or objective. See top-level description for per-type required fields.'),
      id: z.string().optional().describe('REQUIRED when operation="update". Target entity UUID to patch.'),
      title: z.string().optional().describe('REQUIRED on create (provide either "title" or "name" — they are aliases). Display title of the new entity.'),
      name: z.string().optional().describe('Alternative to "title" on create. REQUIRED on create when "title" is not provided.'),
      summary: z.string().optional().describe('Short description shown in lists and previews. Recommended on create.'),
      description: z.string().optional().describe('Longer-form description used in detail views.'),
      fields: z.record(z.unknown()).optional().describe('REQUIRED when operation="update". Map of entity fields to patch (only include fields you want to change).'),
      initiative_id: z.string().optional().describe('Parent initiative UUID. REQUIRED when type="workstream". Optional context for tasks/milestones/artifacts to associate them with an initiative.'),
      workstream_id: z.string().optional().describe('Parent workstream UUID. REQUIRED when type="milestone" or type="task".'),
      milestone_id: z.string().optional().describe('Parent milestone UUID for tasks. Some workspaces require an explicit backlog milestone under the workstream; create/resolve that milestone first instead of relying on auto-resolution.'),
      workspace_id: z.string().optional().describe('Workspace UUID. REQUIRED when the MCP session does not already carry workspace context (resolve via list_entities type=command_center or orgx_inspect type=workspace).'),
      goal_ids: z.array(z.string()).optional().describe('Objective UUIDs for initiative/workstream/milestone/task creation. REQUIRED when the workspace enforces a primary objective. Resolve via orgx_inspect type=objective.'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('Record urgency. Only low|medium|high|urgent are accepted here; do not send portfolio/live labels such as active, critical, maintenance, or hold. "urgent" is normalized to "high" server-side.'),
      due_date: z.string().optional().describe('Due date as YYYY-MM-DD for supported entity types. Do not send due_date when type="initiative"; put initiative target dates in metadata.'),
      status: z.string().optional().describe('Initial workflow status; common agent aliases such as "active" are normalized per entity type ("active" → "in_progress").'),
      entity_type: z.string().optional().describe('REQUIRED when type="artifact". Entity type to attach the artifact to (initiative, workstream, milestone, task, or decision).'),
      entity_id: z.string().optional().describe('REQUIRED when type="artifact" (unless task_id is provided). UUID of the entity to attach the artifact to.'),
      task_id: z.string().optional().describe('Shortcut for attaching an artifact directly to a task. Use instead of entity_type+entity_id when type="artifact" and the target is a task.'),
      artifact_type: z.string().optional().describe(`REQUIRED when type="artifact". Artifact type code. Preferred founder/team examples: ${FOUNDER_TEAM_ARTIFACT_TYPE_SUMMARY}. Custom codes remain accepted.`),
      artifact_url: z.string().optional().describe('Internal artifact URL (e.g. /api/artifacts/...). Either artifact_url or external_url is required when type="artifact"; preview_markdown alone is not accepted.'),
      external_url: z.string().optional().describe('External artifact URL (https://). Either artifact_url or external_url is required when type="artifact"; preview_markdown alone is not accepted.'),
      preview_markdown: z.string().optional().describe('Optional inline markdown preview shown with the linked artifact. Supporting context only; it does not replace artifact_url/external_url.'),
      run_id: z.string().optional().describe('REQUIRED when type="blocker". Agent run UUID the blocker applies to.'),
      step_id: z.string().optional().describe('Optional agent run step UUID for blocker creation.'),
      blocker_type: z.string().optional().describe('Blocker category/type when type="blocker" (e.g. "missing_input", "permission", "external_dependency").'),
      resolution: z.string().optional().describe('Blocker resolution text when known. Used to mark a blocker as resolved.'),
      live_visibility: z.enum(['private', 'public']).optional().describe('Initiative live-link visibility. Only applies when type="initiative".'),
      live_public: z.boolean().optional().describe('Shortcut to publish an initiative live link (sets live_visibility="public"). Only applies when type="initiative".'),
      live_reveal_title: z.boolean().optional().describe('When true, public live-link visitors see the initiative title. Only applies when type="initiative" with live_visibility="public".'),
      metadata: z.record(z.unknown()).optional().describe('Free-form object for type-specific metadata. Schema varies per entity type (e.g. for skills: { capabilities, guardrails, channels }; for studio_brand: { tokens, voice, exemplars }).'),
      tagline: z.string().optional().describe('Workspace tagline when type="workspace".'),
      narrative: z.string().optional().describe('Workspace identity narrative when type="workspace".'),
      key_metrics: z.array(z.string()).optional().describe('Workspace identity metrics when type="workspace".'),
      roadmap_url: z.string().optional().describe('Workspace roadmap URL when type="workspace".'),
      source_links: z.array(z.string()).optional().describe('Workspace source links when type="workspace".'),
      set_active: z.boolean().optional().describe('For workspace create, make the new workspace active. Defaults true.'),
      idempotency_key: z.string().optional().describe('Client-generated retry key. Creates deduplicate by key; updates transport the key outside validated entity fields.'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier returned by orgx_bootstrap.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.anyWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Writing OrgX entity...',
      'openai/toolInvocation/invoked': 'OrgX entity written',
    },
  },
  {
    id: 'orgx_attach',
    title: 'Attach OrgX Artifact',
    description:
      'Use when work produced a deliverable that needs provenance and review — attach the artifact or proof URL to an OrgX entity. Requires artifact_url or external_url; preview_markdown is supporting context only. USE WHEN: saving evidence, PRs, documents, reports, screenshots, or external artifacts. For founder/team work, prefer practical artifact_type codes such as ' +
      FOUNDER_TEAM_ARTIFACT_TYPE_SUMMARY +
      '. Include business_outcome, owner/review_date, and verification when the artifact should close agent work. NEXT: use orgx_submit_receipt to close attribution/quality loops or orgx_act to complete with proof. DO NOT USE WHEN: creating generic entities; use orgx_write.',
    inputSchema: {
      type: lifecycleEntityTypeEnum.describe('Target entity type'),
      id: z.string().min(1).describe('Target entity UUID or short ID prefix'),
      name: z.string().min(1).describe('Artifact title'),
      artifact_type: z.string().min(1).describe(`Artifact type code. Preferred founder/team examples: ${FOUNDER_TEAM_ARTIFACT_TYPE_SUMMARY}. Custom codes remain accepted.`),
      artifact_url: z.string().optional().describe('Internal artifact URL. REQUIRED unless external_url is provided; preview_markdown alone is rejected.'),
      external_url: z.string().optional().describe('External artifact URL. REQUIRED unless artifact_url is provided; preview_markdown alone is rejected.'),
      description: z.string().optional().describe('Artifact description'),
      preview_markdown: z.string().optional().describe('Optional markdown preview shown with the linked artifact. Does not replace artifact_url/external_url.'),
      status: z.enum(['draft', 'in_review', 'approved', 'changes_requested', 'superseded', 'archived']).optional().describe('Artifact workflow status'),
      metadata: z.record(z.unknown()).optional().describe('Artifact metadata'),
      agent_type: z.string().optional().describe('Agent/domain that produced the artifact, such as engineering, sales, product, design, operations, marketing, or orchestrator. Stored under metadata.artifact_contract.'),
      company_stage: z.enum(FOUNDER_TEAM_COMPANY_STAGES).optional().describe('Founder/team context this artifact is calibrated for. Stored under metadata.artifact_contract.'),
      business_outcome: z.string().optional().describe('Business outcome this artifact is meant to advance, such as ship a PR, start founder-led sales, unblock launch, reduce incident risk, or choose the next initiative. Stored under metadata.artifact_contract.'),
      owner: z.string().optional().describe('Human or agent owner for the next review/action. Stored under metadata.artifact_contract.'),
      review_date: z.string().optional().describe('Date or cadence for the next review point. Stored under metadata.artifact_contract.'),
      verification: z.array(z.string()).optional().describe('Verification evidence or checks required before the artifact can count as done. Stored under metadata.artifact_contract.'),
      idempotency_key: z.string().optional().describe('Strongly recommended client-generated idempotency key for safe retries'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Attaching OrgX artifact...',
      'openai/toolInvocation/invoked': 'OrgX artifact attached',
    },
  },
  {
    id: 'orgx_act',
    title: 'Act On OrgX Entity',
    description:
      'Act on one OrgX entity. Required inputs:\n' +
      '  • update → "fields" patch object.\n' +
      '  • complete_with_proof, ship_batch → "artifact" (artifact_type + artifact_url/external_url; preview_markdown optional).\n' +
      '  • validate (studio) → "spec" payload.\n' +
      '  • block, flag_risk, decline, cancel, delete → "note" strongly recommended.\n' +
      '  • dry_run=true previews supported actions; update dry-runs must return would_update.\n\n' +
      'Allowed (type → action) pairs (others return an error):\n' +
      '  workspace: update|delete\n' +
      '  initiative: launch|pause|resume|complete|archive|update|delete\n' +
      '  milestone: start|complete|flag_risk|cancel|ship_batch|update|delete\n' +
      '  workstream: start|pause|resume|block|complete|reassign_streams|update|delete\n' +
      '  task: start|complete|complete_with_proof|block|unblock|reopen|update|delete\n' +
      '  objective, playbook, decision, studio: see field descriptions.\n\n' +
      'USE WHEN: changing entity state. Launch and resume can dispatch connected agent work. For pause, resume, retry, or cancel of running work, use manage_lifecycle so descendant tasks and active runs stay synchronized. NEXT: orgx_submit_receipt for durable proof. DO NOT USE for creating records — use orgx_write.',
    inputSchema: {
      type: lifecycleEntityTypeEnum.describe('Target entity type (workspace, initiative, milestone, workstream, task, objective, playbook, decision, or studio).'),
      id: z.string().min(1).describe('Target entity UUID or short ID prefix (8+ hex chars).'),
      action: z
        .enum([
          'launch',
          'pause',
          'resume',
          'complete',
          'complete_with_proof',
          'archive',
          'start',
          'flag_risk',
          'cancel',
          'block',
          'unblock',
          'reopen',
          'activate',
          'approve',
          'decline',
          'supersede',
          'update',
          'delete',
          'validate',
          'ship_batch',
          'reassign_streams',
        ])
        .describe('Lifecycle action to execute on the target entity. Must be valid for the given type — see tool description for the (type → action) matrix.'),
      fields: z.record(z.unknown()).optional().describe('REQUIRED when action=update. Map of entity fields to patch (e.g. { name?: string, description?: string, owner_id?: string, status?: string, due_date?: string }). Only include fields you want to change.'),
      note: z.string().optional().describe('Strongly recommended for destructive or blocking actions (block, flag_risk, decline, supersede, cancel, delete). Free-text rationale shown in audit history and downstream agent context.'),
      dry_run: z.boolean().optional().describe('Preview update/delete or supported lifecycle actions without mutating. For action=update this returns would_update and must not delegate to orgx_write.'),
      force: z.boolean().optional().describe('Force action where server supports override semantics (skips pre-flight checks).'),
      spec: z.record(z.unknown()).optional().describe('REQUIRED when action=validate. Spec payload for studio validation (shape varies per studio entity subtype).'),
      artifact: z.record(z.unknown()).optional().describe(`REQUIRED when action=complete_with_proof or action=ship_batch. Proof artifact payload. Expected shape: { artifact_type: string, artifact_url?: string, external_url?: string, preview_markdown?: string, name?: string, description?: string }. Either artifact_url or external_url is required; preview_markdown alone is rejected. Preferred founder/team artifact examples: ${FOUNDER_TEAM_ARTIFACT_TYPE_SUMMARY}.`),
      verification: z.array(z.string()).optional().describe('Optional list of verification evidence URLs/IDs for completion flows.'),
      quality_score: z.number().min(0).max(5).optional().describe('Quality score (0-5) attached to the action when used in proof/completion flows.'),
      idempotency_key: z.string().optional().describe('Optional client-supplied retry key. Update requests transport it outside validated entity fields; lifecycle endpoints deduplicate where supported.'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier returned by orgx_bootstrap.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.anyWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Running OrgX action...',
      'openai/toolInvocation/invoked': 'OrgX action complete',
    },
  },
  {
    id: 'orgx_plan',
    title: 'Manage OrgX Plan Session',
    description:
      'Use when planning should survive the session and become executable context instead of a lost chat draft. Starts, resumes, edits, improves, or completes a tracked OrgX planning session.\n\n' +
      'Per-action input requirements:\n' +
      '  • action="start"       → REQUIRES feature_name. Optional: initial_plan (markdown to seed the session).\n' +
      '  • action="resume"      → Optional session_id; when omitted, resumes the most recent active session in the authenticated workspace.\n' +
      '  • action="improve"     → REQUIRES session_id AND plan_content (the current draft to critique).\n' +
      '  • action="record_edit" → REQUIRES session_id AND edit_summary (one-line description of the change).\n' +
      '  • action="complete"    → REQUIRES session_id AND plan_content (the final accepted plan). Optional: attach_to (target entity to link the completed plan to).\n\n' +
      'USE WHEN: work is still in planning or should become executable context. NEXT: use orgx_write or orgx_act after the plan is accepted and needs durable execution state. DO NOT USE WHEN: directly scaffolding a full initiative hierarchy; use scaffold_initiative for that compatibility path.',
    inputSchema: {
      action: z.enum(['start', 'resume', 'improve', 'record_edit', 'complete']).describe('Planning action to perform. See top-level description for per-action required fields.'),
      session_id: z.string().optional().describe('Plan session UUID or orgx://plan_session/<uuid> URI. Optional for action=resume, which defaults to the most recent active session in the authenticated workspace. REQUIRED for action=improve | record_edit | complete. Omit for action=start.'),
      feature_name: z.string().optional().describe('Feature or plan name. REQUIRED when action=start.'),
      initial_plan: z.string().optional().describe('Markdown plan content to seed the new session. Optional on action=start; the session can also be started empty and filled via improve/record_edit.'),
      plan_content: z.string().optional().describe('Current/final plan markdown. REQUIRED when action=improve (the draft to critique) or action=complete (the final accepted plan).'),
      edit_summary: z.string().optional().describe('One-line description of the change being recorded. REQUIRED when action=record_edit.'),
      attach_to: z.record(z.unknown()).optional().describe('Optional target to link the completed plan to when action=complete. Shape: { entity_type: "initiative" | "workstream" | "task", entity_id: string }.'),
      workspace_id: z.string().optional().describe('Workspace UUID to scope action=start plan sessions. Defaults to current session workspace when omitted.'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries. Same key returns the same result without creating duplicate session state.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityAccessRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.planSessionLive,
      'openai/toolInvocation/invoking': 'Updating OrgX plan...',
      'openai/toolInvocation/invoked': 'OrgX plan updated',
      ui: { resourceUri: WIDGET_URIS.planSessionLive },
    },
  },
  {
    id: 'orgx_spawn',
    title: 'Spawn OrgX Agent Work',
    description:
      'Delegate specialist work or check whether delegation is allowed. Actions: guard, estimate, classify, spawn, and handoff.\n\n' +
      'Requirements: existing-task spawn needs task_id; ad-hoc spawn needs title + instructions and should include agent_type. handoff needs task_id + agent_type. guard needs agent_type. classify needs title or task_id. action="estimate" needs title or task_id and returns candidate routes and cost context without dispatching work. OAuth: guard/classify/estimate require agents:read; spawn requires agents:write; handoff requires BOTH agents:write and initiatives:write.\n\n' +
      'Routing: omit model_tier/provider/model for OrgX auto-routing. Set routing or budget fields only when the user, policy, or verification plan constrains them. For controlled reliability validation, use model_tier="standard" and budget_mode="cheapest_valid".\n\n' +
      'USE WHEN: delegating work or checking permission/cost before delegation. NEXT: monitor with orgx_inspect or orgx_search, then attach proof with orgx_submit_receipt. DO NOT USE: to create only a task row; use orgx_write.',
    inputSchema: {
      action: z.enum(['guard', 'estimate', 'spawn', 'handoff', 'classify']).optional().describe('Spawn operation. Defaults to "spawn". Use estimate for pre-spawn cost/routing context without dispatching work. See top-level description for per-action required fields.'),
      title: z.string().optional().describe('Task title. REQUIRED for ad-hoc spawn (action=spawn without task_id) or action=classify without task_id. Used as the human-readable label of the spawned task.'),
      task_id: z.string().optional().describe('Existing task UUID. REQUIRED for action=handoff. REQUIRED for action=spawn when spawning work for an already-created task. Either task_id or title (with instructions) must be provided for action=spawn.'),
      initiative_id: z.string().optional().describe('Optional initiative UUID to scope the spawned task. Inferred from task_id when omitted.'),
      workspace_id: z.string().optional().describe('Optional workspace UUID to scope the spawned task. Defaults to the MCP session\'s workspace.'),
      agent_type: z.string().optional().describe('Target agent type/domain (e.g. "engineering", "marketing", "design"). REQUIRED for action=guard or action=handoff. Strongly recommended for action=spawn so the work routes to the right specialist.'),
      instructions: z.string().optional().describe('Delegation instructions for the agent. REQUIRED for action=spawn when spawning ad-hoc (without task_id). Used to override the task description for action=handoff.'),
      expected_artifacts: z
        .array(z.string())
        .optional()
        .describe(
          'Optional expected final-output labels for action=spawn. Declaring at least one adds an artifact contract to the run; when the agent returns final text without a selectable artifact, OrgX persists that response as a document using the first label.'
        ),
      model_tier: z.enum(['standard', 'balanced', 'precision', 'local', 'sonnet', 'opus']).optional().describe('Optional model tier override. Omit to let OrgX auto-route from task complexity. Legacy local/sonnet/opus are accepted for older clients.'),
      model: z.string().optional().describe('Optional exact model identifier when the user explicitly selects one. Otherwise OrgX resolves the model from task, tier, provider, policy, and budget.'),
      provider: z.enum(['auto', 'openai', 'anthropic', 'openrouter', 'groq', 'local']).optional().describe('Optional provider preference. Use auto unless the user asks for a specific provider or a cost comparison selects one.'),
      budget_mode: z.enum(['cheapest_valid', 'balanced', 'highest_quality']).optional().describe('Optional budget posture override. Use cheapest_valid for controlled validation runs while reliability is being proven.'),
      max_cost_usd: z.number().nonnegative().optional().describe('Optional per-task hard cost ceiling in USD. If the estimate exceeds this, OrgX should block, downgrade, or request approval before dispatch.'),
      idempotency_key: z.string().optional().describe('Optional client-supplied idempotency key for safe retries. Same key returns the same spawn result without re-running.'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier returned by orgx_bootstrap.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: [
      ...SECURITY_SCHEMES.agentAccessRequiresAuth,
      ...SECURITY_SCHEMES.handoffRequiresAuth,
    ],
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.taskSpawned,
      'openai/toolInvocation/invoking': 'Preparing OrgX agent work...',
      'openai/toolInvocation/invoked': 'OrgX agent work ready',
      ui: { resourceUri: WIDGET_URIS.taskSpawned },
    },
  },
  {
    id: 'orgx_decide',
    title: 'Manage OrgX Decision',
    description:
      'Use when the user says "remember this decision," asks "what did we decide about X," or agent work needs human approval before it proceeds. Creates, approves, rejects, remembers, or lists durable OrgX decisions.\n\n' +
      'Per-action input requirements:\n' +
      '  • action="list_pending" → No required fields. Optional: initiative_id, workspace_id (scope filters).\n' +
      '  • action="create"       → REQUIRES title AND decision (the resolved decision text). Recommended: context, initiative_id.\n' +
      '  • action="remember"     → REQUIRES decision (the text to capture as a remembered decision). Optional: title, context.\n' +
      '  • action="approve"      → REQUIRES decision_id. Optional: note (free-text approver rationale).\n' +
      '  • action="reject"       → REQUIRES decision_id AND reason (explanation shown to the assigned agent).\n\n' +
      'USE WHEN: capturing judgment, approval, rejection, or pending decision review. Approval can resume or continue agent execution, including work in connected systems. NEXT: use orgx_act, orgx_write, or orgx_spawn only after the decision resolves the next action. DO NOT USE WHEN: writing non-decision entities; use orgx_write.',
    inputSchema: {
      action: z.enum(['create', 'remember', 'list_pending', 'approve', 'reject']).describe('Decision operation. See top-level description for per-action required fields.'),
      decision_id: z.string().optional().describe('Decision UUID. REQUIRED for action=approve or action=reject. Returned by action=list_pending or action=create.'),
      title: z.string().optional().describe('Short title for the decision. REQUIRED for action=create.'),
      decision: z.string().optional().describe('The decision text itself (what was decided). REQUIRED for action=create and action=remember.'),
      summary: z.string().optional().describe('Optional one-line summary used in lists. Falls back to title when omitted.'),
      context: z.string().optional().describe('Background context / rationale that led to the decision. Recommended for action=create to capture provenance.'),
      reason: z.string().optional().describe('REQUIRED for action=reject. Explanation of why the decision was rejected — used by the assigned agent to adjust its next attempt.'),
      note: z.string().optional().describe('Optional approver note for action=approve. Free-text rationale stored in audit history.'),
      initiative_id: z.string().optional().describe('Optional initiative UUID to scope the decision. Used as filter when action=list_pending; used as parent when action=create.'),
      workspace_id: z.string().optional().describe('Optional workspace UUID to scope the decision. Defaults to the MCP session\'s workspace.'),
      idempotency_key: z.string().optional().describe('Strongly recommended client-supplied idempotency key for writes (action=create, remember, approve, reject). Same key returns the same result without duplicating state.'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier returned by orgx_bootstrap.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.decisionAccessRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.decisions,
      'openai/toolInvocation/invoking': 'Updating OrgX decision...',
      'openai/toolInvocation/invoked': 'OrgX decision updated',
      ui: { resourceUri: WIDGET_URIS.decisions },
    },
  },
  {
    id: 'orgx_expect',
    title: 'Register OrgX Metric Expectation',
    description:
      'Pre-registers one delayed, workspace-level outcome against an exact observer before its measurement window starts. The current bounded contract supports only orgx.run_receipt_coverage.v1: the share of non-benchmark terminal OrgX Business sessions whose schema-valid automatic Agent Work Receipt is stored within the configured deadline. It records a falsifiable threshold and sample-size gate; it does not infer causality, run arbitrary SQL, or match natural-language outcomes. Defaults reproduce the first production gate: at least 95% within 60 seconds over at least 20 runs. USE WHEN: work promises this delayed reliability result and the future window has not started. NEXT: let the scheduled observer resolve it after the window; inspect compiled context after resolution. DO NOT USE WHEN: reporting execution completion — use orgx_submit_receipt; or for an unsupported business metric.',
    inputSchema: {
      metric: z.literal('orgx.run_receipt_coverage.v1').describe('REQUIRED exact observer registry ID. No other metric is currently admitted.'),
      workspace_id: z.string().optional().describe('Workspace UUID. Defaults to the MCP session workspace. The subject and metric scope are derived from this exact workspace.'),
      window_starts_at: z.string().describe('REQUIRED future ISO-8601 datetime with timezone offset. Registration is rejected after this window begins.'),
      window_ends_at: z.string().describe('REQUIRED ISO-8601 datetime with timezone offset, after window_starts_at and no more than 31 days later.'),
      threshold: z.number().min(0).max(1).optional().describe('Required receipt coverage ratio. Defaults to 0.95. The predicate is fixed to greater-than-or-equal.'),
      minimum_sample_size: z.number().int().min(1).max(100000).optional().describe('Minimum terminal-run denominator required for a conclusive result. Defaults to 20.'),
      receipt_deadline_seconds: z.number().int().min(1).max(3600).optional().describe('Maximum seconds from terminal session end to durable automatic receipt. Defaults to 60.'),
      evaluation_interval_seconds: z.number().int().min(60).max(86400).optional().describe('Retry cadence when the observer is unavailable. Defaults to 300 seconds.'),
      idempotency_key: z.string().max(200).optional().describe('Client-supplied retry key sent as Idempotency-Key. Generated when omitted; reuse the same key to replay safely.'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier returned by orgx_bootstrap.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Registering metric expectation...',
      'openai/toolInvocation/invoked': 'Metric expectation registered',
    },
  },
  {
    id: 'orgx_submit_receipt',
    title: 'Submit OrgX Receipt',
    description:
      'Use when the user says "show me it actually shipped" — completion must be proven with evidence, not prose. Submits a durable receipt anchored to an OrgX entity or artifact.\n\n' +
      'Required: receipt_type + summary. Strongly recommended: one anchor (entity_type+entity_id OR artifact_id), artifact_type, business_outcome, agent_type, and a verifiable URL in evidence.\n\n' +
      'Recognized receipt_type: "proof", "outcome" (measurable result), "quality" (review/score), "attribution" (credit link to revenue/value), "learning" (distilled lesson). Custom keys also accepted.\n\n' +
      'Recognized evidence shapes (mix and match):\n' +
      '  { prs: string[] } — GitHub PR URLs.\n' +
      '  { deploys: string[] } — deployment URLs.\n' +
      '  { test_runs: string[] } — CI run URLs.\n' +
      '  { metrics: { name, value, unit? }[] } — quantitative outcomes.\n' +
      '  { links: string[] }, { notes: string } — supporting URLs/text.\n\n' +
      'Pass idempotency_key when retrying — server deduplicates.\n\n' +
      'USE WHEN: closing the loop on agent work with provenance. Receipts should prove the practical artifact and its business outcome, not just say the agent finished. NEXT: orgx_recommend or orgx_search to find the next priority. DO NOT USE for telemetry — use orgx_emit_activity.',
    inputSchema: {
      workspace_id: z.string().optional().describe('Workspace UUID. Defaults to the MCP session\'s workspace when omitted.'),
      entity_type: z.string().optional().describe('Related entity type (initiative, workstream, milestone, task, decision). Required if no artifact_id is provided — pair with entity_id.'),
      entity_id: z.string().optional().describe('Related entity UUID. Required when entity_type is provided.'),
      receipt_type: z.string().min(1).describe('Receipt category key. Recognized values: "proof", "outcome", "quality", "attribution", "learning". Custom domain-specific keys are also accepted.'),
      summary: z.string().min(1).describe('One-sentence human-readable description of what the receipt proves (e.g. "Merged PR #142 unblocking the auth refactor").'),
      evidence: z.record(z.unknown()).optional().describe('Structured evidence payload. Recognized shapes: { prs: string[] }, { deploys: string[] }, { test_runs: string[] }, { metrics: { name, value, unit? }[] }, { links: string[] }, { notes: string }. See top-level description for full list. At least one verifiable URL is strongly recommended.'),
      artifact_id: z.string().optional().describe('Related artifact UUID to anchor the receipt to. Alternative to entity_type+entity_id when the proof lives in OrgX as an artifact.'),
      artifact_type: z.string().optional().describe(`Artifact type this receipt proves. Preferred founder/team examples: ${FOUNDER_TEAM_ARTIFACT_TYPE_SUMMARY}.`),
      agent_type: z.string().optional().describe('Agent/domain that produced the receipt, such as engineering, sales, product, design, operations, marketing, or orchestrator.'),
      business_outcome: z.string().optional().describe('Business outcome advanced by the receipt.'),
      verification_status: z.enum(['passed', 'failed', 'blocked', 'not_run']).optional().describe('Whether the artifact verification passed, failed, was blocked, or was not run.'),
      validation_rung: z.enum(LOOP_VALIDATION_RUNGS).optional().describe('Optional OrgX loop validation rung this receipt proves. Required for promotion-grade loop validation receipts.'),
      loop_validation: z.boolean().optional().describe('Set true when this receipt should be evaluated against the OrgX loop reliability validation ladder.'),
      model_tier: z.enum(['standard', 'balanced', 'precision', 'local', 'sonnet', 'opus']).optional().describe('Model tier used for the run being receipted. For validation rungs before calibrated expansion, use standard.'),
      budget_mode: z.enum(['cheapest_valid', 'balanced', 'highest_quality']).optional().describe('Budget posture used for the run being receipted. For validation rungs before calibrated expansion, use cheapest_valid.'),
      max_cost_usd: z.number().nonnegative().optional().describe('Per-task or canary spend cap used during the validation run, when known.'),
      // Without these two, a receipt could only ever say "completed". The API
      // write path defaulted status to 'completed' on every insert and stamped
      // started_at = completed_at = now(), so failure was unrepresentable and
      // every receipt claimed a zero-duration run. Fixing the API alone left
      // the fix unreachable — this tool is how agents actually submit.
      status: z.enum(['in_progress', 'completed', 'failed', 'cancelled']).optional().describe('Terminal state of the work being receipted. Pass failed or cancelled when that is what happened — omitting it records completed, and a receipt that can only say "completed" makes every reliability number a survivorship filter.'),
      started_at: z.string().optional().describe('ISO-8601 timestamp of when the work actually started. Omit if unknown rather than guessing: the record leaves duration unknown instead of claiming zero. Must not be in the future.'),
      idempotency_key: z.string().optional().describe('Strongly recommended client-supplied idempotency key. Submitting the same key twice will not create a duplicate receipt.'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier returned by orgx_bootstrap.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Submitting OrgX receipt...',
      'openai/toolInvocation/invoked': 'OrgX receipt submitted',
    },
  },
  {
    id: 'orgx_create_work',
    title: 'Create Work (v1 Command)',
    description:
      'Accepts organizational work onto the v1 proof-runtime ledger (POST /api/v1/commands/create-work). Records the work item as a command event; it does not start external execution. Requires an existing initiative + workstream + milestone chain. An Idempotency-Key is generated when none is supplied; retrying with the same idempotency_key returns the original result instead of duplicating. USE WHEN: registering a ledger-backed work item under an existing milestone so its lifecycle is event-sourced. NEXT: orgx_complete_work when the work finishes, or orgx_events_tail to watch the recorded events. DO NOT USE WHEN: creating initiatives, workstreams, milestones, or ordinary tasks — use orgx_write; or when dispatching an agent — use orgx_spawn.',
    inputSchema: {
      workspace_id: z.string().optional().describe('Workspace UUID. Defaults to the MCP session\'s workspace when omitted.'),
      title: z.string().min(1).describe('Work item title (max 240 characters).'),
      description: z.string().optional().describe('Longer description (max 4000 characters).'),
      initiative_id: z.string().describe('REQUIRED. Parent initiative UUID.'),
      workstream_id: z.string().describe('REQUIRED. Parent workstream UUID.'),
      milestone_id: z.string().describe('REQUIRED. Parent milestone UUID.'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('Priority. Defaults to medium.'),
      due_date: z.string().optional().describe('Due date as YYYY-MM-DD.'),
      metadata: z.record(z.unknown()).optional().describe('Free-form JSON metadata stored on the work item.'),
      estimated_cost_cents: z.number().int().nonnegative().optional().describe('Estimated cost in cents. Defaults to 0.'),
      command_id: z.string().optional().describe('Client-supplied command UUID. Generated when omitted.'),
      expected_aggregate_version: z.number().int().optional().describe('Must be 0 when provided — create-work targets a brand-new aggregate. Sent as 0 by default.'),
      causation_id: z.string().optional().describe('Optional UUID of the event that caused this command.'),
      correlation_id: z.string().optional().describe('Optional correlation UUID linking related commands.'),
      idempotency_key: z.string().optional().describe('Client-supplied retry key sent as the Idempotency-Key header. Generated when omitted; reuse the same key to retry safely.'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier returned by orgx_bootstrap.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Creating v1 work item...',
      'openai/toolInvocation/invoked': 'v1 work item recorded',
    },
  },
  {
    id: 'orgx_complete_work',
    title: 'Complete Work (v1 Command)',
    description:
      'Marks a v1 ledger work item complete (POST /api/v1/commands/complete-work) with optimistic concurrency: expected_updated_at and expected_aggregate_version must match the current task record or the command returns a conflict — read them fresh, never guess. Records summary, evidence, and cost on the completion event; it does not verify the work. An Idempotency-Key is generated when none is supplied. USE WHEN: closing a ledger-backed work item created with orgx_create_work. NEXT: orgx_submit_receipt for durable proof of the completed work. DO NOT USE WHEN: completing ordinary OrgX tasks — use orgx_act (complete_with_proof); or on a version conflict — re-read the task and retry with current values.',
    inputSchema: {
      workspace_id: z.string().optional().describe('Workspace UUID. Defaults to the MCP session\'s workspace when omitted.'),
      task_id: z.string().describe('REQUIRED. UUID of the ledger work item to complete.'),
      expected_updated_at: z.string().describe('REQUIRED. The task\'s current updated_at as an ISO datetime with timezone offset. A mismatch returns a conflict.'),
      expected_aggregate_version: z.number().int().nonnegative().describe('REQUIRED. The task\'s current aggregate version. A mismatch returns a conflict.'),
      summary: z.string().optional().describe('Completion summary (max 4000 characters).'),
      evidence: z.record(z.unknown()).optional().describe('Free-form JSON evidence recorded on the completion event.'),
      cost_cents: z.number().int().nonnegative().optional().describe('Actual cost in cents. Defaults to 0.'),
      causation_id: z.string().optional().describe('Optional UUID of the event that caused this command.'),
      correlation_id: z.string().optional().describe('Optional correlation UUID linking related commands.'),
      idempotency_key: z.string().optional().describe('Client-supplied retry key sent as the Idempotency-Key header. Generated when omitted; reuse the same key to retry safely.'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier returned by orgx_bootstrap.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Completing v1 work item...',
      'openai/toolInvocation/invoked': 'v1 work completion recorded',
    },
  },
  {
    id: 'orgx_events_tail',
    title: 'Tail Ledger Events (v1)',
    description:
      'Reads the workspace\'s v1 ledger event stream (GET /api/v1/events/stream) in JSON cursor-page mode — never SSE. Returns events newest-first plus meta.nextCursor/hasMore; pass the returned cursor back (cursor or after) to continue paging. Read-only. USE WHEN: tailing what the proof runtime recorded — work commands, completions, receipts — or resuming from a saved cursor. NEXT: orgx_inspect for one referenced entity, or call again with the returned cursor while hasMore=true.',
    inputSchema: {
      workspace_id: z.string().optional().describe('Workspace UUID. Defaults to the MCP session\'s workspace when omitted.'),
      after: z.string().optional().describe('Cursor from a previous page (alias of cursor): returns the page after it.'),
      cursor: z.string().optional().describe('Opaque cursor from meta.nextCursor of a previous page.'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum events per page (1-100).'),
      event_type: z.string().optional().describe('Optional event type filter. Comma-separate multiple types.'),
      aggregate_type: z.string().optional().describe('Optional aggregate type filter (lowercase identifier).'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier returned by orgx_bootstrap.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Reading ledger events...',
      'openai/toolInvocation/invoked': 'Ledger events ready',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'orgx_tail',
    title: 'Tail Material Context Changes',
    description:
      'Use during a long-running session to read accepted material state changes since orgx_bootstrap. Pass the exact capsule_id and as_of_global_sequence returned by bootstrap. Returns only the currently ledger-backed allowlist in ascending global-sequence order: accepted/superseded decisions, authority lease changes, blocker changes, and metric-expectation registration/resolution. It explicitly reports material classes that are not ledger-backed yet. Read-only. USE WHEN: the session may have outlived its bootstrap context. NEXT: apply the returned changes or call again with next_after_sequence while has_more=true. DO NOT USE: as a substitute for orgx_bootstrap or to infer applied learning, constraints, or incidents that the coverage boundary marks unavailable.',
    inputSchema: {
      capsule_id: z
        .string()
        .regex(/^capsule_[0-9a-f]{24}$/)
        .describe('Exact capsule_id returned by orgx_bootstrap.'),
      after_sequence: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .describe('Exact as_of_global_sequence or next_after_sequence from the previous call.'),
      workspace_id: z
        .string()
        .uuid()
        .optional()
        .describe('Workspace UUID. Defaults to the MCP session workspace.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Maximum material changes per page (1-100).'),
      session_id: z
        .string()
        .optional()
        .describe('Optional bootstrap/session identifier returned by orgx_bootstrap.'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Reading material context changes...',
      'openai/toolInvocation/invoked': 'Material context changes ready',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'orgx_describe_tool',
    title: 'Describe OrgX Tool',
    description:
      'Use when you are unsure of a tool\'s exact fields or enums and a wrong guess would waste a call. Returns the live input contract, auth expectations, and workflow guidance for an OrgX tool. Also known as: tool schema, tool help, contract. USE WHEN: you need exact field names, accepted enums, or next-step guidance before calling a tool. Read-only.',
    inputSchema: {
      tool_id: z.string().min(1).describe('Tool ID to inspect'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Describing tool contract...',
      'openai/toolInvocation/invoked': 'Tool contract ready',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'orgx_describe_action',
    title: 'Describe Entity Action',
    description:
      'Use when you are about to change entity state and need the exact action name or payload shape first. Describes lifecycle actions, aliases, and special payload requirements for entity_action. USE WHEN: you need the exact action name or payload shape before calling entity_action. Read-only.',
    inputSchema: {
      type: lifecycleEntityTypeEnum.describe('Entity type'),
      action: z.string().optional().describe('Specific action to inspect'),
      id: z
        .string()
        .optional()
        .describe('Optional entity ID to fetch currently available actions'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Describing entity action...',
      'openai/toolInvocation/invoked': 'Entity action contract ready',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'remember_decision',
    title: 'Remember Decision',
    description:
      'Use when the user says "remember this decision" or a judgment call must not be relitigated next session. Saves the decision to organizational memory so agents and teammates can recall it later. Also known as: decision log, team memory, agent memory, record decision, remember what we decided.',
    inputSchema: {
      decision: z
        .string()
        .min(1)
        .describe('Decision text or short decision title to remember'),
      context: z
        .string()
        .optional()
        .describe('Optional background, rationale, or source context'),
      title: z
        .string()
        .optional()
        .describe('Optional explicit decision title'),
      initiative_id: z
        .string()
        .optional()
        .describe('Optional parent initiative UUID'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      priority: z
        .enum(['low', 'medium', 'high', 'urgent'])
        .optional()
        .describe('Priority / urgency'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Remembering decision...',
      'openai/toolInvocation/invoked': 'Decision remembered',
    },
  },
  {
    id: 'recall_memory',
    title: 'Recall Memory',
    description:
      'Use when the user asks "what did we decide about X" or prior context must be recovered from team memory. Searches organizational memory for prior decisions, artifacts, project context, and team knowledge. Also known as: search memory, recall decisions, find context, retrieve artifacts, what did we decide.',
    inputSchema: {
      query: z.string().min(1).describe('Search query for organizational memory'),
      scope: z
        .enum(['all', 'artifacts', 'decisions', 'initiatives'])
        .optional()
        .describe('Optional scope filter for the memory search'),
      limit: z
        .number()
        .optional()
        .describe('Maximum number of results to return'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.memoryReadRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.searchResults,
      'openai/toolInvocation/invoking': 'Recalling organizational memory...',
      'openai/toolInvocation/invoked': 'Memory recalled',
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.searchResults },
    },
  },
  {
    id: 'approve_agent_work',
    title: 'Approve Agent Work',
    description:
      'Use when agent work is paused waiting for a human yes — review pending decisions, then approve or reject them. Also known as: pending approvals, agent blocked, sign off, review decisions, approve AI work.\n\n' +
      'Per-action input requirements:\n' +
      '  • action="list" (default when action omitted) → No required fields. Optional filters: limit, urgency_filter, initiative_id.\n' +
      '  • action="approve" → REQUIRES decision_id. Optional: note (free-text approver rationale). Approval can resume or continue connected agent execution.\n' +
      '  • action="reject"  → REQUIRES decision_id AND reason (explanation shown to the assigned agent so it can adjust its next attempt).',
    inputSchema: {
      decision_id: z
        .string()
        .optional()
        .describe('REQUIRED when action="approve" or action="reject". Decision UUID from the pending approvals list.'),
      action: z
        .enum(['list', 'approve', 'reject'])
        .optional()
        .describe('Operation to perform. Defaults to "list" (returns pending approvals). Use "approve" or "reject" to act on a specific decision_id.'),
      note: z.string().optional().describe('Optional approver note for action="approve". Free-text rationale stored in audit history.'),
      reason: z.string().optional().describe('REQUIRED for action="reject". Explanation of why the decision was rejected — used by the agent to adjust its next attempt.'),
      limit: z
        .number()
        .optional()
        .describe('Used only when action="list" (or omitted). Max pending decisions to return.'),
      urgency_filter: z
        .enum(['all', 'critical', 'high'])
        .optional()
        .describe('Used only when action="list". Filters the returned pending decisions by urgency.'),
      initiative_id: z
        .string()
        .optional()
        .describe('Used only when action="list". Scopes pending decisions to a specific initiative UUID.'),
      workspace_id: z
        .string()
        .optional()
        .describe('Used only when action="list". Scopes pending decisions to a specific workspace UUID. Defaults to the MCP session workspace when omitted.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.decisions,
      'openai/toolInvocation/invoking': 'Reviewing agent approvals...',
      'openai/toolInvocation/invoked': 'Agent approvals reviewed',
      ui: { resourceUri: WIDGET_URIS.decisions },
    },
  },
  {
    id: 'delegate_agent_task',
    title: 'Delegate Agent Task',
    description:
      'Use when the user says "delegate this and tell me when it\'s done" — assign work to a specialist AI agent that owns the task and reports back with results. Also known as: hand this off, spawn agent, assign task, delegate to agent, have an AI agent do it.',
    inputSchema: {
      agent: z.string().min(1).describe('Target agent identifier or alias'),
      task: z.string().min(1).describe('Task instructions for the target agent'),
      context: z
        .string()
        .optional()
        .describe('Optional supporting context or background for the task'),
      initiative_id: z
        .string()
        .optional()
        .describe('Optional initiative UUID to associate with the spawned task'),
      initiative_name: z
        .string()
        .optional()
        .describe('Optional initiative title to resolve automatically if ID is unknown'),
      expected_artifacts: z
        .array(z.string())
        .optional()
        .describe('Optional final outputs you expect'),
      deadline: z
        .string()
        .optional()
        .describe('Optional due date or plain-text deadline'),
      style_guidelines: z
        .string()
        .optional()
        .describe('Optional voice, format, or style constraints'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.agentRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.taskSpawned,
      'openai/toolInvocation/invoking': 'Delegating agent task...',
      'openai/toolInvocation/invoked': 'Agent task delegated',
      ui: { resourceUri: WIDGET_URIS.taskSpawned },
    },
  },
  {
    id: 'track_project_progress',
    title: 'Track Project Progress',
    description:
      'Use when the user asks how a project is going, what is blocked, or whether an initiative is on track. Returns health, blockers, milestones, owners, and recent activity. Also known as: project status, initiative pulse, blockers, roadmap progress, execution health.',
    inputSchema: {
      initiative_id: z
        .string()
        .optional()
        .describe('Optional initiative UUID to check'),
      initiative_name: z
        .string()
        .optional()
        .describe('Optional initiative title to resolve automatically if ID is unknown'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.initiativePulse,
      'openai/toolInvocation/invoking': 'Tracking project progress...',
      'openai/toolInvocation/invoked': 'Project progress retrieved',
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.initiativePulse },
    },
  },
  {
    id: 'resume_plan_session',
    title: 'Resume Plan Session',
    description:
      'Use when a planning session from an earlier conversation must continue without re-briefing. Resumes a planning session by UUID, orgx:// URI, or most recent active session. Also known as: continue plan, reload planning context. USE WHEN: continuing a planning workflow without guessing IDs.',
    inputSchema: {
      session_id: z
        .string()
        .optional()
        .describe('Plan session UUID or orgx://plan_session/<uuid>'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Loading plan session...',
      'openai/toolInvocation/invoked': 'Plan session loaded',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'create_task',
    title: 'Create Task',
    description:
      'Use when a piece of work must be tracked beyond this conversation as an owned, actionable task. Creates the task in organizational memory for a project, milestone, or agent. Also known as: add task, create work item. USE WHEN: adding a single actionable task to a workstream, milestone, or initiative. NEXT: use entity_action action=start when execution should begin.',
    inputSchema: {
      title: z.string().min(1).describe('Task title'),
      summary: z.string().optional().describe('Task summary'),
      description: z.string().optional().describe('Task description'),
      initiative_id: z.string().optional().describe('Parent initiative UUID'),
      workstream_id: z.string().optional().describe('Parent workstream UUID'),
      milestone_id: z.string().optional().describe('Parent milestone UUID'),
      due_date: z.string().optional().describe('Due date (YYYY-MM-DD)'),
      priority: z
        .enum(['low', 'medium', 'high', 'urgent'])
        .optional()
        .describe('Priority'),
      sequence: z.number().int().min(0).optional().describe('Execution order'),
      domain: z.string().optional().describe('Planning domain'),
      depends_on: z.array(z.string()).optional().describe('Dependency IDs'),
      assigned_agent_ids: z
        .array(z.string())
        .optional()
        .describe('Explicit assignee IDs'),
      proof_profile: z
        .enum(['full', 'subcomponent', 'release', 'external_artifact'])
        .optional()
        .describe(
          'Proof-chain profile. "full" = independent artifact + quality_score + rubric; "subcomponent" = parent ships proof via milestone ship_batch; "release" = external ship event closes the loop; "external_artifact" = artifact lives outside OrgX, link only. See https://mcp.useorgx.com/docs/proof-chain.'
        ),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      command_center_id: z
        .string()
        .optional()
        .describe('Deprecated alias for workspace_id'),
      owner_id: z.string().optional().describe('Explicit owner ID'),
      user_id: z.string().optional().describe('Deprecated alias for owner_id'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Creating task...',
      'openai/toolInvocation/invoked': 'Task created',
    },
  },
  {
    id: 'create_milestone',
    title: 'Create Milestone',
    description:
      'Use when a delivery phase or checkpoint needs durable tracking under an initiative. Creates a project milestone with durable context. Also known as: add milestone, create checkpoint. USE WHEN: adding a phase checkpoint under an initiative or workstream.',
    inputSchema: {
      title: z.string().min(1).describe('Milestone title'),
      summary: z.string().optional().describe('Milestone summary'),
      description: z.string().optional().describe('Milestone description'),
      initiative_id: z.string().optional().describe('Parent initiative UUID'),
      workstream_id: z.string().optional().describe('Parent workstream UUID'),
      due_date: z.string().optional().describe('Due date (YYYY-MM-DD)'),
      priority: z
        .enum(['low', 'medium', 'high', 'urgent'])
        .optional()
        .describe('Priority'),
      sequence: z.number().int().min(0).optional().describe('Execution order'),
      domain: z.string().optional().describe('Planning domain'),
      proof_profile: z
        .enum(['full', 'subcomponent', 'release', 'external_artifact'])
        .optional()
        .describe(
          'Proof-chain profile. "full" = independent artifact + quality_score + rubric; "subcomponent" = parent ships proof via milestone ship_batch; "release" = external ship event closes the loop; "external_artifact" = artifact lives outside OrgX, link only. See https://mcp.useorgx.com/docs/proof-chain.'
        ),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      command_center_id: z
        .string()
        .optional()
        .describe('Deprecated alias for workspace_id'),
      owner_id: z.string().optional().describe('Explicit owner ID'),
      user_id: z.string().optional().describe('Deprecated alias for owner_id'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Creating milestone...',
      'openai/toolInvocation/invoked': 'Milestone created',
    },
  },
  {
    id: 'create_decision',
    title: 'Create Decision',
    description:
      'Use when a judgment or approval point must be recorded so it is not relitigated later. Records the decision in organizational memory so agents can recall it. Also known as: remember decision, decision log, team memory. USE WHEN: surfacing a new approval or judgment point for a workspace or initiative.',
    inputSchema: {
      title: z.string().min(1).describe('Decision title'),
      summary: z.string().optional().describe('Decision summary'),
      initiative_id: z.string().optional().describe('Parent initiative UUID'),
      priority: z
        .enum(['low', 'medium', 'high', 'urgent'])
        .optional()
        .describe('Priority / urgency'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      command_center_id: z
        .string()
        .optional()
        .describe('Deprecated alias for workspace_id'),
      owner_id: z.string().optional().describe('Explicit owner ID'),
      user_id: z.string().optional().describe('Deprecated alias for owner_id'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Creating decision...',
      'openai/toolInvocation/invoked': 'Decision created',
    },
  },
  {
    id: 'validate_studio_content',
    title: 'Validate Studio Content',
    description:
      'Use when a studio content spec must pass validation before rendering or publication. Validates the studio_content entity without composing entity_action manually. USE WHEN: checking a studio content spec before rendering or publication.',
    inputSchema: {
      id: z.string().uuid().describe('studio_content entity UUID'),
      spec: z
        .record(z.unknown())
        .optional()
        .describe('Spec payload to validate'),
      note: z.string().optional().describe('Optional validation note'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Validating studio content...',
      'openai/toolInvocation/invoked': 'Studio content validated',
    },
  },
  {
    id: 'pin_workstream',
    title: 'Pin Workstream',
    description:
      'Use when a workstream must jump the priority queue and stay at the top of Next Up. Pins the workstream without composing queue_action manually. USE WHEN: forcing a workstream to the top of the recommendation queue.',
    inputSchema: {
      initiative_id: z.string().min(1).describe('Initiative UUID'),
      workstream_id: z.string().min(1).describe('Workstream UUID'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      command_center_id: z
        .string()
        .optional()
        .describe('Deprecated alias for workspace_id'),
      rank: z.number().optional().describe('Pinned order, 0 = top'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Pinning workstream...',
      'openai/toolInvocation/invoked': 'Workstream pinned',
    },
  },
] as const;

export const INLINE_TOOL_CONTRACTS = {
  get_org_snapshot: {
    id: 'get_org_snapshot',
    title: 'Fetch Organization Snapshot',
    description:
      'Inline worker tool for reading an organization-wide execution snapshot across initiatives, work, blockers, and context.',
    inputSchema: {
      view: z.enum(['summary', 'detailed']).optional().describe('Response view mode. Defaults to summary.'),
      initiative_status: z.enum(['active', 'paused', 'all']).optional().describe('Initiative status filter. Defaults to active.'),
      include: z.array(z.enum(['initiatives', 'milestones', 'tasks'])).optional().describe('Detailed mode sections to include.'),
      limit: z.number().min(1).max(100).optional().describe('Maximum initiatives to return.'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
    },
  },
  account_status: {
    id: 'account_status',
    title: 'Get Account Status',
    description:
      'Inline worker tool for reading the authenticated user account tier, billing status, and usage snapshot.',
    inputSchema: {},
  },
  account_upgrade: {
    id: 'account_upgrade',
    title: 'Upgrade Account',
    description:
      'Inline worker tool for creating account upgrade or agent credit checkout flows.',
    inputSchema: {
      target_plan: z.enum(['pro', 'enterprise']).optional().describe('Target account plan. Defaults to pro.'),
      billing_cycle: z.enum(['monthly', 'annual']).optional().describe('Billing cadence for self-serve checkout.'),
      credit_pack: z.enum(['credits_500', 'credits_2000']).optional().describe('Optional agent credit pack to buy instead of upgrading a plan.'),
    },
  },
  account_usage_report: {
    id: 'account_usage_report',
    title: 'Get Account Usage Report',
    description:
      'Inline worker tool for reading detailed usage, quota, billing-period, and overage signals.',
    inputSchema: {},
  },
  list_entities: {
    id: 'list_entities',
    title: 'List Entities',
    description:
      'Inline worker tool for listing OrgX entities with filtering, pagination, and optional hydration.',
    inputSchema: {
      type: z.string().optional().describe('Entity type to list, such as initiative, workstream, milestone, task, decision, artifact, objective, or agent.'),
      id: z.string().optional().describe('Exact entity ID filter.'),
      limit: z.number().min(1).max(100).optional().describe('Maximum rows to return.'),
      offset: z.number().min(0).optional().describe('Pagination offset.'),
      order_by: z.enum(['created_at', 'updated_at', 'sequence', 'due_date', 'priority', 'status', 'title', 'name', 'natural']).optional().describe('Sort field.'),
      order_direction: z.enum(['asc', 'desc']).optional().describe('Sort direction.'),
      status: z.string().optional().describe('Optional status filter.'),
      initiative_id: z.string().optional().describe('Optional initiative scope.'),
      workspace_id: z.string().optional().describe('Optional workspace scope.'),
      hydrate_context: z.boolean().optional().describe('Hydrate linked context when an ID is provided.'),
      fields: z.array(z.string()).optional().describe('Compact field list to return.'),
    },
  },
  comment_on_entity: {
    id: 'comment_on_entity',
    title: 'Comment On Entity',
    description:
      'Inline worker tool for adding threaded comments, concerns, progress notes, or handoff notes to an entity.',
    inputSchema: {
      entity_type: z.enum(['initiative', 'workstream', 'milestone', 'task', 'decision']).describe('Entity type to comment on.'),
      entity_id: z.string().min(1).describe('Entity ID to attach the comment to.'),
      body: z.string().min(1).max(4000).describe('Comment body in plain text or markdown.'),
      parent_comment_id: z.string().uuid().optional().describe('Optional parent comment ID when replying in-thread.'),
      comment_type: z.enum(['observation', 'concern', 'suggestion', 'progress_note', 'blocker_flag', 'question', 'handoff_note', 'cross_reference', 'note']).optional().describe('Optional comment classification.'),
      severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional().describe('Optional severity for triage.'),
      tags: z.array(z.string()).optional().describe('Optional tags.'),
      metadata: z.record(z.unknown()).optional().describe('Optional structured metadata.'),
    },
  },
  list_entity_comments: {
    id: 'list_entity_comments',
    title: 'List Entity Comments',
    description:
      'Inline worker tool for reading the comment thread attached to an entity.',
    inputSchema: {
      entity_type: z.enum(['initiative', 'workstream', 'milestone', 'task', 'decision']).describe('Entity type to read comments for.'),
      entity_id: z.string().min(1).describe('Entity ID whose comment thread should be returned.'),
      limit: z.number().min(1).max(100).optional().describe('Maximum comments to return.'),
    },
  },
  batch_create_entities: {
    id: 'batch_create_entities',
    title: 'Batch Create Entities',
    description:
      'Inline worker tool for creating multiple related entities with ref-based dependency resolution.',
    inputSchema: {
      entities: z.array(z.record(z.unknown())).min(1).max(100).describe('Entity payloads. Each item must include type and required fields.'),
      owner_id: z.string().optional().describe('Optional owner ID applied when item owner is omitted.'),
      user_id: z.string().optional().describe('Deprecated alias for owner_id.'),
      continue_on_error: z.boolean().optional().describe('Continue creating remaining entities after an error.'),
      concurrency: z.number().min(1).max(20).optional().describe('Parallel creation concurrency.'),
    },
  },
  batch_delete_entities: {
    id: 'batch_delete_entities',
    title: 'Batch Delete Entities',
    description:
      'Inline worker tool for permanently deleting multiple entities in one authenticated call.',
    inputSchema: {
      entities: z.array(z.object({ type: lifecycleEntityTypeEnum.describe('Entity type'), id: z.string().min(1).describe('Entity ID') })).min(1).max(100).describe('Entities to delete.'),
      concurrency: z.number().min(1).max(20).optional().describe('Parallel deletion concurrency.'),
      continue_on_error: z.boolean().optional().describe('Continue deleting remaining entities after an error.'),
      note: z.string().optional().describe('Optional reason note.'),
    },
  },
  batch_action: {
    id: 'batch_action',
    title: 'Batch Entity Actions',
    description:
      'Inline worker tool for running lifecycle actions against multiple entities in one authenticated call.',
    inputSchema: {
      actions: z.array(z.object({
        type: lifecycleEntityTypeEnum.describe('Entity type'),
        id: z.string().min(1).describe('Entity ID or accepted short prefix.'),
        action: z.string().min(1).describe('Lifecycle action, such as pause, launch, complete, resume, or block.'),
        note: z.string().optional().describe('Optional action note.'),
        force: z.boolean().optional().describe('Force action when supported.'),
      })).min(1).max(100).describe('Lifecycle actions to execute.'),
      concurrency: z.number().min(1).max(20).optional().describe('Parallel action concurrency.'),
      continue_on_error: z.boolean().optional().describe('Continue after an action error.'),
    },
  },
  create_entity: {
    id: 'create_entity',
    title: 'Create Entity',
    description:
      'Inline worker power tool for creating any entity type. Prefer create_task, create_milestone, or create_decision for common flows.',
    inputSchema: {
      type: z.string().min(1).describe('Entity type to create.'),
      title: z.string().optional().describe('Display title/name for the entity.'),
      name: z.string().optional().describe('Alias for title.'),
      summary: z.string().optional().describe('Short summary.'),
      description: z.string().optional().describe('Longer description.'),
      workspace_id: z.string().optional().describe('Workspace scope.'),
      initiative_id: z.string().optional().describe('Parent initiative ID.'),
      workstream_id: z.string().optional().describe('Parent workstream ID.'),
      milestone_id: z.string().optional().describe('Parent milestone ID.'),
      metadata: z.record(z.unknown()).optional().describe('Type-specific metadata.'),
    },
  },
  update_entity: {
    id: 'update_entity',
    title: 'Update Entity',
    description:
      'Inline worker tool for updating mutable fields on an existing entity.',
    inputSchema: {
      type: z.string().min(1).describe('Entity type to update.'),
      id: z.string().min(1).describe('Entity ID to update.'),
      fields: z.record(z.unknown()).optional().describe('Fields to patch.'),
      title: z.string().optional().describe('Optional title patch.'),
      name: z.string().optional().describe('Optional name patch.'),
      description: z.string().optional().describe('Optional description patch.'),
      status: z.string().optional().describe('Optional status patch.'),
    },
  },
  entity_action: {
    id: 'entity_action',
    title: 'Entity Action',
    description:
      'Inline worker tool for lifecycle actions, attachments, and specialized operations like studio validation.',
    inputSchema: {
      type: lifecycleEntityTypeEnum.describe('Target entity type.'),
      id: z.string().min(1).describe('Target entity ID or accepted short prefix.'),
      action: z.string().optional().describe('Lifecycle action. Omit to list available actions.'),
      fields: z.record(z.unknown()).optional().describe('Fields patch for action=update.'),
      note: z.string().optional().describe('Optional action note.'),
      artifact_type: z.string().optional().describe('Artifact type for attach/proof actions.'),
      artifact_url: z.string().optional().describe('Internal artifact URL for attach/proof actions.'),
      external_url: z.string().optional().describe('External artifact URL for attach/proof actions.'),
      preview_markdown: z.string().optional().describe('Optional markdown preview for linked artifact.'),
      metadata: z.record(z.unknown()).optional().describe('Optional metadata payload.'),
      force: z.boolean().optional().describe('Force action when supported.'),
      dry_run: z.boolean().optional().describe('Preview action when supported.'),
    },
  },
  scaffold_initiative: {
    id: 'scaffold_initiative',
    title: 'Scaffold Initiative',
    description:
      'Inline worker tool for drafting, creating, or launching a full initiative hierarchy in one call. Also known as: Scaffold an initiative hierarchy, create workstream tree, build initiative plan. Returns initiative_id, ref_map, and preferred_next_calls with orgx_search/orgx_inspect next calls for chaining.',
    inputSchema: {
      title: z.string().min(1).describe('Initiative title.'),
      summary: z.string().optional().describe('Initiative summary.'),
      description: z.string().optional().describe('Initiative description.'),
      workspace_id: z.string().optional().describe('Workspace UUID; required unless session context provides one.'),
      objective_ids: z.array(z.string()).optional().describe('Preferred objective UUIDs.'),
      goal_ids: z.array(z.string()).optional().describe('Objective UUID alias for API compatibility.'),
      mode: z.enum(['draft', 'scaffold', 'launch']).optional().describe('Draft validates, scaffold creates records, launch creates and starts follow-up work.'),
      response_mode: z.enum(['fast_ack', 'complete']).optional().describe('Return after durable creation or wait for launch follow-ups.'),
      workstreams: z.array(z.record(z.unknown())).optional().describe('Nested workstream hierarchy.'),
      idempotency_key: z.string().optional().describe('Stable retry key.'),
      command_center_id: z.string().optional().describe('Deprecated alias for workspace_id.'),
      context: z.array(z.record(z.unknown())).optional().describe('Context attachment pointers.'),
      source_evidence: z.record(z.unknown()).optional().describe('For initiatives based on a named external product/site: include { target_url, verification_state: "verified"|"partial"|"unverified", evidence_urls: string[], notes? }. Do not create or launch from search-result inference when the target could not be rendered; use mode="draft" until screenshots or browser evidence verify the source.'),
      coordination_dependency: z.record(z.unknown()).optional().describe('Most important cross-workstream dependency.'),
      owner_id: z.string().optional().describe('Owner user ID.'),
      user_id: z.string().optional().describe('Deprecated alias for owner_id.'),
      continue_on_error: z.boolean().optional().describe('Continue remaining creates after an error.'),
      launch_after_create: z.boolean().optional().describe('Legacy mode alias.'),
      external_sync: z.record(z.unknown()).optional().describe('Optional work-tracker mirror configuration.'),
      concurrency: z.number().min(1).max(20).optional().describe('Creation concurrency.'),
    },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
  },
  get_task_with_context: {
    id: 'get_task_with_context',
    title: 'Get Task With Context',
    description:
      'Inline worker tool for loading a task with hydrated decisions, artifacts, entities, and plan-session context.',
    inputSchema: {
      task_id: z.string().min(1).describe('Task UUID or accepted short prefix.'),
      include_artifacts: z.boolean().optional().describe('Include linked artifacts.'),
      include_decisions: z.boolean().optional().describe('Include linked decisions.'),
      include_context: z.boolean().optional().describe('Include broader execution context.'),
    },
  },
  verify_entity_completion: {
    id: 'verify_entity_completion',
    title: 'Verify Entity Completion',
    description:
      'Inline worker tool for checking hierarchy and proof-chain readiness before completing an entity.',
    inputSchema: {
      type: lifecycleEntityTypeEnum.describe('Entity type to verify.'),
      id: z.string().min(1).describe('Entity ID to verify.'),
    },
  },
  resume_agent_run: {
    id: 'resume_agent_run',
    title: 'Resume Agent Run',
    description:
      'Inline worker tool for resuming a paused or TTL auto-closed agent run.',
    inputSchema: {
      run_id: z.string().min(1).describe('Agent run UUID to resume.'),
      note: z.string().optional().describe('Optional audit note.'),
    },
  },
  review_artifact: {
    id: 'review_artifact',
    title: 'Review Artifact',
    description:
      'Use when the user asks to review work, sign off on a deliverable, or clear pending artifact reviews. Surfaces the next artifact awaiting review and renders the artifact-review widget with a preview, version filmstrip, and hold-to-approve / request-changes actions. USE WHEN the user asks to review work, approve a deliverable, or handle pending artifact reviews. DO NOT USE for listing all artifacts — use list_entities type=artifact instead.',
    inputSchema: {
      artifact_id: z
        .string()
        .optional()
        .describe(
          'Specific artifact ID to review. Defaults to the next in_review artifact.'
        ),
      entity_id: z
        .string()
        .optional()
        .describe(
          'Scope to artifacts attached to this entity (initiative, workstream, milestone, or task).'
        ),
      workspace_id: z
        .string()
        .optional()
        .describe('Workspace UUID. Defaults to the session workspace.'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
  },
  save_artifact: {
    id: 'save_artifact',
    title: 'Save Artifact',
    description:
      'Deprecated inline compatibility wrapper that attaches a linked artifact to an entity; prefer entity_action action=attach.',
    inputSchema: {
      title: z.string().describe('Artifact title.'),
      type: z.string().optional().describe('Legacy artifact category or artifact type code.'),
      artifact_type: z.string().optional().describe('Preferred artifact type code.'),
      entity_type: z.enum(['project', 'initiative', 'workstream', 'milestone', 'task', 'decision']).optional().describe('Target entity type.'),
      entity_id: z.string().optional().describe('Target entity UUID.'),
      taskId: z.string().optional().describe('Legacy task target shortcut.'),
      initiativeId: z.string().optional().describe('Legacy initiative target shortcut.'),
      content: z.string().optional().describe('Optional content stored as preview_markdown.'),
      artifact_url: z.string().optional().describe('Internal artifact URL; required unless external_url is provided.'),
      external_url: z.string().optional().describe('External artifact URL; required unless artifact_url is provided.'),
      metadata: z.record(z.unknown()).optional().describe('Optional metadata.'),
    },
  },
} as const;

export type KnownToolContract = {
  id: string;
  title: string;
  description: string;
  inputSchema?: Record<string, z.ZodTypeAny>;
  securitySchemes?: readonly { type: string; scopes?: readonly string[] }[];
  annotations?: Record<string, boolean>;
  _meta?: Record<string, unknown>;
  source:
    | 'chatgpt'
    | 'plan_session'
    | 'client_integration'
    | 'stream'
    | 'flywheel'
    | 'contract'
    | 'inline';
};

export type ToolSecuritySchemes = readonly {
  type: string;
  scopes?: readonly string[];
}[];

function normalizedEntityDomain(value: unknown):
  | 'decisions'
  | 'agents'
  | 'initiatives'
  | null {
  if (typeof value !== 'string') return null;
  const type = value.trim().toLowerCase().replace(/-/g, '_');
  if (type === 'decision') return 'decisions';
  if (type === 'agent' || type === 'run') return 'agents';
  return entityTypeEnum.options.includes(
    type as (typeof entityTypeEnum.options)[number]
  )
    ? 'initiatives'
    : null;
}

function readSchemesForEntity(value: unknown): ToolSecuritySchemes {
  switch (normalizedEntityDomain(value)) {
    case 'decisions':
      return SECURITY_SCHEMES.decisionReadRequiresAuth;
    case 'agents':
      return SECURITY_SCHEMES.agentReadRequiresAuth;
    case 'initiatives':
      return SECURITY_SCHEMES.entityReadRequiresAuth;
    default:
      // An untyped/unknown lookup can traverse every private read domain.
      return SECURITY_SCHEMES.allReadRequiresAuth;
  }
}

function writeSchemesForEntity(value: unknown): ToolSecuritySchemes {
  switch (normalizedEntityDomain(value)) {
    case 'decisions':
      return SECURITY_SCHEMES.writeRequiresAuth;
    case 'agents':
      return SECURITY_SCHEMES.agentRequiresAuth;
    case 'initiatives':
      return SECURITY_SCHEMES.entityWriteRequiresAuth;
    default:
      // orgx_write intentionally accepts a string for forward compatibility.
      // Unknown domains therefore require the complete write grant rather
      // than silently inheriting initiatives:write.
      return SECURITY_SCHEMES.allWriteRequiresAuth;
  }
}

/**
 * Resolve the precise OAuth requirement for contract tools whose resource
 * domain is selected by their arguments. The advertised scheme remains an
 * OR-of-domains so a narrow custom grant can discover the tool; this resolver
 * is the invocation-time authority.
 */
export function resolveContractToolInvocationSecuritySchemes(
  toolId: string,
  args: Record<string, unknown>,
  fallback?: ToolSecuritySchemes
): ToolSecuritySchemes | undefined {
  switch (toolId) {
    case 'orgx_search':
      return readSchemesForEntity(args.type);
    case 'orgx_inspect':
      // Hydration is on by default and may include linked decisions, agent
      // runs, and memory context. Callers with a narrow grant can explicitly
      // request the base entity only.
      return args.hydrate_context === false
        ? readSchemesForEntity(args.type)
        : SECURITY_SCHEMES.allReadRequiresAuth;
    case 'orgx_write':
      return writeSchemesForEntity(args.type);
    case 'orgx_act': {
      if (normalizedEntityDomain(args.type) === 'decisions') {
        return SECURITY_SCHEMES.writeRequiresAuth;
      }
      if (args.action === 'launch' || args.action === 'resume') {
        return SECURITY_SCHEMES.handoffRequiresAuth;
      }
      return writeSchemesForEntity(args.type);
    }
    case 'orgx_plan':
      return args.action === 'resume'
        ? SECURITY_SCHEMES.entityReadRequiresAuth
        : SECURITY_SCHEMES.entityWriteRequiresAuth;
    case 'orgx_spawn':
      if (args.action === 'handoff') {
        return SECURITY_SCHEMES.handoffRequiresAuth;
      }
      return args.action === 'guard' ||
        args.action === 'classify' ||
        args.action === 'estimate'
        ? SECURITY_SCHEMES.agentReadRequiresAuth
        : SECURITY_SCHEMES.agentRequiresAuth;
    case 'orgx_decide':
      return args.action === 'list_pending'
        ? SECURITY_SCHEMES.decisionReadRequiresAuth
        : SECURITY_SCHEMES.writeRequiresAuth;
    default:
      return fallback;
  }
}

export function getKnownToolContracts(): KnownToolContract[] {
  const liftInputSchema = (
    inputSchema: unknown
  ): Record<string, z.ZodTypeAny> | undefined => {
    if (!inputSchema) return undefined;
    if (inputSchema instanceof z.ZodObject) {
      return inputSchema.shape as Record<string, z.ZodTypeAny>;
    }
    return inputSchema as Record<string, z.ZodTypeAny>;
  };

  const liftContract = (
    tool: {
      id: string;
      title: string;
      description: string;
      inputSchema?: unknown;
      securitySchemes?: readonly { type: string; scopes?: readonly string[] }[];
      annotations?: Record<string, boolean>;
      _meta?: Record<string, unknown>;
    },
    source: KnownToolContract['source']
  ): KnownToolContract => ({
    ...tool,
    inputSchema: liftInputSchema(tool.inputSchema),
    source,
  });

  const typedContracts: KnownToolContract[] = [
    ...CHATGPT_TOOL_DEFINITIONS.map((tool) => liftContract(tool, 'chatgpt')),
    ...PLAN_SESSION_TOOLS.map((tool) => liftContract(tool, 'plan_session')),
    ...CLIENT_INTEGRATION_TOOL_DEFINITIONS.map((tool) =>
      liftContract(tool, 'client_integration')
    ),
    ...STREAM_TOOL_DEFINITIONS.map((tool) => liftContract(tool, 'stream')),
    ...FLYWHEEL_TOOL_DEFINITIONS.map((tool) => liftContract(tool, 'flywheel')),
    ...CONTRACT_TOOL_DEFINITIONS.map((tool) => liftContract(tool, 'contract')),
  ];

  const inlineContracts: KnownToolContract[] = Object.values(INLINE_TOOL_CONTRACTS).map(
    (tool) => ({
      ...tool,
      source: 'inline' as const,
    })
  );

  return [...typedContracts, ...inlineContracts];
}

export function getKnownToolContract(toolId: string): KnownToolContract | null {
  return getKnownToolContracts().find((tool) => tool.id === toolId) ?? null;
}
