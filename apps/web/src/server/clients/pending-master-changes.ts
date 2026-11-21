import { clientAccessFilter, type ClientAccessWhere } from '@/server/auth/client-access-filter';

export function pendingMasterChangesWhere(access: ClientAccessWhere | undefined) {
  return { status: 'PENDING' as const, ...clientAccessFilter(access) };
}
