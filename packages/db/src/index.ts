// =============================================================================
// @taxtronik/db — Public API
// =============================================================================

export { prisma, type PrismaClient } from './client';
export { prismaOwner } from './owner-client';
export {
  withTenantContext,
  withSystemContext,
  TX_OPTIONS,
  type TenantContext,
  type ActorType,
  type TxClient,
} from './tenant-context';
export * from '@prisma/client';
