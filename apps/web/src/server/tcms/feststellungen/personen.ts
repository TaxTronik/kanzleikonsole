// =============================================================================
// Personen für Maßnahmen einer Feststellung (TCMS Stufe 3, Bereich C).
//
// Auswahl: aktive Mitarbeiter mit Zugriff auf den Mandanten (dieselbe Regel
// wie kanzleiPersonenFuerMandantTx, ACCESS-CLIENT-MODE-001) und aktive
// Kontakte genau dieses Mandanten mit Tax-CMS-Rolle (laut Kontext des
// Dienstes). Der Formularwert trägt Art und ID (`KANZLEI:<uuid>`,
// `MANDANT:<uuid>`); die Aktion prüft die Person erneut über personen.ts.
// Namen kommen nur aus der kanzleikonsole.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { filterStaffAccessClientTx } from '@/server/auth/rbac';
import { kontakteDesMandantenTx, type TcmsMandantBezug } from '@/server/tcms/personen';

export type PersonArt = 'KANZLEI' | 'MANDANT';

const WERT = /^(KANZLEI|MANDANT):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const MAX_MITARBEITER = 500;

/** Formularwert → Art und ID (null bei ungültigem Wert). */
export function personAusWert(wert: string): { art: PersonArt; id: string } | null {
  const treffer = WERT.exec(wert.trim());
  if (!treffer) return null;
  return { art: treffer[1]!.toUpperCase() as PersonArt, id: treffer[2]!.toLowerCase() };
}

export function personWert(art: PersonArt, id: string): string {
  return `${art}:${id.toLowerCase()}`;
}

/**
 * Wählbare Verantwortliche: Kanzleipersonen mit Mandantenzugriff, danach
 * Kontakte dieses Mandanten mit Tax-CMS-Rolle (`rollenKontakte` aus dem Kontext).
 */
export async function massnahmePersonenTx(
  tx: TxClient,
  bezug: TcmsMandantBezug,
  rollenKontakte: ReadonlySet<string>,
): Promise<Array<readonly [string, string]>> {
  const mitarbeiter = await tx.staffUser.findMany({
    where: { tenantId: bezug.tenantId, active: true },
    select: { id: true, fullName: true },
    orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    take: MAX_MITARBEITER,
  });
  const erlaubt = await filterStaffAccessClientTx(
    tx,
    bezug.tenantId,
    mitarbeiter.map((m) => m.id),
    bezug.mandantId,
  );
  const kanzlei = mitarbeiter
    .filter((m) => erlaubt.has(m.id.toLowerCase()) && m.fullName.trim() !== '')
    .map((m) => [personWert('KANZLEI', m.id), `${m.fullName.trim()} (Kanzlei)`] as const);
  const kontakte = (await kontakteDesMandantenTx(tx, bezug))
    .filter((k) => k.aktiv && rollenKontakte.has(k.id.toLowerCase()))
    .map((k) => [personWert('MANDANT', k.id), `${k.name} (Mandant)`] as const);
  return [...kanzlei, ...kontakte];
}
