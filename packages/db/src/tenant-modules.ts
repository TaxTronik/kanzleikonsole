export const BOOLEAN_MODULE_KEYS = [
  'bwa',
  'knowledge',
  'timeTracking',
  'phoneNotes',
  'taxNotices',
  'workflows',
  'forms',
  'reminders',
  'binders',
  'handovers',
  'appointments',
  'rssReader',
  'inboundMail',
  'risk',
  'signalEngine',
] as const;

export type BooleanTenantModuleKey = (typeof BOOLEAN_MODULE_KEYS)[number];
export type BooleanTenantModules = Record<BooleanTenantModuleKey, boolean>;

export const DEFAULT_BOOLEAN_TENANT_MODULES: BooleanTenantModules = {
  bwa: true,
  knowledge: true,
  timeTracking: true,
  phoneNotes: true,
  taxNotices: true,
  workflows: true,
  forms: true,
  reminders: true,
  binders: true,
  handovers: true,
  appointments: true,
  rssReader: true,
  inboundMail: false,
  risk: false,
  signalEngine: false,
};

export function parseBooleanTenantModules(value: unknown): BooleanTenantModules {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const modules = { ...DEFAULT_BOOLEAN_TENANT_MODULES };
  for (const key of BOOLEAN_MODULE_KEYS) {
    if (typeof record[key] === 'boolean') modules[key] = record[key];
  }
  return modules;
}

export interface TenantModuleSettingReader {
  tenantSetting: {
    findUnique(args: {
      where: { tenantId_key: { tenantId: string; key: string } };
      select: { value: true };
    }): Promise<{ value: unknown } | null>;
  };
}

/** Gemeinsamer Read-Pfad für Web und Worker (tenant_setting.modules). */
export async function readBooleanTenantModules(
  db: TenantModuleSettingReader,
  tenantId: string,
): Promise<BooleanTenantModules> {
  const row = await db.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: 'modules' } },
    select: { value: true },
  });
  return parseBooleanTenantModules(row?.value);
}
