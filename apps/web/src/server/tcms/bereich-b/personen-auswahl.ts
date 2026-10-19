// =============================================================================
// Auswahllisten für Personenfelder des Bereichs B (TCMS Stufe 3): Zuständige
// einer Kontrolle (Kanzleiseite) und Mandantenkontakte mit Tax-CMS-Rolle.
//
// Leitfaden §4: Mitarbeiterlisten nur mit derselben Zugriffsregel wie
// `kanzleiPersonenFuerMandantTx` (aktive Mitarbeiter des Tenants mit Zugriff
// auf den Mandanten, ACCESS-CLIENT-MODE-001). Die Liste ist nur ein Angebot:
// Jede gewählte ID prüft die Aktion erneut (server/tcms/personen.ts), der
// Dienst prüft zusätzlich die Rolle beim Mandanten.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { filterStaffAccessClientTx } from '@/server/auth/rbac';
import { kontakteDesMandantenTx, type TcmsMandantBezug } from '../personen';

/** Höchstzahl Einträge je Auswahlliste (eine Kanzlei hat nicht mehr Mitarbeitende im Mandat). */
export const MAX_AUSWAHL = 500;

export interface PersonAuswahl {
  id: string;
  name: string;
  /** Funktion (Kontakt: Tax-CMS-Rolle oder Funktion aus der Mandantenakte). */
  funktion: string | null;
}

/** Aktive Mitarbeitende des Tenants mit Zugriff auf genau diesen Mandanten, nach Name (getrimmt). */
export async function kanzleiPersonenAuswahlTx(
  tx: TxClient,
  bezug: TcmsMandantBezug,
): Promise<PersonAuswahl[]> {
  const staff = await tx.staffUser.findMany({
    where: { tenantId: bezug.tenantId, active: true },
    select: { id: true, fullName: true },
    orderBy: { fullName: 'asc' },
    take: MAX_AUSWAHL,
  });
  if (staff.length === 0) return [];
  const erlaubt = await filterStaffAccessClientTx(
    tx,
    bezug.tenantId,
    staff.map((s) => s.id),
    bezug.mandantId,
  );
  return staff
    .filter((s) => erlaubt.has(s.id) && s.fullName.trim() !== '')
    .map((s) => ({ id: s.id, name: s.fullName.trim(), funktion: null }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

/**
 * Aktive Kontakte genau dieses Mandanten, die laut Dienst eine aktive Rolle
 * haben (`rollen`: Kontakt-ID → Funktion bzw. Rollenbezeichnung). Name aus
 * der kanzleikonsole.
 */
export async function mandantPersonenAuswahlTx(
  tx: TxClient,
  bezug: TcmsMandantBezug,
  rollen: ReadonlyMap<string, string | null>,
): Promise<PersonAuswahl[]> {
  const kontakte = await kontakteDesMandantenTx(tx, bezug);
  return kontakte
    .filter((k) => k.aktiv && rollen.has(k.id.toLowerCase()))
    .map((k) => ({ id: k.id, name: k.name, funktion: rollen.get(k.id.toLowerCase()) ?? null }));
}
