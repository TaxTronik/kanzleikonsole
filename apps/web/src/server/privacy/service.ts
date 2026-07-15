// =============================================================================
// Privacy-Service — Volltext-Rendering pro Tenant + Consent-Zugriff.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import {
  isPrivacyConfigComplete,
  readPrivacyConfigTx,
  renderPrivacyNotice,
  PRIVACY_NOTICE_VERSION,
} from './notice';
import { parseConsent, type ConsentSelections } from './consent';

/** Ergebnis eines Renderings: Volltext + zugehörige Standardtext-Version. */
export interface RenderedNotice {
  version: number;
  body: string;
  /** Pflichtangaben sind vollständig und der Hinweis darf bestätigt werden. */
  complete: boolean;
}

/**
 * Rendert die Datenschutzhinweise für den aktuellen Tenant: lädt Kanzlei-Config,
 * Tenant-Name und die DSGVO-relevanten Dienstleister (ServiceProvider mit
 * Datenzugriff) und baut den Volltext. Läuft auf einer bestehenden Tenant-Tx.
 */
export async function renderNoticeForTenantTx(
  tx: TxClient,
  tenantId: string,
): Promise<RenderedNotice> {
  const [config, tenant, providers] = await Promise.all([
    readPrivacyConfigTx(tx, tenantId),
    tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    tx.serviceProvider.findMany({
      where: { hasDataAccess: true },
      select: { name: true, category: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  const body = renderPrivacyNotice({
    kanzleiName: tenant?.name ?? 'Kanzlei',
    config,
    providers,
  });
  return { version: PRIVACY_NOTICE_VERSION, body, complete: isPrivacyConfigComplete(config) };
}

/** Aktueller (neuester) Einwilligungsstand eines Mandanten oder null. */
export interface ConsentState {
  id: string;
  consents: ConsentSelections;
  noticeVersion: number;
  signedByName: string;
  source: string;
  isRevocation: boolean;
  createdAt: Date;
}

export async function latestConsentTx(
  tx: TxClient,
  clientId: string,
): Promise<ConsentState | null> {
  const row = await tx.clientConsent.findFirst({
    where: { clientId },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return null;
  return {
    id: row.id,
    consents: parseConsent(row.consents),
    noticeVersion: row.noticeVersion,
    signedByName: row.signedByName,
    source: row.source,
    isRevocation: row.isRevocation,
    createdAt: row.createdAt,
  };
}
