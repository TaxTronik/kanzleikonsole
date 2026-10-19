// =============================================================================
// tcms-nachrichten-zustellen — Worker-Verdrahtung der Zustellung des
// Postausgangs des Tax-CMS (TCMS Stufe 4; Kern in ./tcms-nachrichten.ts).
//
// Minütlich wie mail-outbox-deliver. Owner-Client für Tenantliste, Lease und
// Zustellzeilen (die App-Rolle hat auf tcms_systemakteur und
// tcms_nachricht_zustellung bewusst keine Rechte: Systemakteur und
// Koordination gehören allein dem Worker); Prüfung und Einplanung in einer
// Tenant-Transaktion (withWorkerTenantContext) wie die Zustandswechsel der
// Mail-Outbox. Nach neuen Mails wird mail-outbox-deliver angestoßen.
// =============================================================================

import { portalBaseUrl } from '@taxtronik/config';
import { JOB_QUEUES, MAIL_OUTBOX_KICK_JOB_OPTIONS } from '@taxtronik/config/job-queues';
import { createWorker } from '../worker-factory';
import { connection, queues } from '../queues';
import { log } from '../logger';
import { isWorkerTcmsActive } from '../module-gate';
import { notify } from '../notify';
import { prismaOwner } from '../prisma-owner';
import { tcmsPostausgang } from '../tcms/dienst';
import { withWorkerTenantContext } from '../tenant-context';
import { stelleTcmsNachrichtenZu, type TcmsZustellDeps } from './tcms-nachrichten';

export function tcmsZustellDeps(): TcmsZustellDeps {
  return {
    db: prismaOwner,
    runAtomic: (tenantId, fn) => withWorkerTenantContext(tenantId, fn),
    istAktiv: isWorkerTcmsActive,
    postausgang: tcmsPostausgang,
    notify: (tx, input, options) => notify(tx, input, options),
    kickMail: () => {
      queues.mailOutboxDeliver
        .add('kick', {}, { ...MAIL_OUTBOX_KICK_JOB_OPTIONS })
        .catch((error: unknown) =>
          log.warn(
            { errName: error instanceof Error ? error.name : 'unbekannt' },
            'tcms-nachrichten: Anstoß der Mail-Outbox gescheitert (Minutentakt holt nach)',
          ),
        );
    },
    portalBaseUrl,
    log,
  };
}

export const tcmsNachrichtenZustellenWorker = createWorker(
  JOB_QUEUES.tcmsNachrichtenZustellen.name,
  async () => {
    const ergebnis = await stelleTcmsNachrichtenZu(tcmsZustellDeps());
    if (ergebnis.abgerufen > 0 || ergebnis.fehler > 0 || ergebnis.bereinigt > 0) {
      log.info({ ...ergebnis }, 'tcms-nachrichten-zustellen: done');
    }
    // Nur Zähler: Job-Ergebnisse liegen in Redis.
    return ergebnis;
  },
  { connection, concurrency: 1 },
);
