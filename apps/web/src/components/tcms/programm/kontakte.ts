// =============================================================================
// Kontakte der Mandantenseite für Programm & Dokumentation (TCMS Stufe 3,
// Bereich A): Rollen kommen aus dem Tax-CMS (`kontakteLesen` bzw.
// `kontext.kontaktRollen`), Namen aus der kanzleikonsole (tcmsNamenLesen).
// Angeboten werden nur Kontakte, die die kanzleikonsole als Kontakt genau
// dieses Mandanten kennt (`namen.bekannt`); Einträge des Dienstes ohne Kontakt
// erscheinen nie in Auswahllisten (vgl. Kontakte & Rollen).
// =============================================================================

import type { KontakteAntwort, KontextAntwort } from '@taxtronik/tcms-contract';
import type { TcmsNamen } from '@/server/tcms/namen';
import { TCMS_KONTAKT_ROLLE_LABEL, type TcmsKontaktRolle } from '../rollen';

export interface KontaktRolle {
  kontaktId: string;
  rolle: TcmsKontaktRolle;
  funktion: string | null;
}

export interface Person {
  id: string;
  name: string;
}

/** Aktive Rollen aus `kontakteLesen`. */
export function aktiveRollen(kontakte: KontakteAntwort['kontakte']): KontaktRolle[] {
  return kontakte.flatMap((k) =>
    k.rollen
      .filter((r) => r.aktiv)
      .map((r) => ({
        kontaktId: k.kontaktId.toLowerCase(),
        rolle: r.rolle as TcmsKontaktRolle,
        funktion: r.funktion ?? null,
      })),
  );
}

/** Rollen aus dem Kontext (`kontaktRollen`, nur aktive). */
export function rollenAusKontext(rollen: KontextAntwort['kontaktRollen']): KontaktRolle[] {
  return rollen.map((r) => ({
    kontaktId: r.kontaktId.toLowerCase(),
    rolle: r.rolle,
    funktion: r.funktion,
  }));
}

/** Bekannte Kontakte (Namen aus der kanzleikonsole), optional nur mit bestimmten Rollen, nach Name. */
export function kontaktPersonen(
  rollen: readonly KontaktRolle[],
  namen: TcmsNamen,
  nur?: readonly TcmsKontaktRolle[],
): Person[] {
  const gesehen = new Map<string, Person>();
  for (const r of rollen) {
    if (nur && !nur.includes(r.rolle)) continue;
    if (!namen.bekannt(r.kontaktId) || gesehen.has(r.kontaktId)) continue;
    gesehen.set(r.kontaktId, { id: r.kontaktId, name: namen.name(r.kontaktId) });
  }
  return [...gesehen.values()].sort(
    (a, b) => a.name.localeCompare(b.name, 'de') || a.id.localeCompare(b.id),
  );
}

/** Ansprechpersonen (gesetzliche Vertretung, Tax-Compliance-Beauftragte) mit Rolle und Funktion. */
export function ansprechpersonen(
  rollen: readonly KontaktRolle[],
  namen: TcmsNamen,
): Array<Person & { rolle: string; funktion: string | null }> {
  return rollen
    .filter(
      (r) =>
        (r.rolle === 'GESETZLICHER_VERTRETER' || r.rolle === 'TAX_COMPLIANCE_BEAUFTRAGTER') &&
        namen.bekannt(r.kontaktId),
    )
    .map((r) => ({
      id: r.kontaktId,
      name: namen.name(r.kontaktId),
      rolle: TCMS_KONTAKT_ROLLE_LABEL[r.rolle],
      funktion: r.funktion,
    }));
}

/** Rollenbezeichnung eines Kontakts (mehrere Rollen kommagetrennt) oder null. */
export function rollenText(rollen: readonly KontaktRolle[], kontaktId: string): string | null {
  const id = kontaktId.toLowerCase();
  const eigene = rollen
    .filter((r) => r.kontaktId === id)
    .map((r) => TCMS_KONTAKT_ROLLE_LABEL[r.rolle]);
  return eigene.length ? eigene.join(', ') : null;
}
