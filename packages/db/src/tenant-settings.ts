import type { Prisma } from '@prisma/client';

/**
 * Kleinster gemeinsamer Persistenzbaustein fuer `tenant_setting`.
 *
 * Der Aufrufer bleibt fuer Tenant-Kontext/RLS, Validierung, Normalisierung und
 * gegebenenfalls Verschluesselung verantwortlich. Hier wird ausschliesslich
 * das immer gleiche zusammengesetzte Key-/Upsert-Protokoll gekapselt.
 */
export interface TenantSettingReader {
  tenantSetting: {
    findUnique(args: {
      where: { tenantId_key: { tenantId: string; key: string } };
      select: { value: true };
    }): Promise<{ value: unknown } | null>;
  };
}

export interface TenantSettingWriter {
  tenantSetting: {
    upsert(args: {
      where: { tenantId_key: { tenantId: string; key: string } };
      create: {
        tenantId: string;
        key: string;
        value: Prisma.InputJsonValue;
        updatedBy?: string;
      };
      update: { value: Prisma.InputJsonValue; updatedBy?: string };
    }): Promise<unknown>;
  };
}

export interface TenantSettingDeleter {
  tenantSetting: {
    deleteMany(args: { where: { tenantId: string; key: string } }): Promise<unknown>;
  };
}

export type TenantSettingDb = TenantSettingReader & TenantSettingWriter & TenantSettingDeleter;

export async function readTenantSettingValue(
  db: TenantSettingReader,
  tenantId: string,
  key: string,
): Promise<unknown | undefined> {
  const row = await db.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key } },
    select: { value: true },
  });
  return row?.value;
}

export interface WriteTenantSettingInput {
  tenantId: string;
  key: string;
  /** Domain interfaces are accepted after their owning module normalized them. */
  value: Prisma.InputJsonValue | object;
  updatedBy?: string | null;
}

export async function writeTenantSettingValue(
  db: TenantSettingWriter,
  input: WriteTenantSettingInput,
): Promise<void> {
  const updatedBy = input.updatedBy ?? undefined;
  const value = input.value as Prisma.InputJsonValue;
  await db.tenantSetting.upsert({
    where: { tenantId_key: { tenantId: input.tenantId, key: input.key } },
    create: {
      tenantId: input.tenantId,
      key: input.key,
      value,
      updatedBy,
    },
    update: { value, updatedBy },
  });
}

export async function deleteTenantSettingValue(
  db: TenantSettingDeleter,
  tenantId: string,
  key: string,
): Promise<void> {
  await db.tenantSetting.deleteMany({ where: { tenantId, key } });
}
