function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function pickRecordString(
  record: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = asNonEmptyString(record[key]);
    if (value) return value;
  }
  return null;
}

const AGENT_ID_TO_NAME: Record<string, string> = {
  'product-agent': 'Pace',
  'product-onboarding': 'Pace',
  'engineering-agent': 'Eli',
  'marketing-agent': 'Mark',
  'sales-agent': 'Sage',
  'operations-agent': 'Orion',
  'design-agent': 'Dana',
  'orchestrator-agent': 'Xandy',
  'chatgpt-app': 'OrgX ChatGPT App',
};

const AGENT_KEYWORDS: Array<{ match: string[]; domain: string }> = [
  { match: ['product', 'pace'], domain: 'Product' },
  { match: ['engineer', 'engineering', 'eli'], domain: 'Engineering' },
  { match: ['market', 'marketing', 'mark'], domain: 'Marketing' },
  { match: ['sale', 'sales', 'sage'], domain: 'Sales' },
  { match: ['design', 'dana'], domain: 'Design' },
  { match: ['oper', 'operations', 'orion'], domain: 'Operations' },
  { match: ['orchestr', 'xandy'], domain: 'Orchestrator' },
];

export function inferAgentDomain(values: Array<unknown>): string | null {
  const source = values
    .map((value) => asNonEmptyString(value))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!source) return null;

  for (const candidate of AGENT_KEYWORDS) {
    if (candidate.match.some((token) => source.includes(token))) {
      return candidate.domain;
    }
  }

  return null;
}

export function inferAgentName(values: Array<unknown>): string | null {
  for (const value of values) {
    const key = asNonEmptyString(value);
    if (!key) continue;
    const mapped = AGENT_ID_TO_NAME[key];
    if (mapped) return mapped;
  }
  return null;
}

type DispatchSessionContext = {
  workspaceId?: string;
  workspaceName?: string;
};

type LookupEntity = (
  type: string,
  id: string
) => Promise<Record<string, unknown> | null>;

export async function normalizeAgentDispatchPayload(params: {
  toolId: string;
  args: Record<string, unknown>;
  data: Record<string, unknown>;
  sessionContext?: DispatchSessionContext | null;
  lookupEntity?: LookupEntity;
}): Promise<Record<string, unknown>> {
  if (
    params.toolId !== 'spawn_agent_task' &&
    params.toolId !== 'handoff_task'
  ) {
    return params.data;
  }

  const next = { ...params.data };
  const lookupEntity = params.lookupEntity;
  const sessionContext = params.sessionContext ?? {};

  const agentId =
    pickRecordString(next, ['agent_id']) ??
    asNonEmptyString(params.args.agent) ??
    asNonEmptyString(next.agent);
  const agentName =
    pickRecordString(next, ['agent_name']) ?? inferAgentName([agentId]);
  const domain =
    pickRecordString(next, ['domain']) ??
    inferAgentDomain([
      next.domain,
      next.agent_name,
      next.agent_id,
      params.args.agent,
      next.agent,
    ]);

  if (agentId && !pickRecordString(next, ['agent_id'])) {
    next.agent_id = agentId;
  }
  if (agentName && !pickRecordString(next, ['agent_name'])) {
    next.agent_name = agentName;
  }
  if (domain && !pickRecordString(next, ['domain'])) {
    next.domain = domain;
  }

  let workspaceId =
    pickRecordString(next, ['workspace_id', 'command_center_id']) ??
    pickRecordString(params.args, ['workspace_id', 'command_center_id']);
  let workspaceName =
    pickRecordString(next, ['workspace_name', 'command_center_name']) ?? null;
  let initiativeId =
    pickRecordString(next, ['initiative_id']) ??
    pickRecordString(params.args, ['initiative_id']);

  const taskId =
    pickRecordString(next, ['task_id']) ?? pickRecordString(params.args, ['task_id']);

  if (!workspaceId && taskId && lookupEntity) {
    const task = await lookupEntity('task', taskId);
    if (task) {
      workspaceId = pickRecordString(task, ['workspace_id', 'command_center_id']);
      initiativeId = initiativeId ?? pickRecordString(task, ['initiative_id']);
    }
  }

  if ((!workspaceId || !workspaceName) && initiativeId && lookupEntity) {
    const initiative = await lookupEntity('initiative', initiativeId);
    if (initiative) {
      workspaceId =
        workspaceId ??
        pickRecordString(initiative, ['workspace_id', 'command_center_id']);
      if (!pickRecordString(next, ['initiative_name'])) {
        const initiativeName = pickRecordString(initiative, ['name', 'title']);
        if (initiativeName) {
          next.initiative_name = initiativeName;
        }
      }
    }
  }

  if (
    !workspaceId &&
    sessionContext.workspaceId &&
    (!initiativeId || initiativeId === pickRecordString(next, ['initiative_id']))
  ) {
    workspaceId = sessionContext.workspaceId;
  }

  if (!workspaceName && workspaceId && lookupEntity) {
    const workspace = await lookupEntity('command_center', workspaceId);
    workspaceName = workspace
      ? pickRecordString(workspace, ['name', 'title'])
      : null;
  }

  if (
    !workspaceName &&
    workspaceId &&
    sessionContext.workspaceId === workspaceId &&
    sessionContext.workspaceName
  ) {
    workspaceName = sessionContext.workspaceName;
  }

  if (!workspaceName && !workspaceId && sessionContext.workspaceName) {
    workspaceName = sessionContext.workspaceName;
    workspaceId = sessionContext.workspaceId ?? workspaceId;
  }

  if (workspaceId && !pickRecordString(next, ['workspace_id'])) {
    next.workspace_id = workspaceId;
  }
  if (workspaceId && !pickRecordString(next, ['command_center_id'])) {
    next.command_center_id = workspaceId;
  }
  if (workspaceName && !pickRecordString(next, ['workspace_name'])) {
    next.workspace_name = workspaceName;
  }

  return next;
}
