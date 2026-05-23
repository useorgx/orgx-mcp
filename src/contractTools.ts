import { z } from 'zod';

import {
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  OUTPUT_TEMPLATE_URIS,
  PLAN_SESSION_TOOLS,
  SECURITY_SCHEMES,
  STREAM_TOOL_DEFINITIONS,
  WIDGET_URIS,
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
  'orgx_plan',
  'orgx_spawn',
  'orgx_decide',
  'orgx_submit_receipt',
] as const;

export const V2_ORGX_TOOL_ID_SET = new Set<string>(V2_ORGX_TOOL_IDS);

export const CONTRACT_TOOL_DEFINITIONS = [
  {
    id: 'orgx_bootstrap',
    title: 'Bootstrap OrgX Contract',
    description:
      'Establish OrgX session context, discover granted scopes, and get the v2 tool routing map. Also known as: bootstrap, setup, tool routing. USE WHEN: first call in a fresh session, after reconnecting, or before performing a multi-step workflow. NEXT: use orgx_search, orgx_inspect, or orgx_recommend based on the returned routing map. DO NOT USE WHEN: you already have session context and need to read or mutate work. Read-only.',
    inputSchema: {
      workspace_id: z.string().optional().describe('Canonical workspace UUID to bind as the active session workspace'),
      conversation_id: z.string().optional().describe('Optional client conversation/session identifier for continuity'),
      client_name: z.string().optional().describe('Optional MCP client name, such as codex, chatgpt, cursor, or claude'),
      timezone: z.string().optional().describe('Optional user timezone for date-sensitive readouts'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Bootstrapping OrgX contract...',
      'openai/toolInvocation/invoked': 'OrgX contract ready',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'orgx_inspect',
    title: 'Inspect OrgX Entity',
    description:
      'Hydrate one OrgX entity with execution context. USE WHEN: the user names a specific task, milestone, initiative, decision, artifact, or plan session and needs details before acting. NEXT: use orgx_act, orgx_attach, or orgx_write if the user asks to change what you inspected. DO NOT USE WHEN: browsing or searching many records; use orgx_search. Read-only.',
    inputSchema: {
      type: z
        .enum(['initiative', 'workstream', 'milestone', 'task', 'decision', 'artifact', 'plan_session'])
        .describe('Entity type to inspect'),
      id: z.string().min(1).describe('Entity UUID or accepted short ID prefix'),
      hydrate_context: z.boolean().optional().describe('Include linked context where available; default true'),
      max_chars: z.number().int().min(1000).max(50000).optional().describe('Approximate maximum hydrated context characters'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
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
      'Find OrgX entities, decisions, artifacts, and memory. USE WHEN: browsing work, searching memory, finding IDs, or listing related records. NEXT: use orgx_inspect for one selected result or orgx_recommend when the user asks what to do next. DO NOT USE WHEN: you already know the exact entity and need full context; use orgx_inspect.',
    inputSchema: {
      query: z.string().optional().describe('Search query for memory or title/text matching'),
      type: z.string().optional().describe('Optional entity type filter, such as task, milestone, decision, artifact, or initiative'),
      status: z.string().optional().describe('Optional status filter'),
      initiative_id: z.string().optional().describe('Optional initiative UUID scope'),
      workspace_id: z.string().optional().describe('Optional workspace UUID scope'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum records to return'),
      fields: z.array(z.string()).optional().describe('Optional compact field list'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.searchResults,
      'openai/toolInvocation/invoking': 'Searching OrgX...',
      'openai/toolInvocation/invoked': 'OrgX search complete',
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.searchResults },
    },
  },
  {
    id: 'orgx_recommend',
    title: 'Recommend Next OrgX Action',
    description:
      'Recommend next work, summarize morning-brief signals, or read prioritization context. USE WHEN: user asks what to do next, wants a brief, or needs priority guidance. NEXT: present the recommendation, then use orgx_act, orgx_write, or orgx_spawn only after the user confirms an action. DO NOT USE WHEN: the user already specified the action; use orgx_act or orgx_write.',
    inputSchema: {
      mode: z.enum(['next_action', 'morning_brief']).optional().describe('Recommendation mode; default next_action'),
      entity_type: z.enum(['workspace', 'initiative', 'workstream', 'milestone', 'task']).optional().describe('Recommendation scope type'),
      entity_id: z.string().optional().describe('Scoped entity ID'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      limit: z.number().int().min(1).max(20).optional().describe('Maximum recommendations'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.morningBrief,
      'openai/toolInvocation/invoking': 'Building OrgX recommendation...',
      'openai/toolInvocation/invoked': 'OrgX recommendation ready',
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.morningBrief },
    },
  },
  {
    id: 'orgx_write',
    title: 'Write OrgX Entity',
    description:
      'Create or update durable OrgX records using canonical snake_case fields.\n\n' +
      'Per-type required fields (operation=create):\n' +
      '  • type="initiative" → REQUIRES title (or name). Recommended: summary, workspace_id, goal_ids (if workspace enforces a primary objective).\n' +
      '  • type="workstream" → REQUIRES title (or name) + initiative_id.\n' +
      '  • type="milestone"  → REQUIRES title (or name) + workstream_id.\n' +
      '  • type="task"       → REQUIRES title (or name) + workstream_id (initiative_id and milestone_id are auto-resolved when present).\n' +
      '  • type="decision"   → REQUIRES title (or name). Recommended: context, initiative_id.\n' +
      '  • type="artifact"   → REQUIRES entity_type + entity_id (or task_id) + artifact_type + one of: artifact_url | external_url | preview_markdown. Recommended: name, description.\n' +
      '  • type="blocker"    → REQUIRES run_id and a description of what is blocking the agent run. Optional: step_id, blocker_type, resolution.\n' +
      '  • type="skill" | "studio_brand" | "studio_content" → REQUIRES title (or name). Other fields vary by subtype (use metadata for sub-type-specific data).\n\n' +
      'Per-operation rules:\n' +
      '  • operation="create" (default) — uses the per-type required fields above.\n' +
      '  • operation="update" — REQUIRES id AND fields (the patch object). Other top-level fields are ignored.\n\n' +
      'USE WHEN: adding or editing a task, milestone, decision, artifact, skill, brand, or content entity. NEXT: use orgx_act when the new or edited record should launch, pause, complete, or validate. DO NOT USE WHEN: changing lifecycle state or attaching proof; use orgx_act or orgx_attach.',
    inputSchema: {
      operation: z.enum(['create', 'update']).optional().describe('Write operation. Defaults to "create". Set "update" (with id + fields) to patch an existing entity.'),
      type: z.string().min(1).describe('Entity type to write: task, milestone, decision, artifact, skill, blocker, studio_brand, studio_content, initiative, workstream, or objective. See top-level description for per-type required fields.'),
      id: z.string().optional().describe('REQUIRED when operation="update". Target entity UUID to patch.'),
      title: z.string().optional().describe('REQUIRED on create (provide either "title" or "name" — they are aliases). Display title of the new entity.'),
      name: z.string().optional().describe('Alternative to "title" on create. REQUIRED on create when "title" is not provided.'),
      summary: z.string().optional().describe('Short description shown in lists and previews. Recommended on create.'),
      description: z.string().optional().describe('Longer-form description used in detail views.'),
      fields: z.record(z.unknown()).optional().describe('REQUIRED when operation="update". Map of entity fields to patch (only include fields you want to change).'),
      initiative_id: z.string().optional().describe('Parent initiative UUID. REQUIRED when type="workstream". Optional context for tasks/milestones/artifacts to associate them with an initiative.'),
      workstream_id: z.string().optional().describe('Parent workstream UUID. REQUIRED when type="milestone" or type="task".'),
      milestone_id: z.string().optional().describe('Optional parent milestone UUID for tasks; auto-resolved server-side from workstream context when omitted.'),
      workspace_id: z.string().optional().describe('Workspace UUID. REQUIRED when the MCP session does not already carry workspace context (resolve via list_entities type=command_center or orgx_inspect type=workspace).'),
      goal_ids: z.array(z.string()).optional().describe('Objective UUIDs for initiative/workstream/milestone/task creation. REQUIRED when the workspace enforces a primary objective. Resolve via orgx_inspect type=objective.'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('Priority. "urgent" is normalized to "high" server-side.'),
      due_date: z.string().optional().describe('Due date as YYYY-MM-DD.'),
      status: z.string().optional().describe('Initial workflow status; common agent aliases such as "active" are normalized per entity type ("active" → "in_progress").'),
      entity_type: z.string().optional().describe('REQUIRED when type="artifact". Entity type to attach the artifact to (initiative, workstream, milestone, task, or decision).'),
      entity_id: z.string().optional().describe('REQUIRED when type="artifact" (unless task_id is provided). UUID of the entity to attach the artifact to.'),
      task_id: z.string().optional().describe('Shortcut for attaching an artifact directly to a task. Use instead of entity_type+entity_id when type="artifact" and the target is a task.'),
      artifact_type: z.string().optional().describe('REQUIRED when type="artifact". Artifact type code (e.g. "eng.demo_report", "proof.link", "doc.spec", "note.text").'),
      artifact_url: z.string().optional().describe('Internal artifact URL (e.g. /api/artifacts/...). One of artifact_url, external_url, or preview_markdown is required when type="artifact".'),
      external_url: z.string().optional().describe('External artifact URL (https://). One of artifact_url, external_url, or preview_markdown is required when type="artifact".'),
      preview_markdown: z.string().optional().describe('Inline markdown preview of artifact content. One of artifact_url, external_url, or preview_markdown is required when type="artifact".'),
      run_id: z.string().optional().describe('REQUIRED when type="blocker". Agent run UUID the blocker applies to.'),
      step_id: z.string().optional().describe('Optional agent run step UUID for blocker creation.'),
      blocker_type: z.string().optional().describe('Blocker category/type when type="blocker" (e.g. "missing_input", "permission", "external_dependency").'),
      resolution: z.string().optional().describe('Blocker resolution text when known. Used to mark a blocker as resolved.'),
      live_visibility: z.enum(['private', 'public']).optional().describe('Initiative live-link visibility. Only applies when type="initiative".'),
      live_public: z.boolean().optional().describe('Shortcut to publish an initiative live link (sets live_visibility="public"). Only applies when type="initiative".'),
      live_reveal_title: z.boolean().optional().describe('When true, public live-link visitors see the initiative title. Only applies when type="initiative" with live_visibility="public".'),
      metadata: z.record(z.unknown()).optional().describe('Free-form object for type-specific metadata. Schema varies per entity type (e.g. for skills: { capabilities, guardrails, channels }; for studio_brand: { tokens, voice, exemplars }).'),
      idempotency_key: z.string().optional().describe('Strongly recommended client-generated idempotency key for safe retries. Same key returns the same result without creating a duplicate.'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier returned by orgx_bootstrap.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Writing OrgX entity...',
      'openai/toolInvocation/invoked': 'OrgX entity written',
    },
  },
  {
    id: 'orgx_attach',
    title: 'Attach OrgX Artifact',
    description:
      'Attach a durable artifact, proof URL, or preview to an existing OrgX entity. USE WHEN: saving evidence, PRs, documents, reports, screenshots, or external artifacts. NEXT: use orgx_submit_receipt to close attribution/quality loops or orgx_act to complete with proof. DO NOT USE WHEN: creating generic entities; use orgx_write.',
    inputSchema: {
      type: lifecycleEntityTypeEnum.describe('Target entity type'),
      id: z.string().min(1).describe('Target entity UUID or short ID prefix'),
      name: z.string().min(1).describe('Artifact title'),
      artifact_type: z.string().min(1).describe('Artifact type code, such as eng.diff_pack'),
      artifact_url: z.string().optional().describe('Internal artifact URL'),
      external_url: z.string().optional().describe('External artifact URL'),
      description: z.string().optional().describe('Artifact description'),
      preview_markdown: z.string().optional().describe('Markdown preview'),
      status: z.enum(['draft', 'in_review', 'approved', 'changes_requested', 'superseded', 'archived']).optional().describe('Artifact workflow status'),
      metadata: z.record(z.unknown()).optional().describe('Artifact metadata'),
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
      'Run lifecycle, validation, completion, delete, dry-run, or proof actions on an existing OrgX entity.\n\n' +
      'Valid (type → action) pairs:\n' +
      '  • initiative → launch | pause | resume | complete | archive | update | delete\n' +
      '  • milestone  → start | complete | flag_risk | cancel | ship_batch | update | delete\n' +
      '  • workstream → start | pause | resume | block | complete | reassign_streams | update | delete\n' +
      '  • task       → start | complete | complete_with_proof | block | unblock | reopen | update | delete\n' +
      '  • objective  → pause | resume | complete | archive | update | delete\n' +
      '  • playbook   → activate | archive | update | delete\n' +
      '  • decision   → approve | decline | supersede | cancel | update | delete\n' +
      '  • studio     → validate (with spec)\n\n' +
      'Per-action input requirements:\n' +
      '  • action=update → REQUIRES the "fields" object with the entity fields to patch.\n' +
      '  • action=complete_with_proof | ship_batch → REQUIRES the "artifact" object describing the proof artifact (artifact_type + url/preview).\n' +
      '  • action=validate (studio) → REQUIRES "spec" object with the studio spec payload to validate.\n' +
      '  • action=block | flag_risk | decline | cancel | delete → "note" is strongly recommended.\n' +
      '  • All lifecycle actions accept "dry_run=true" for a preview where supported.\n\n' +
      'USE WHEN: launching, pausing, completing, validating, deleting, shipping, or changing entity state. NEXT: use orgx_inspect or orgx_search to verify resulting state, then orgx_submit_receipt for durable proof when needed. DO NOT USE WHEN: creating records; use orgx_write.',
    inputSchema: {
      type: lifecycleEntityTypeEnum.describe('Target entity type (initiative, milestone, workstream, task, objective, playbook, decision, or studio).'),
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
      dry_run: z.boolean().optional().describe('Preview risky actions without mutating where supported. Returns the diff/plan without applying.'),
      force: z.boolean().optional().describe('Force action where server supports override semantics (skips pre-flight checks).'),
      spec: z.record(z.unknown()).optional().describe('REQUIRED when action=validate. Spec payload for studio validation (shape varies per studio entity subtype).'),
      artifact: z.record(z.unknown()).optional().describe('REQUIRED when action=complete_with_proof or action=ship_batch. Proof artifact payload. Expected shape: { artifact_type: string (e.g. "eng.demo_report", "proof.link"), artifact_url?: string, external_url?: string, preview_markdown?: string, name?: string, description?: string }.'),
      verification: z.array(z.string()).optional().describe('Optional list of verification evidence URLs/IDs for completion flows.'),
      quality_score: z.number().min(0).max(5).optional().describe('Quality score (0-5) attached to the action when used in proof/completion flows.'),
      idempotency_key: z.string().optional().describe('Optional client-supplied idempotency key for safe retries. Same key returns the same result without re-executing.'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier returned by orgx_bootstrap.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Running OrgX action...',
      'openai/toolInvocation/invoked': 'OrgX action complete',
    },
  },
  {
    id: 'orgx_plan',
    title: 'Manage OrgX Plan Session',
    description:
      'Start, resume, edit, improve, or complete a tracked OrgX planning session.\n\n' +
      'Per-action input requirements:\n' +
      '  • action="start"       → REQUIRES feature_name. Optional: initial_plan (markdown to seed the session).\n' +
      '  • action="resume"      → REQUIRES session_id.\n' +
      '  • action="improve"     → REQUIRES session_id AND plan_content (the current draft to critique).\n' +
      '  • action="record_edit" → REQUIRES session_id AND edit_summary (one-line description of the change).\n' +
      '  • action="complete"    → REQUIRES session_id AND plan_content (the final accepted plan). Optional: attach_to (target entity to link the completed plan to).\n\n' +
      'USE WHEN: work is still in planning or should become executable context. NEXT: use orgx_write or orgx_act after the plan is accepted and needs durable execution state. DO NOT USE WHEN: directly scaffolding a full initiative hierarchy; use scaffold_initiative for that compatibility path.',
    inputSchema: {
      action: z.enum(['start', 'resume', 'improve', 'record_edit', 'complete']).describe('Planning action to perform. See top-level description for per-action required fields.'),
      session_id: z.string().optional().describe('Plan session UUID or orgx://plan_session/<uuid> URI. REQUIRED for action=resume | improve | record_edit | complete. Omit for action=start.'),
      feature_name: z.string().optional().describe('Feature or plan name. REQUIRED when action=start.'),
      initial_plan: z.string().optional().describe('Markdown plan content to seed the new session. Optional on action=start; the session can also be started empty and filled via improve/record_edit.'),
      plan_content: z.string().optional().describe('Current/final plan markdown. REQUIRED when action=improve (the draft to critique) or action=complete (the final accepted plan).'),
      edit_summary: z.string().optional().describe('One-line description of the change being recorded. REQUIRED when action=record_edit.'),
      attach_to: z.record(z.unknown()).optional().describe('Optional target to link the completed plan to when action=complete. Shape: { entity_type: "initiative" | "workstream" | "task", entity_id: string }.'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries. Same key returns the same result without creating duplicate session state.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
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
      'Guard, classify, spawn, or hand off specialist agent work.\n\n' +
      'Per-action input requirements:\n' +
      '  • action="spawn" (default when action omitted) → Spawn from an existing task: REQUIRES task_id. Spawn ad-hoc: REQUIRES title AND instructions (and recommended agent_type).\n' +
      '  • action="handoff"  → REQUIRES task_id AND agent_type (the target agent to hand off to). Optional: instructions to override.\n' +
      '  • action="guard"    → REQUIRES agent_type. Returns whether spawning is permitted under current policy/budget for that agent.\n' +
      '  • action="classify" → REQUIRES title OR task_id. Returns the recommended agent_type and model tier without spawning.\n\n' +
      'USE WHEN: explicitly delegating work to an OrgX agent or checking if delegation is allowed. NEXT: use orgx_inspect or orgx_search to monitor the delegated work, then orgx_submit_receipt for proof. DO NOT USE WHEN: only creating a task row; use orgx_write.',
    inputSchema: {
      action: z.enum(['guard', 'spawn', 'handoff', 'classify']).optional().describe('Spawn operation. Defaults to "spawn". See top-level description for per-action required fields.'),
      title: z.string().optional().describe('Task title. REQUIRED for ad-hoc spawn (action=spawn without task_id) or action=classify without task_id. Used as the human-readable label of the spawned task.'),
      task_id: z.string().optional().describe('Existing task UUID. REQUIRED for action=handoff. REQUIRED for action=spawn when spawning work for an already-created task. Either task_id or title (with instructions) must be provided for action=spawn.'),
      initiative_id: z.string().optional().describe('Optional initiative UUID to scope the spawned task. Inferred from task_id when omitted.'),
      workspace_id: z.string().optional().describe('Optional workspace UUID to scope the spawned task. Defaults to the MCP session\'s workspace.'),
      agent_type: z.string().optional().describe('Target agent type/domain (e.g. "engineering", "marketing", "design"). REQUIRED for action=guard or action=handoff. Strongly recommended for action=spawn so the work routes to the right specialist.'),
      instructions: z.string().optional().describe('Delegation instructions for the agent. REQUIRED for action=spawn when spawning ad-hoc (without task_id). Used to override the task description for action=handoff.'),
      idempotency_key: z.string().optional().describe('Optional client-supplied idempotency key for safe retries. Same key returns the same spawn result without re-running.'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier returned by orgx_bootstrap.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.agentRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Preparing OrgX agent work...',
      'openai/toolInvocation/invoked': 'OrgX agent work ready',
    },
  },
  {
    id: 'orgx_decide',
    title: 'Manage OrgX Decision',
    description:
      'Create, approve, reject, remember, or list durable OrgX decisions.\n\n' +
      'Per-action input requirements:\n' +
      '  • action="list_pending" → No required fields. Optional: initiative_id, workspace_id (scope filters).\n' +
      '  • action="create"       → REQUIRES title AND decision (the resolved decision text). Recommended: context, initiative_id.\n' +
      '  • action="remember"     → REQUIRES decision (the text to capture as a remembered decision). Optional: title, context.\n' +
      '  • action="approve"      → REQUIRES decision_id. Optional: note (free-text approver rationale).\n' +
      '  • action="reject"       → REQUIRES decision_id AND reason (explanation shown to the assigned agent).\n\n' +
      'USE WHEN: capturing judgment, approval, rejection, or pending decision review. NEXT: use orgx_act, orgx_write, or orgx_spawn only after the decision resolves the next action. DO NOT USE WHEN: writing non-decision entities; use orgx_write.',
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
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.decisions,
      'openai/toolInvocation/invoking': 'Updating OrgX decision...',
      'openai/toolInvocation/invoked': 'OrgX decision updated',
      ui: { resourceUri: WIDGET_URIS.decisions },
    },
  },
  {
    id: 'orgx_submit_receipt',
    title: 'Submit OrgX Receipt',
    description:
      'Submit durable proof, attribution, quality, or outcome receipt metadata.\n\n' +
      'Required inputs: receipt_type AND summary.\n' +
      'Strongly recommended: one entity anchor (entity_type + entity_id, OR artifact_id) AND at least one evidence URL inside the evidence object so the receipt is verifiable.\n\n' +
      'Recognized receipt_type values:\n' +
      '  • "proof"      — generic completion proof (e.g. merged PR, deployed change).\n' +
      '  • "outcome"    — measurable result (deal closed, meeting booked, metric delta).\n' +
      '  • "quality"    — review/score receipt (code review, design critique).\n' +
      '  • "attribution"— credit-assignment receipt linking work to revenue/value.\n' +
      '  • "learning"   — distilled lesson or pattern captured from the work.\n\n' +
      'Recognized evidence shapes (all keys optional, mix and match):\n' +
      '  • { prs: string[] }       — GitHub PR URLs.\n' +
      '  • { deploys: string[] }   — deployment URLs / IDs.\n' +
      '  • { test_runs: string[] } — CI run URLs.\n' +
      '  • { metrics: { name: string, value: number, unit?: string }[] } — quantitative outcomes.\n' +
      '  • { links: string[] }     — generic external evidence URLs.\n' +
      '  • { notes: string }       — free-text supporting note.\n\n' +
      'Idempotency: pass idempotency_key when retrying the same logical receipt; the server deduplicates.\n\n' +
      'USE WHEN: closing the loop on agent work with provenance and measurable evidence. NEXT: use orgx_recommend or orgx_search to show the next priority or confirm the updated work graph. DO NOT USE WHEN: merely emitting telemetry; use orgx_emit_activity.',
    inputSchema: {
      workspace_id: z.string().optional().describe('Workspace UUID. Defaults to the MCP session\'s workspace when omitted.'),
      entity_type: z.string().optional().describe('Related entity type (initiative, workstream, milestone, task, decision). Required if no artifact_id is provided — pair with entity_id.'),
      entity_id: z.string().optional().describe('Related entity UUID. Required when entity_type is provided.'),
      receipt_type: z.string().min(1).describe('Receipt category key. Recognized values: "proof", "outcome", "quality", "attribution", "learning". Custom domain-specific keys are also accepted.'),
      summary: z.string().min(1).describe('One-sentence human-readable description of what the receipt proves (e.g. "Merged PR #142 unblocking the auth refactor").'),
      evidence: z.record(z.unknown()).optional().describe('Structured evidence payload. Recognized shapes: { prs: string[] }, { deploys: string[] }, { test_runs: string[] }, { metrics: { name, value, unit? }[] }, { links: string[] }, { notes: string }. See top-level description for full list. At least one verifiable URL is strongly recommended.'),
      artifact_id: z.string().optional().describe('Related artifact UUID to anchor the receipt to. Alternative to entity_type+entity_id when the proof lives in OrgX as an artifact.'),
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
    id: 'orgx_describe_tool',
    title: 'Describe OrgX Tool',
    description:
      'Return the live input contract, auth expectations, and workflow guidance for an OrgX tool. Also known as: tool schema, tool help, contract. USE WHEN: you need exact field names, accepted enums, or next-step guidance before calling a tool. Read-only.',
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
      'Describe lifecycle actions, aliases, and special payload requirements for entity_action. USE WHEN: you need the exact action name or payload shape before calling entity_action. Read-only.',
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
      'Save a decision to organizational memory so agents and teammates can recall it later. Also known as: decision log, team memory, agent memory, record decision, remember what we decided.',
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
      'Search organizational memory for prior decisions, artifacts, project context, and team knowledge. Also known as: search memory, recall decisions, find context, retrieve artifacts, what did we decide.',
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
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
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
      'Review or act on agent decisions awaiting human approval. Also known as: pending approvals, agent blocked, sign off, review decisions, approve AI work.\n\n' +
      'Per-action input requirements:\n' +
      '  • action="list" (default when action omitted) → No required fields. Optional filters: limit, urgency_filter, initiative_id.\n' +
      '  • action="approve" → REQUIRES decision_id. Optional: note (free-text approver rationale).\n' +
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
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
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
      'Assign work to a specialist AI agent and track the result. Also known as: hand this off, spawn agent, assign task, delegate to agent, have an AI agent do it.',
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
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
      'Get health, blockers, milestones, owners, and recent activity for a project or initiative. Also known as: project status, initiative pulse, blockers, roadmap progress, execution health.',
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
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
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
      'Resume a planning session by UUID, orgx:// URI, or most recent active session. Also known as: continue plan, reload planning context. USE WHEN: continuing a planning workflow without guessing IDs.',
    inputSchema: {
      session_id: z
        .string()
        .optional()
        .describe('Plan session UUID or orgx://plan_session/<uuid>'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.authRequired,
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
      'Create an actionable task in organizational memory for a project, milestone, or agent. Also known as: add task, create work item. USE WHEN: adding a single actionable task to a workstream, milestone, or initiative. NEXT: use entity_action action=start when execution should begin.',
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
      'Create a project milestone or phase checkpoint with durable context. Also known as: add milestone, create checkpoint. USE WHEN: adding a phase checkpoint under an initiative or workstream.',
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
      'Record a decision in organizational memory so agents can recall it later. Also known as: remember decision, decision log, team memory. USE WHEN: surfacing a new approval or judgment point for a workspace or initiative.',
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
      'Validate a studio_content entity without composing entity_action manually. USE WHEN: checking a studio content spec before rendering or publication.',
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
      'Pin a workstream to the top of the Next Up queue without composing queue_action manually. USE WHEN: forcing a workstream to the top of the recommendation queue.',
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
  list_entities: {
    id: 'list_entities',
    title: 'List Entities',
    description:
      'Inline worker tool for listing OrgX entities with filtering, pagination, and optional hydration.',
  },
  create_entity: {
    id: 'create_entity',
    title: 'Create Entity',
    description:
      'Inline worker power tool for creating any entity type. Prefer create_task, create_milestone, or create_decision for common flows.',
  },
  update_entity: {
    id: 'update_entity',
    title: 'Update Entity',
    description:
      'Inline worker tool for updating mutable fields on an existing entity.',
  },
  entity_action: {
    id: 'entity_action',
    title: 'Entity Action',
    description:
      'Inline worker tool for lifecycle actions, attachments, and specialized operations like studio validation.',
  },
  scaffold_initiative: {
    id: 'scaffold_initiative',
    title: 'Scaffold Initiative',
    description:
      'Inline worker tool for drafting, creating, or launching a full initiative hierarchy in one call.',
  },
  get_task_with_context: {
    id: 'get_task_with_context',
    title: 'Get Task With Context',
    description:
      'Inline worker tool for loading a task with hydrated decisions, artifacts, entities, and plan-session context.',
  },
  workspace: {
    id: 'workspace',
    title: 'Workspace',
    description:
      'Inline worker tool for creating, listing, reading, and switching workspace context.',
  },
  configure_org: {
    id: 'configure_org',
    title: 'Configure Organization',
    description:
      'Inline worker tool for setup status, agent config, and organization policy changes.',
  },
  stats: {
    id: 'stats',
    title: 'Stats',
    description:
      'Inline worker tool for personal or session usage statistics.',
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
