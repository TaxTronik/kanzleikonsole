// =============================================================================
// update-check-Worker (P-21)
//
// Ruft das signierte Update-Manifest ab (Signatur, Schema, Größen- und
// Zeitgrenzen in @taxtronik/config/update-manifest) und speichert ein kompaktes
// Ergebnis mit Prüfzeitpunkt je Tenant. Die Admin-Übersicht liest nur dieses
// Ergebnis; in abgeschotteten Kanzleinetzen wartet damit kein Seitenaufruf mehr
// auf den 15-s-Timeout. Ein nicht erreichbarer Server ist ein gespeichertes
// Ergebnis (ok=false), kein Job-Fehler.
//
// S-01: Das Ergebnis schreibt der Job je Tenant über die App-Rolle im
// SYSTEM-Kontext des Tenants (withSystemContext, RLS).
// =============================================================================

import { createWorker } from '../worker-factory';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import {
  checkForUpdates,
  toPersistedUpdateCheck,
  UPDATE_CHECK_RESULT_SETTING_KEY,
  type CheckResult,
  type PersistedUpdateCheck,
} from '@taxtronik/config/update-manifest';
import { withSystemContext } from '@taxtronik/db';
import { writeTenantSettingValue } from '@taxtronik/db/tenant-settings';
import { safeFetch } from '../http/ssrf-guard';
import { connection } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';

export interface UpdateCheckDeps {
  check: () => Promise<CheckResult>;
  tenantIds: () => Promise<string[]>;
  store: (tenantId: string, result: PersistedUpdateCheck) => Promise<void>;
  now: () => Date;
}

/** Speichert das Ergebnis eines Tenants (App-Rolle, SYSTEM-Kontext des Tenants). */
export function storeUpdateCheckResult(
  tenantId: string,
  result: PersistedUpdateCheck,
): Promise<void> {
  return withSystemContext(tenantId, (tx) =>
    writeTenantSettingValue(tx, {
      tenantId,
      key: UPDATE_CHECK_RESULT_SETTING_KEY,
      value: result,
    }),
  );
}

const defaultDeps: UpdateCheckDeps = {
  // Die installierte Version vergleicht die Web-App selbst (gespeichert wird
  // nur die geprüfte Versionsliste), daher hier der neutrale Vergleichswert.
  // safeFetch nutzt die Policy `public` (SSRF-Guard).
  check: () => checkForUpdates('0.0.0', (url, init) => safeFetch(url, init)),
  // S-01: Die mandantenübergreifende Tenant-Liste (nur IDs) liest der Owner-Client.
  tenantIds: async () =>
    (await prismaOwner.tenant.findMany({ select: { id: true } })).map((tenant) => tenant.id),
  store: storeUpdateCheckResult,
  now: () => new Date(),
};

export async function runUpdateCheck(
  deps: UpdateCheckDeps = defaultDeps,
): Promise<PersistedUpdateCheck> {
  const result = await deps.check().catch(
    (error: unknown): CheckResult => ({
      ok: false,
      error: `Update-Prüfung fehlgeschlagen: ${(error as Error).message}`,
    }),
  );
  const persisted = toPersistedUpdateCheck(result, deps.now());
  const tenantIds = await deps.tenantIds();
  for (const tenantId of tenantIds) await deps.store(tenantId, persisted);
  log.info(
    {
      ok: persisted.ok,
      versions: persisted.versions?.length ?? 0,
      tenants: tenantIds.length,
      ...(persisted.error ? { error: persisted.error } : {}),
    },
    'update-check: Ergebnis gespeichert',
  );
  return persisted;
}

export const updateCheckWorker = createWorker(
  JOB_QUEUES.updateCheck.name,
  async () => {
    await runUpdateCheck();
  },
  { connection, concurrency: 1 },
);
