// =============================================================================
// Eine TSA-Auswahl für alle Worker-Pfade (Tagessiegel, Rolling Anchors,
// Archivsegmente, Kettenprüfung, Restore-Drill).
//
// F-12: audit-rotate wählte die Zeitstempelstelle vorher auf eigenem Weg und
// mit anderer Priorität, und die reine Prüfung lief über denselben
// SSRF-/DNS-Check wie das Stempeln — ein DNS-Ausfall ließ in Produktion die
// Kettenprüfung scheitern, obwohl sie keinen Netzaufruf braucht.
//
// Auflösung (wie Statusprüfung und Admin-UI, docs/development/module/
// audit-protokollierung.md): Tenant-Einstellung `evidence.tsa` → ENV
// TIMESTAMP_AUTHORITY_URL → verifizierter GlobalSign-Default.
//   - 'stamp': die URL muss öffentlich auflösbar sein (SSRF-Schutz vor dem
//     Abruf). Produktion wirft sonst, Entwicklung fällt transparent auf den
//     lokalen Self-Timestamp zurück.
//   - 'verify': in Produktion ohne jeden Netz- oder DNS-Zugriff — geprüft wird
//     ausschließlich kryptografisch gegen die konfigurierten Trust-Roots; der
//     Adapter fragt die URL beim Prüfen nie an. Außerhalb der Produktion bleibt
//     die Prüfung an die Stempel-Entscheidung gekoppelt, damit lokal
//     gestempelte Entwicklungsketten weiter als lokale Evidenz prüfbar sind.
//
// S-01: Die Tenant-Einstellung liest die App-Rolle im SYSTEM-Kontext des
// Tenants (withSystemContext, RLS), auch für die Owner-Wartungsjobs.
// =============================================================================

import { withSystemContext } from '@taxtronik/db';
import { env } from './env';
import { readTenantSettingValue } from '@taxtronik/db/tenant-settings';
import {
  LocalTimestampAdapter,
  createRfc3161Adapter,
  resolveTsaUrl,
  type TimestampPort,
} from '@taxtronik/evidence';
import { assertPublicHost } from './http/ssrf-guard';
import { log } from './logger';

const DEFAULT_TSA_PROVIDER_ID = 'globalsign';

export type TsaPurpose = 'stamp' | 'verify';
export type TsaSource = 'tenant' | 'env' | 'default';

export interface ResolvedTsa {
  port: TimestampPort;
  /** Ausgewählte TSA; der Port kann trotzdem lokal sein (Entwicklung, nicht auflösbar). */
  url: string | null;
  source: TsaSource | null;
}

/** Tenant-Einstellung → ENV → GlobalSign-Default; ohne Netzzugriff. */
export async function selectTsaUrl(
  tenantId: string,
): Promise<{ url: string; source: TsaSource } | null> {
  const stored = (await withSystemContext(tenantId, (tx) =>
    readTenantSettingValue(tx, tenantId, 'evidence.tsa'),
  )) as { providerId?: string | null; customUrl?: string | null } | null | undefined;
  const tenantUrl = stored
    ? resolveTsaUrl(stored.providerId ?? null, stored.customUrl ?? null)
    : null;
  if (tenantUrl) return { url: tenantUrl, source: 'tenant' };
  const envUrl = env.TIMESTAMP_AUTHORITY_URL?.trim();
  if (envUrl) return { url: envUrl, source: 'env' };
  const defaultUrl = resolveTsaUrl(DEFAULT_TSA_PROVIDER_ID, null);
  return defaultUrl ? { url: defaultUrl, source: 'default' } : null;
}

/**
 * Production never falls back to self-time; development may use
 * LocalTimestamp for seals and archives. Rolling anchors refuse local ports
 * themselves.
 */
export async function resolveTsa(tenantId: string, purpose: TsaPurpose): Promise<ResolvedTsa> {
  const selected = await selectTsaUrl(tenantId);
  const production = env.NODE_ENV === 'production';
  if (!selected) {
    if (production) throw new Error('Production erfordert eine externe RFC-3161-TSA.');
    return { port: new LocalTimestampAdapter(), url: null, source: null };
  }
  if (purpose === 'verify' && production) {
    return { port: createRfc3161Adapter(selected.url), ...selected };
  }
  try {
    await assertPublicHost(selected.url, { mode: 'public' });
  } catch (err) {
    if (production) throw err;
    log.warn(
      { tenantId, url: selected.url, purpose, err: (err as Error).message },
      'TSA-URL nicht öffentlich auflösbar — nur Dev-Self-Timestamp verfügbar',
    );
    return { port: new LocalTimestampAdapter(), ...selected };
  }
  return { port: createRfc3161Adapter(selected.url), ...selected };
}

/** Kurzform für Aufrufer, die nur den Port brauchen. */
export async function timestampPortFor(
  tenantId: string,
  purpose: TsaPurpose = 'stamp',
): Promise<TimestampPort> {
  return (await resolveTsa(tenantId, purpose)).port;
}
