// =============================================================================
// Personen aus Formularen für TCMS-Aufrufe prüfen (TCMS Stufe 3).
//
// Schreibende TCMS-Endpunkte nehmen Personen-IDs der kanzleikonsole an
// (Verantwortliche, Empfänger, Kontaktrollen) und teils Anzeigenamen dazu
// (`namensEintrag`, `AufnahmePersonSchema`). Der Dienst prüft IDs gegen den
// Mandanten; die kanzleikonsole lässt zusätzlich nur Personen zu, die zu
// diesem Mandanten gehören, und liefert die Namen aus ihren eigenen Daten –
// nie aus Formularfeldern:
//   - Kanzleipersonen: aktive Mitarbeiter des Tenants mit Zugriff auf den
//     Mandanten nach ACCESS-CLIENT-MODE-001 (filterStaffAccessClientTx).
//   - Kontakte: Kontakte genau dieses Mandanten (Standard: nur aktive).
// Eine unzulässige ID bricht die ganze Aktion ab (TcmsPersonUnzulaessig, feste
// Meldung, Feld optional), statt sie still zu entfernen.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { ActionError } from '@/server/actions/action-error';
import { filterStaffAccessClientTx } from '@/server/auth/rbac';
import { anzeigename } from './akteur';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PERSONEN = 200;

/** Name und ID wie `namensEintrag` des Vertrags (Name ≤ 200 Zeichen, getrimmt). */
export interface TcmsNamensEintrag {
  id: string;
  name: string;
}

export interface TcmsMandantBezug {
  tenantId: string;
  mandantId: string;
}

/** Fachfehler mit fester, UI-tauglicher Meldung; `feld` ordnet ihn einem Formularfeld zu. */
export class TcmsPersonUnzulaessig extends ActionError {
  readonly feld: string | null;
  constructor(art: 'KANZLEI' | 'KONTAKT', feld: string | null = null) {
    super(
      art === 'KANZLEI'
        ? 'Die gewählte Person hat keinen Zugriff auf diesen Mandanten.'
        : 'Der gewählte Kontakt gehört nicht zu diesem Mandanten.',
    );
    this.name = 'TcmsPersonUnzulaessig';
    this.feld = feld;
  }
}

function pruefeIds(ids: readonly string[], art: 'KANZLEI' | 'KONTAKT', feld: string | null) {
  if (ids.length > MAX_PERSONEN) throw new TcmsPersonUnzulaessig(art, feld);
  const eindeutig = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new TcmsPersonUnzulaessig(art, feld);
    eindeutig.add(id.toLowerCase());
  }
  return [...eindeutig];
}

/** Anzeigename wie `nam` der Bestätigung; ein leerer Name macht die Person unzulässig. */
function namensText(roh: string, art: 'KANZLEI' | 'KONTAKT', feld: string | null): string {
  try {
    return anzeigename(roh);
  } catch {
    throw new TcmsPersonUnzulaessig(art, feld);
  }
}

/** Reihenfolge der Eingabe, Namen aus der Datenbank. */
function inEingabeReihenfolge(
  ids: readonly string[],
  namen: ReadonlyMap<string, string>,
): TcmsNamensEintrag[] {
  const gesehen = new Set<string>();
  const ergebnis: TcmsNamensEintrag[] = [];
  for (const id of ids) {
    const schluessel = id.toLowerCase();
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    ergebnis.push({ id: schluessel, name: namen.get(schluessel)! });
  }
  return ergebnis;
}

/**
 * Kanzleipersonen für einen Mandanten: jede ID muss ein aktiver Mitarbeiter
 * des Tenants mit Zugriff auf den Mandanten sein. Liefert Namenseinträge in
 * Eingabereihenfolge (ohne Dubletten).
 */
export async function kanzleiPersonenFuerMandantTx(
  tx: TxClient,
  bezug: TcmsMandantBezug,
  ids: readonly string[],
  opts: { feld?: string } = {},
): Promise<TcmsNamensEintrag[]> {
  const feld = opts.feld ?? null;
  const eindeutig = pruefeIds(ids, 'KANZLEI', feld);
  if (eindeutig.length === 0) return [];
  const erlaubt = await filterStaffAccessClientTx(tx, bezug.tenantId, eindeutig, bezug.mandantId);
  if (eindeutig.some((id) => !erlaubt.has(id))) throw new TcmsPersonUnzulaessig('KANZLEI', feld);
  const staff = await tx.staffUser.findMany({
    where: { tenantId: bezug.tenantId, id: { in: eindeutig }, active: true },
    select: { id: true, fullName: true },
  });
  const namen = new Map(
    staff.map((s) => [s.id.toLowerCase(), namensText(s.fullName, 'KANZLEI', feld)]),
  );
  if (eindeutig.some((id) => !namen.has(id))) throw new TcmsPersonUnzulaessig('KANZLEI', feld);
  return inEingabeReihenfolge(ids, namen);
}

/**
 * Kontakte genau dieses Mandanten. `auchInaktive`: z. B. um Rollen eines
 * deaktivierten Kontakts zu entfernen; sonst nur aktive Kontakte.
 */
export async function mandantKontakteTx(
  tx: TxClient,
  bezug: TcmsMandantBezug,
  ids: readonly string[],
  opts: { feld?: string; auchInaktive?: boolean } = {},
): Promise<Array<TcmsNamensEintrag & { aktiv: boolean }>> {
  const feld = opts.feld ?? null;
  const eindeutig = pruefeIds(ids, 'KONTAKT', feld);
  if (eindeutig.length === 0) return [];
  const kontakte = await tx.clientContact.findMany({
    where: {
      tenantId: bezug.tenantId,
      clientId: bezug.mandantId,
      id: { in: eindeutig },
      ...(opts.auchInaktive ? {} : { active: true }),
    },
    select: { id: true, fullName: true, active: true },
  });
  const gefunden = new Map(kontakte.map((k) => [k.id.toLowerCase(), k]));
  if (eindeutig.some((id) => !gefunden.has(id))) throw new TcmsPersonUnzulaessig('KONTAKT', feld);
  const namen = new Map(
    [...gefunden].map(([id, k]) => [id, namensText(k.fullName, 'KONTAKT', feld)]),
  );
  return inEingabeReihenfolge(ids, namen).map((eintrag) => ({
    ...eintrag,
    aktiv: gefunden.get(eintrag.id)!.active,
  }));
}

/** Kontakt der kanzleikonsole für Anzeigen (Kontakte & Rollen). */
export interface MandantKontaktAnzeige {
  id: string;
  name: string;
  email: string;
  aktiv: boolean;
  /** Funktion aus der kanzleikonsole (ClientContact.role), nur Anzeige. */
  funktion: string | null;
}

/** Alle Kontakte genau dieses Mandanten (aktive zuerst, dann nach Name). */
export async function kontakteDesMandantenTx(
  tx: TxClient,
  bezug: TcmsMandantBezug,
): Promise<MandantKontaktAnzeige[]> {
  const kontakte = await tx.clientContact.findMany({
    where: { tenantId: bezug.tenantId, clientId: bezug.mandantId },
    select: { id: true, fullName: true, email: true, active: true, role: true },
    orderBy: [{ active: 'desc' }, { fullName: 'asc' }],
    take: 500,
  });
  return kontakte.map((k) => ({
    id: k.id,
    name: k.fullName.trim() || k.email,
    email: k.email,
    aktiv: k.active,
    funktion: k.role?.trim() || null,
  }));
}
