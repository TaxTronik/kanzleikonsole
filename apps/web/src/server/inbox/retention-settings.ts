import type { TenantContext, TxClient } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import { readTenantSettingValue, writeTenantSettingValue } from '@taxtronik/db/tenant-settings';

// Fachkatalog: DSGVO-OPERATIONAL-RETENTION-001,
// PORTAL-INBOX-SUBMISSION-001 (Entwurf). Dies sind konfigurierbare
// Betriebswerte, ausdrücklich keine gesetzlichen Aufbewahrungsfristen.

const KEY = 'portal_inbox.retention';

export interface PortalInboxRetentionConfig {
  messageRetentionDays: number;
  organizationallyDocumented: boolean;
}

export const DEFAULT_PORTAL_INBOX_RETENTION: PortalInboxRetentionConfig = {
  messageRetentionDays: 365,
  organizationallyDocumented: false,
};

function normalize(value: unknown): PortalInboxRetentionConfig {
  const stored =
    value !== null && typeof value === 'object'
      ? (value as Partial<PortalInboxRetentionConfig>)
      : {};
  const days = Number(stored.messageRetentionDays);
  return {
    messageRetentionDays:
      Number.isSafeInteger(days) && days >= 30 && days <= 3650
        ? days
        : DEFAULT_PORTAL_INBOX_RETENTION.messageRetentionDays,
    organizationallyDocumented: stored.organizationallyDocumented === true,
  };
}

export async function readPortalInboxRetention(
  context: TenantContext,
): Promise<PortalInboxRetentionConfig> {
  return withTenantContext(context, async (tx) =>
    normalize(await readTenantSettingValue(tx, context.tenantId, KEY)),
  );
}

export async function writePortalInboxRetention(
  context: TenantContext,
  config: PortalInboxRetentionConfig,
): Promise<void> {
  await withTenantContext(context, (tx) =>
    writePortalInboxRetentionTx(tx, context.tenantId, context.actorId, config),
  );
}

export async function writePortalInboxRetentionTx(
  tx: TxClient,
  tenantId: string,
  updatedBy: string | null,
  config: PortalInboxRetentionConfig,
): Promise<void> {
  await writeTenantSettingValue(tx, {
    tenantId,
    key: KEY,
    value: normalize(config),
    updatedBy,
  });
}
