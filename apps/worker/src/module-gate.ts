import {
  readBooleanTenantModules,
  type BooleanTenantModuleKey,
  type BooleanTenantModules,
} from '@taxtronik/db/tenant-modules';
import { prismaOwner } from './prisma-owner';

export function readWorkerTenantModules(tenantId: string): Promise<BooleanTenantModules> {
  return readBooleanTenantModules(prismaOwner, tenantId);
}

export async function isWorkerTenantModuleEnabled(
  tenantId: string,
  module: BooleanTenantModuleKey,
): Promise<boolean> {
  return (await readWorkerTenantModules(tenantId))[module];
}
