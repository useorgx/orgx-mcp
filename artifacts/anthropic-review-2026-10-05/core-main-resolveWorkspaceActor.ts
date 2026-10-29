import type { SupabaseClient } from '@supabase/supabase-js';

export type WorkspaceActorRole =
  | 'owner'
  | 'admin'
  | 'member'
  | 'project_owner'
  | 'project_editor'
  | 'project_viewer'
  | 'none';

export interface WorkspaceActorAccess {
  role: WorkspaceActorRole;
  workspaceRole: 'owner' | 'admin' | 'member' | 'none';
  projectRole: 'owner' | 'editor' | 'viewer' | 'none';
  isWorkspaceMember: boolean;
  isProjectMember: boolean;
  canReadWorkspace: boolean;
  canReview: boolean;
  canOperateProject: boolean;
  canApproveConsequentialActions: boolean;
}

type ActorAdmin = SupabaseClient<any>;

const NO_ACCESS: WorkspaceActorAccess = {
  role: 'none',
  workspaceRole: 'none',
  projectRole: 'none',
  isWorkspaceMember: false,
  isProjectMember: false,
  canReadWorkspace: false,
  canReview: false,
  canOperateProject: false,
  canApproveConsequentialActions: false,
};

export function deriveWorkspaceActorAccess(input: {
  workspaceOwner: boolean;
  organizationRole?: 'owner' | 'admin' | 'member' | null;
  projectOwner?: boolean;
  projectRole?: 'owner' | 'editor' | 'viewer' | null;
}): WorkspaceActorAccess {
  const workspaceRole = input.workspaceOwner
    ? 'owner'
    : input.organizationRole ?? 'none';
  // A Project owner inherits Workspace authority only when the database also
  // proves Workspace membership. This is defense in depth for legacy or
  // partially migrated rows; explicit Project collaborators remain valid.
  const projectRole =
    input.projectOwner && workspaceRole !== 'none'
      ? 'owner'
      : input.projectRole ?? 'none';
  const isWorkspaceMember = workspaceRole !== 'none';
  const isProjectMember = projectRole !== 'none';
  const canOperateProject =
    projectRole === 'owner' ||
    projectRole === 'editor' ||
    workspaceRole === 'owner' ||
    workspaceRole === 'admin';
  const canApproveConsequentialActions =
    workspaceRole === 'owner' || workspaceRole === 'admin';
  const role: WorkspaceActorRole =
    workspaceRole !== 'none'
      ? workspaceRole
      : projectRole === 'owner'
      ? 'project_owner'
      : projectRole === 'editor'
      ? 'project_editor'
      : projectRole === 'viewer'
      ? 'project_viewer'
      : 'none';

  return {
    role,
    workspaceRole,
    projectRole,
    isWorkspaceMember,
    isProjectMember,
    canReadWorkspace: isWorkspaceMember || isProjectMember,
    canReview:
      isWorkspaceMember || projectRole === 'owner' || projectRole === 'editor',
    canOperateProject,
    canApproveConsequentialActions,
  };
}

/**
 * Resolve the authenticated actor against durable tenant membership.
 *
 * This deliberately fails closed. A signed-in user is not a workspace
 * contributor merely because an initiative or proof surface is public.
 */
export async function resolveWorkspaceActor(input: {
  admin: ActorAdmin;
  userId: string | null | undefined;
  workspaceId: string | null | undefined;
  projectId?: string | null;
}): Promise<WorkspaceActorAccess> {
  const { admin, userId, workspaceId, projectId = null } = input;
  if (!userId || !workspaceId) return NO_ACCESS;

  const { data: workspace, error: workspaceError } = await admin
    .from('workspaces')
    .select('id,owner_id,org_id')
    .eq('id', workspaceId)
    .maybeSingle();
  if (workspaceError || !workspace) return NO_ACCESS;

  const workspaceOwner = workspace.owner_id === userId;
  let organizationRole: 'owner' | 'admin' | 'member' | null = null;
  if (!workspaceOwner && workspace.org_id) {
    const { data: membership, error: membershipError } = await admin
      .from('org_members')
      .select('role')
      .eq('org_id', workspace.org_id)
      .eq('user_id', userId)
      .maybeSingle();
    if (membershipError) return NO_ACCESS;
    if (
      membership?.role === 'owner' ||
      membership?.role === 'admin' ||
      membership?.role === 'member'
    ) {
      organizationRole = membership.role;
    }
  }

  let projectOwner = false;
  let projectRole: 'owner' | 'editor' | 'viewer' | null = null;
  if (projectId) {
    const { data: project, error: projectError } = await admin
      .from('projects')
      .select('id,owner_id,workspace_id')
      .eq('id', projectId)
      .maybeSingle();
    if (projectError || !project || project.workspace_id !== workspaceId) {
      return NO_ACCESS;
    }
    projectOwner = project.owner_id === userId;
    if (!projectOwner) {
      const { data: collaborator, error: collaboratorError } = await admin
        .from('project_collaborators')
        .select('role,joined_at')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .not('joined_at', 'is', null)
        .maybeSingle();
      if (collaboratorError) return NO_ACCESS;
      if (
        collaborator?.role === 'owner' ||
        collaborator?.role === 'editor' ||
        collaborator?.role === 'viewer'
      ) {
        projectRole = collaborator.role;
      }
    }
  }

  return deriveWorkspaceActorAccess({
    workspaceOwner,
    organizationRole,
    projectOwner,
    projectRole,
  });
}
