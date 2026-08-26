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
  type TenantTransactionOptions,
} from './tenant-context';
export { Prisma } from './prisma-client';
export {
  BOOLEAN_MODULE_KEYS,
  DEFAULT_BOOLEAN_TENANT_MODULES,
  parseBooleanTenantModules,
  readBooleanTenantModules,
  type BooleanTenantModuleKey,
  type BooleanTenantModules,
  type TenantModuleSettingReader,
} from './tenant-modules';
export {
  deleteTenantSettingValue,
  readTenantSettingValue,
  writeTenantSettingValue,
  type TenantSettingDb,
  type TenantSettingDeleter,
  type TenantSettingReader,
  type TenantSettingWriter,
  type WriteTenantSettingInput,
} from './tenant-settings';
export type * from '@prisma/client';
