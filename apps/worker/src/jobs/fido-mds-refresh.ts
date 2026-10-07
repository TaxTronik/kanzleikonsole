// =============================================================================
// fido-mds-refresh (P-23)
//
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Lädt alle 20 Minuten den signierten FIDO-MDS-BLOB, prüft ihn vollständig
// (fido-mds-verify.ts: Signer-Identität, JWT-Signatur, Zertifikatskette, CRL,
// Serie, nextUpdate; 30 s Zeitlimit) und legt die geprüften Einträge im
// owner-only Anker fido_mds_trust_state ab. Die Serie wird dabei monoton
// verankert; ein älterer BLOB scheitert, ohne den Stand zu verändern.
//
// Hardware-Anmeldung, -Registrierung und Modus-Assertions der Web-App lesen
// nur diesen Stand und sperren fail-closed, wenn die letzte erfolgreiche
// Prüfung älter als eine Stunde ist oder nextUpdate erreicht ist. Zwei
// verpasste Läufe bleiben damit folgenlos; ein dauerhaft fehlschlagender Job
// erscheint auf der Admin-Seite „Jobs“ als veraltet.
//
// Ist der Hardware-Zugang zentral deaktiviert (WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST
// leer oder mit Null-AAGUID), ruft der Job den Metadata Service nicht ab.
//
// S-01: Globaler, mandantenfreier Stand ohne App-Tabellenrechte: der Job
// schreibt ihn über den Owner-Client.
// =============================================================================

import { createHash } from 'node:crypto';
import { env } from '../env';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { storeFidoMdsSnapshot } from '@taxtronik/db/fido-mds-snapshot';
import { connection } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { createWorker } from '../worker-factory';
import { downloadVerifiedFidoMetadata } from './fido-mds-verify';

const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';

export type FidoMdsRefreshResult =
  | { status: 'disabled' }
  | { status: 'stored' | 'unchanged'; serial: number; nextUpdate: string; entries: number };

/** Gleiche Regel wie configuredHardwarePolicy() der Web-App. */
export function hardwareAccessEnabled(): boolean {
  const configured = env.WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST;
  return configured.length > 0 && !configured.includes(ZERO_AAGUID);
}

export async function runFidoMdsRefresh(): Promise<FidoMdsRefreshResult> {
  if (!hardwareAccessEnabled()) {
    log.debug(
      { queue: JOB_QUEUES.fidoMdsRefresh.name },
      'fido-mds-refresh: Hardware-Zugang deaktiviert, kein MDS-Abruf',
    );
    return { status: 'disabled' };
  }
  const metadata = await downloadVerifiedFidoMetadata();
  const blobSha256 = createHash('sha256').update(metadata.blob, 'utf8').digest('hex');
  const status = await storeFidoMdsSnapshot(prismaOwner, {
    serial: metadata.serial,
    nextUpdate: metadata.nextUpdate,
    blobSha256,
    entries: metadata.entries,
  });
  const result = {
    status,
    serial: metadata.serial,
    nextUpdate: metadata.nextUpdate.toISOString().slice(0, 10),
    entries: metadata.entries.length,
  } as const;
  if (status === 'stored') {
    log.info(result, 'fido-mds-refresh: neuer geprüfter MDS-Stand gespeichert');
  } else {
    log.debug(result, 'fido-mds-refresh: MDS-Stand unverändert, Prüfzeitpunkt erneuert');
  }
  return result;
}

export const fidoMdsRefreshWorker = createWorker<Record<string, never>>(
  JOB_QUEUES.fidoMdsRefresh.name,
  async () => {
    await runFidoMdsRefresh();
  },
  { connection, concurrency: 1 },
);
