// Single source of truth for roles a tenant admin may assign to team
// members. Deliberately EXCLUDES the platform-operator roles
// (SUPER_ADMIN, MANAGER): isPlatformOperator() grants cross-account
// access, so letting any tenant surface assign them defeats every
// tenant guard in the app (leak-audit finding 5-1). Shared between the
// invite route and PATCH /api/team/[id] so the two cannot drift.
export const ASSIGNABLE_TEAM_ROLES = [
  'ADMIN',
  'CLOSER',
  'SETTER',
  'READ_ONLY'
] as const;

export type AssignableTeamRole = (typeof ASSIGNABLE_TEAM_ROLES)[number];

export function isAssignableTeamRole(
  value: unknown
): value is AssignableTeamRole {
  return (
    typeof value === 'string' &&
    (ASSIGNABLE_TEAM_ROLES as readonly string[]).includes(value)
  );
}
