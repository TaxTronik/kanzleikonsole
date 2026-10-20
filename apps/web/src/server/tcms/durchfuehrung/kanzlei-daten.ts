// =============================================================================
// Daten der kanzleikonsole zur Durchführungsseite (TCMS Stufe 3, Bereich C):
// Abgleich der Nachweise mit der Ablage, wählbare Dokumente und die
// Berufsträger des Mandanten (nur Anzeige: Eskalation, Gegenzeichnung durch
// die Kanzlei). Läuft in der kurzen Tenant-Transaktion der Seite
// (tcmsTenantLesen), nie um einen Dienstaufruf herum.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import type { DurchfuehrungDetail } from '@taxtronik/tcms-contract';
import {
  nachweisAblageStandTx,
  nachweisDokumenteTx,
  type NachweisAbgleich,
  type NachweisBezug,
  type NachweisDokumentWahl,
} from './verweis';

export interface DurchfuehrungKanzleiDaten {
  abgleich: Map<string, NachweisAbgleich>;
  /** RT3B-K-04: Dateinamen der Nachweise aus der eigenen Ablage (statt aus der Antwort). */
  dateinamen: Map<string, string>;
  /** Wählbare Dokumente ohne die bereits angehängten (leer, wenn nicht anhängbar). */
  dokumente: NachweisDokumentWahl[];
  /** Staff-IDs der Berufsträger des Mandanten (Anzeige). */
  berufstraeger: string[];
}

export async function durchfuehrungKanzleiDatenTx(
  tx: TxClient,
  bezug: Pick<NachweisBezug, 'tenantId' | 'mandantId'>,
  d: Pick<DurchfuehrungDetail, 'nachweise'>,
  optionen: { mitDokumenten: boolean },
): Promise<DurchfuehrungKanzleiDaten> {
  const { abgleich, dateinamen } = await nachweisAblageStandTx(tx, bezug, d.nachweise, {
    mitDateinamen: true,
  });
  const angehaengt = new Set(d.nachweise.map((n) => n.dokumentId.toLowerCase()));
  const dokumente = optionen.mitDokumenten
    ? (await nachweisDokumenteTx(tx, bezug)).filter((x) => !angehaengt.has(x.id.toLowerCase()))
    : [];
  const zustaendig = await tx.clientResponsibility.findMany({
    where: { tenantId: bezug.tenantId, clientId: bezug.mandantId, role: 'BERUFSTRAEGER' },
    select: { staffId: true },
    orderBy: [{ createdAt: 'asc' }, { staffId: 'asc' }],
    take: 5,
  });
  return { abgleich, dateinamen, dokumente, berufstraeger: zustaendig.map((z) => z.staffId) };
}
