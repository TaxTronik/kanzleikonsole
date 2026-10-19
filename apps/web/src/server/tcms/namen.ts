// =============================================================================
// Personennamen für TCMS-Antworten (TCMS Stufe 3; ADR 0001 §5 im TCMS-Repo).
//
// Das TCMS speichert und liefert Personen nur als IDs der kanzleikonsole
// (Mitarbeiter oder Mandantenkontakt). Namen löst die kanzleikonsole auf –
// serverseitig vor dem Rendern, in einem Batch, nur im eigenen Tenant:
//   - Mitarbeiter: StaffUser des Tenants (auch deaktivierte: historische
//     Einträge behalten ihren Namen).
//   - Kontakte: nur ClientContact des genannten Mandanten. Ein Kontakt eines
//     anderen Mandanten bleibt „Unbekannte Person“ – auch wenn eine Antwort
//     des Dienstes dessen ID enthielte, mischt die kanzleikonsole keine Daten
//     eines anderen Mandanten in die Seite.
// Unbekannte, ungültige oder fremde IDs werden nie geraten: Anzeige
// „Unbekannte Person“; leere Felder „—“.
//
// Muster in Seiten: IDs aus der Antwort sammeln (`personIdsAus`), einmal
// `tcmsNamenLesen(seite, ids)` (server/tcms/seite.ts), dann `namen.name(id)`.
// =============================================================================

import type { TxClient } from '@taxtronik/db';

export const UNBEKANNTE_PERSON = 'Unbekannte Person';
export const KEINE_PERSON = '—';

/** Höchstzahl IDs je Batch (eine Seite zeigt nie mehr Personen). */
export const MAX_NAMEN_JE_ABFRAGE = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type IdQuelle = Iterable<string | null | undefined>;

export interface TcmsNamenAnfrage {
  /** Tenant der Sitzung; zusätzlich zu RLS als Filter. */
  tenantId: string;
  staffIds?: IdQuelle;
  /** Kontakte nur dieses Mandanten (Kanzlei: Mandant aus dem Pfad nach Zugriffsprüfung, Portal: Mandant der Sitzung). */
  kontakte?: { mandantId: string; ids: IdQuelle };
}

/** Aufgelöste Namen; `name()` liefert immer einen anzeigbaren Text. */
export interface TcmsNamen {
  name(id: string | null | undefined): string;
  /** true, wenn die ID im Tenant (bzw. beim Mandanten) bekannt ist. */
  bekannt(id: string | null | undefined): boolean;
}

/** IDs aus beliebig vielen Feldern und Listen sammeln (ohne null/undefined, ohne Dubletten). */
export function personIdsAus(
  ...werte: Array<string | null | undefined | readonly (string | null | undefined)[]>
): string[] {
  const ids = new Set<string>();
  for (const wert of werte) {
    for (const id of typeof wert === 'string' || wert == null ? [wert] : wert) {
      if (typeof id === 'string' && id !== '') ids.add(id);
    }
  }
  return [...ids];
}

/** Gültige UUIDs in kanonischer Kleinschreibung, dedupliziert und begrenzt. */
function gueltigeIds(quelle: IdQuelle | undefined): string[] {
  if (!quelle) return [];
  const ids = new Set<string>();
  for (const id of quelle) {
    if (typeof id === 'string' && UUID.test(id)) ids.add(id.toLowerCase());
    if (ids.size > MAX_NAMEN_JE_ABFRAGE) {
      throw new Error(`tcmsNamen: mehr als ${MAX_NAMEN_JE_ABFRAGE} Personen-IDs in einer Abfrage`);
    }
  }
  return [...ids];
}

function anzeige(name: string): string {
  const getrimmt = name.trim();
  return getrimmt === '' ? UNBEKANNTE_PERSON : getrimmt;
}

/**
 * Löst Personen-IDs in Namen auf (eine Abfrage je Tabelle). Läuft in einer
 * bereits geöffneten Tenant-Transaktion (withTenantContext), nie außerhalb.
 */
export async function tcmsNamen(tx: TxClient, anfrage: TcmsNamenAnfrage): Promise<TcmsNamen> {
  const staffIds = gueltigeIds(anfrage.staffIds);
  const kontaktIds = gueltigeIds(anfrage.kontakte?.ids);
  const namen = new Map<string, string>();
  if (staffIds.length > 0) {
    const staff = await tx.staffUser.findMany({
      where: { tenantId: anfrage.tenantId, id: { in: staffIds } },
      select: { id: true, fullName: true },
    });
    for (const s of staff) namen.set(s.id.toLowerCase(), anzeige(s.fullName));
  }
  if (kontaktIds.length > 0 && anfrage.kontakte && UUID.test(anfrage.kontakte.mandantId)) {
    const kontakte = await tx.clientContact.findMany({
      where: {
        tenantId: anfrage.tenantId,
        clientId: anfrage.kontakte.mandantId,
        id: { in: kontaktIds },
      },
      select: { id: true, fullName: true },
    });
    for (const k of kontakte) {
      // Eine Mitarbeiter-ID hat Vorrang; Kollisionen über Tabellen gibt es bei UUIDs nicht.
      if (!namen.has(k.id.toLowerCase())) namen.set(k.id.toLowerCase(), anzeige(k.fullName));
    }
  }
  return {
    name(id) {
      if (id == null || id === '') return KEINE_PERSON;
      return namen.get(id.toLowerCase()) ?? UNBEKANNTE_PERSON;
    },
    bekannt(id) {
      return id != null && namen.has(id.toLowerCase());
    },
  };
}
