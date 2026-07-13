export function matchesSingleTenantBackupScope(
  tenantIds: readonly string[],
  requestedTenantId: string,
): boolean {
  return tenantIds.length === 1 && tenantIds[0] === requestedTenantId;
}
