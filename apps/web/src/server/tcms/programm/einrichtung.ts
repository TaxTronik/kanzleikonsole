// =============================================================================
// Einrichtungsassistent des Tax-CMS (TCMS Stufe 3, Bereich A): Personen aus
// dem Formular gegen die kanzleikonsole prüfen und die Personenangaben des
// Vertrags (`EinrichtungPersonenSchema`) bilden.
//
// Der Dienst prüft Zuständigkeiten gegen die übergebene Personenliste und die
// Rollen der Mandantenseite (pruefeKontrollZustaendigkeiten, pruefeSchritt3).
// Die kanzleikonsole lässt zusätzlich nur Personen dieses Mandanten durch
// (server/tcms/personen.ts) und bricht sonst vor dem Dienstaufruf ab:
//   - Schritt 3: Empfänger der Zielfreigabe = Kontakt dieses Mandanten; ist
//     die Freigabe angefordert, mit aktivem Portalzugang (kk-tcms-s11) – beim
//     Speichern und erneut vor dem Anlegen (dann versendet der Dienst die
//     Anforderung).
//   - Schritt 5 / Version 1: durchführende Person und Vertretung je Partei
//     (Kanzlei: Mitarbeiter mit Zugriff, Mandant: Kontakt dieses Mandanten),
//     Gegenzeichnung durch einen Kontakt dieses Mandanten oder eine
//     Kanzleiperson mit Zugriff.
// Rollen (gesetzliche Vertretung, Schlüsselkontrolle, Vier-Augen) prüft nur
// der Dienst.
// =============================================================================

import type { TenantContext, TxClient } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db/tenant-context';
import type { EinrichtungPersonen, EntwurfKontrolle } from '@taxtronik/tcms-contract';
import {
  freigabeEmpfaengerTx,
  kanzleiPersonenFuerMandantTx,
  mandantKontakteTx,
  type TcmsMandantBezug,
} from '../personen';
import type { TcmsZustaendigkeit } from './zustaendigkeit';

/** Personenangaben für Lesen (Query), Speichern und Anlegen aus der Zuständigkeit. */
export function einrichtungsPersonen(z: TcmsZustaendigkeit): EinrichtungPersonen {
  return {
    berufstraegerId: z.berufstraeger?.id ?? null,
    bearbeitungId: z.bearbeitung?.id ?? null,
    kanzlei: z.kanzlei.map((p) => p.id),
  };
}

/** Query für `einrichtungLesen` (nur gesetzte Werte). */
export function einrichtungLesenQuery(z: TcmsZustaendigkeit): {
  berufstraegerId?: string;
  bearbeitungId?: string;
  vertretungId?: string;
} {
  return {
    ...(z.berufstraeger ? { berufstraegerId: z.berufstraeger.id } : {}),
    ...(z.bearbeitung ? { bearbeitungId: z.bearbeitung.id } : {}),
    ...(z.vertretung ? { vertretungId: z.vertretung.id } : {}),
  };
}

/** Feld der Formularfehler für Personen der Kontrollzuständigkeiten. */
export const FELD_KONTROLLEN = 'kontrollen';
/** Feld der Formularfehler für den Empfänger der Zielfreigabe. */
export const FELD_FREIGABE = 'freigabe';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Personen der Kontrollzuständigkeiten (Schritt 5) gegen die kanzleikonsole
 * prüfen. Unzulässige IDs werfen `TcmsPersonUnzulaessig` (Feld `kontrollen`);
 * der Dienst wird dann nicht gerufen.
 */
export async function pruefeKontrollPersonenTx(
  tx: TxClient,
  bezug: TcmsMandantBezug,
  kontrollen: Readonly<Record<string, EntwurfKontrolle>>,
): Promise<void> {
  const kanzlei = new Set<string>();
  const kontakte = new Set<string>();
  const gegen = new Set<string>();
  for (const k of Object.values(kontrollen)) {
    const ziel = k.partei === 'KANZLEI' ? kanzlei : kontakte;
    for (const id of [k.durchfuehrendId, k.vertretungId]) if (id) ziel.add(id.toLowerCase());
    if (k.gegenzeichnerId) gegen.add(k.gegenzeichnerId.toLowerCase());
  }
  // Gegenzeichnung: Kontakt dieses Mandanten oder (sonst) Kanzleiperson mit Zugriff.
  if (gegen.size > 0) {
    const gueltig = [...gegen].filter((id) => UUID.test(id));
    const alsKontakt = gueltig.length
      ? await tx.clientContact.findMany({
          where: { tenantId: bezug.tenantId, clientId: bezug.mandantId, id: { in: gueltig } },
          select: { id: true },
        })
      : [];
    const kontaktIds = new Set(alsKontakt.map((k) => k.id.toLowerCase()));
    for (const id of gegen) (kontaktIds.has(id) ? kontakte : kanzlei).add(id);
  }
  await kanzleiPersonenFuerMandantTx(tx, bezug, [...kanzlei], { feld: FELD_KONTROLLEN });
  await mandantKontakteTx(tx, bezug, [...kontakte], { feld: FELD_KONTROLLEN });
}

/**
 * Empfänger der Zielfreigabe (Schritt 3) gegen die Kontakte dieses Mandanten
 * prüfen; mit `anfordern` zusätzlich aktiver Portalzugang (kk-tcms-s11).
 */
export async function pruefeFreigabeEmpfaengerTx(
  tx: TxClient,
  bezug: TcmsMandantBezug,
  freigabe: { anfordern: boolean; empfaengerId: string | null },
): Promise<void> {
  if (!freigabe.empfaengerId) return;
  if (freigabe.anfordern) {
    await freigabeEmpfaengerTx(tx, bezug, freigabe.empfaengerId, { feld: FELD_FREIGABE });
  } else {
    await mandantKontakteTx(tx, bezug, [freigabe.empfaengerId], { feld: FELD_FREIGABE });
  }
}

/**
 * Vor dem Anlegen von Version 1 (der Dienst versendet dann die Zielfreigabe):
 * den im Entwurf gespeicherten Empfänger erneut prüfen, in eigener
 * Transaktion zwischen Lesen des Entwurfs und Anlegen (kk-tcms-s11). Wirft
 * `TcmsPersonUnzulaessig` (Kontakt nicht mehr beim Mandanten bzw. ohne
 * aktiven Portalzugang).
 */
export function pruefeZielfreigabeVorAnlegen(
  ctx: TenantContext,
  bezug: TcmsMandantBezug,
  freigabe: { anfordern: boolean; empfaengerId: string | null },
): Promise<void> {
  return withTenantContext(ctx, (tx) => pruefeFreigabeEmpfaengerTx(tx, bezug, freigabe));
}
