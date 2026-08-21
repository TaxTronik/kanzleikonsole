// =============================================================================
// One TSA selection path for daily seals and rolling anchors.
// =============================================================================

import { env } from '@taxtronik/config';
import {
  LocalTimestampAdapter,
  createRfc3161Adapter,
  resolveTsaUrl,
  type TimestampPort,
} from '@taxtronik/evidence';
import { prismaOwner } from './prisma-owner';
import { assertPublicHost } from './http/ssrf-guard';
import { log } from './logger';

const DEFAULT_TSA_PROVIDER_ID = 'globalsign';

/**
 * Tenant setting → ENV → verified GlobalSign default. Production never falls
 * back to self-time; development may use LocalTimestamp only for the legacy
 * daily-seal flow. Rolling anchors explicitly refuse local ports.
 */
export async function timestampPortFor(tenantId: string): Promise<TimestampPort> {
  const row = await prismaOwner.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: 'evidence.tsa' } },
    select: { value: true },
  });
  if (row) {
    const value = row.value as { providerId?: string; customUrl?: string };
    const url = resolveTsaUrl(value.providerId || DEFAULT_TSA_PROVIDER_ID, value.customUrl ?? null);
    if (url) return checkedPort(url, { tenantId });
  }

  const fallbackUrl = env.TIMESTAMP_AUTHORITY_URL ?? resolveTsaUrl(DEFAULT_TSA_PROVIDER_ID, null);
  if (fallbackUrl) return checkedPort(fallbackUrl, {});
  if (env.NODE_ENV === 'production') {
    throw new Error('Production erfordert eine externe RFC-3161-TSA.');
  }
  return new LocalTimestampAdapter();
}

async function checkedPort(url: string, context: { tenantId?: string }): Promise<TimestampPort> {
  try {
    await assertPublicHost(url);
  } catch (err) {
    if (env.NODE_ENV === 'production') throw err;
    log.warn(
      { ...context, url, err: (err as Error).message },
      'TSA-URL nicht öffentlich auflösbar — nur Dev-Self-Timestamp verfügbar',
    );
    return new LocalTimestampAdapter();
  }
  return createRfc3161Adapter(url);
}
