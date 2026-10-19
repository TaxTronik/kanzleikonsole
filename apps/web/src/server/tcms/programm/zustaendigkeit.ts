// =============================================================================
// Personen der kanzleikonsole für Programm & Dokumentation des Tax-CMS
// (TCMS Stufe 3, Bereich A: Einrichtung, Profil, Beschreibung).
//
// Mehrere Endpunkte nehmen Personen der Kanzlei als ausdrückliche Eingabe der
// kanzleikonsole an – nur zur Vorbelegung und Anzeige, nie für Rechte (ADR 0001
// §5, Nachtrag Welle 2 im TCMS-Repo):
//   - einrichtungLesen/-EntwurfSpeichern/programmAnlegen: Berufsträger:in,
//     Bearbeitung, Vertretung und alle Kanzleipersonen mit Zugriff
//     (`EinrichtungPersonenSchema`; der Dienst prüft Zuständigkeiten gegen
//     genau diese Liste),
//   - profilRisikoAufnehmen: Verantwortliche mit Namen (`AufnahmePersonSchema`),
//   - beschreibungLesen/-FreigabeAnfordern: Zuständigkeit für den Baustein
//     VERANTWORTUNG und Namen für den eingefrorenen Inhalt.
// Quelle ist ausschließlich die Datenbank der kanzleikonsole, nie ein
// Formularfeld; Namen wie `nam` der Akteursbestätigung (`anzeigename`).
//
//   Berufsträger:in  erste Zuordnung BERUFSTRAEGER (älteste zuerst, dann ID)
//                    einer aktiven, qualifizierten Person mit Rolle – dieselben
//                    Bedingungen wie `canStaffReviewGwgTx` (cli.bt).
//   Bearbeitung      erste Zuordnung HAUPTBEARBEITER einer aktiven Person (wie
//                    cli.hb; Reihenfolge wie im Fristenkontrollbuch).
//   Kanzlei          aktive Mitarbeiter des Tenants mit Zugriff auf den
//                    Mandanten nach ACCESS-CLIENT-MODE-001
//                    (`filterStaffAccessClientTx`, wie personen.ts), nach Name.
//   Vertretung       erste Person aus „Kanzlei“, die weder Berufsträger:in noch
//                    Bearbeitung ist (Vorschlagsreihenfolge des Dienstes).
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { ActionError } from '@/server/actions/action-error';
import { filterStaffAccessClientTx } from '@/server/auth/rbac';
import { anzeigename } from '../akteur';
import type { TcmsMandantBezug, TcmsNamensEintrag } from '../personen';

/** Grenze des Vertrags für Personenlisten (`EinrichtungPersonenSchema.kanzlei`, `namen`). */
export const MAX_PERSONEN_JE_AUFRUF = 2000;

export interface TcmsZustaendigkeit {
  berufstraeger: TcmsNamensEintrag | null;
  bearbeitung: TcmsNamensEintrag | null;
  /** Aktive Kanzleipersonen mit Zugriff auf den Mandanten, nach Name (de). */
  kanzlei: TcmsNamensEintrag[];
  vertretung: TcmsNamensEintrag | null;
}

/** Feste Meldung, wenn eine Liste die Grenze des Vertrags überschreitet (fail closed statt Kürzung). */
export const ZU_VIELE_PERSONEN =
  'Für diesen Mandanten sind mehr Personen erfasst, als das Tax-CMS in einem Schritt annimmt. Bitte wenden Sie sich an die Administration.';

function eintrag(id: string, roh: string): TcmsNamensEintrag | null {
  try {
    return { id: id.toLowerCase(), name: anzeigename(roh) };
  } catch {
    // Leerer Name: wie bei der Akteursbestätigung keine Weitergabe.
    return null;
  }
}

const nachName = (a: TcmsNamensEintrag, b: TcmsNamensEintrag) =>
  a.name.localeCompare(b.name, 'de') || a.id.localeCompare(b.id);

/** Zuständigkeit und Kanzleipersonen eines Mandanten (eine Tenant-Transaktion). */
export async function tcmsZustaendigkeitTx(
  tx: TxClient,
  bezug: TcmsMandantBezug,
): Promise<TcmsZustaendigkeit> {
  const { tenantId, mandantId } = bezug;
  const reihenfolge = [{ createdAt: 'asc' as const }, { staffId: 'asc' as const }];
  const bt = await tx.clientResponsibility.findFirst({
    where: {
      tenantId,
      clientId: mandantId,
      role: 'BERUFSTRAEGER',
      staff: { tenantId, active: true, isProfessional: true, roles: { some: {} } },
    },
    orderBy: reihenfolge,
    select: { staff: { select: { id: true, fullName: true } } },
  });
  const hb = await tx.clientResponsibility.findFirst({
    where: {
      tenantId,
      clientId: mandantId,
      role: 'HAUPTBEARBEITER',
      staff: { tenantId, active: true },
    },
    orderBy: reihenfolge,
    select: { staff: { select: { id: true, fullName: true } } },
  });

  const aktive = await tx.staffUser.findMany({
    where: { tenantId, active: true },
    select: { id: true, fullName: true },
    orderBy: { id: 'asc' },
  });
  const erlaubt = await filterStaffAccessClientTx(
    tx,
    tenantId,
    aktive.map((s) => s.id),
    mandantId,
  );
  const kanzlei = aktive
    .filter((s) => erlaubt.has(s.id))
    .flatMap((s) => eintrag(s.id, s.fullName) ?? [])
    .sort(nachName);
  if (kanzlei.length > MAX_PERSONEN_JE_AUFRUF) throw new ActionError(ZU_VIELE_PERSONEN);

  const berufstraeger = bt ? eintrag(bt.staff.id, bt.staff.fullName) : null;
  const bearbeitung = hb ? eintrag(hb.staff.id, hb.staff.fullName) : null;
  const vertretung =
    kanzlei.find((p) => p.id !== berufstraeger?.id && p.id !== bearbeitung?.id) ?? null;
  return { berufstraeger, bearbeitung, kanzlei, vertretung };
}

/** Feste Meldungen, wenn die Zuständigkeit für die Vorbelegung neuer Kontrollen nicht reicht. */
export const AUFNAHME_TEXTE = {
  keineZustaendigkeit:
    'Für diesen Mandanten sind keine zuständige Berufsträgerin bzw. kein zuständiger Berufsträger und keine Hauptbearbeitung zugeordnet. Bitte ordnen Sie beide in der Mandantenakte zu.',
  gleichePerson:
    'Berufsträger:in und Hauptbearbeitung des Mandanten sind dieselbe Person. Für neue Kontrollen braucht das Tax-CMS zwei verschiedene Personen; bitte ordnen Sie in der Mandantenakte eine weitere Person zu.',
} as const;

/** Grund, warum „Risiko aufnehmen“ ohne passende Zuständigkeit nicht gesendet wird (oder null). */
export function aufnahmeHindernis(z: TcmsZustaendigkeit): string | null {
  if (!z.berufstraeger || !z.bearbeitung) return AUFNAHME_TEXTE.keineZustaendigkeit;
  // Vertrag (`RisikoAufnehmenBodySchema`): die Verantwortlichen müssen verschieden sein.
  if (z.berufstraeger.id === z.bearbeitung.id) return AUFNAHME_TEXTE.gleichePerson;
  return null;
}

/**
 * Verantwortliche für `profilRisikoAufnehmen` (`AufnahmePersonSchema`): nur
 * Vorbelegung neuer Kontrollen, keine Rechte. Ohne passende Zuständigkeit
 * feste Meldung statt Dienstaufruf.
 */
export function aufnahmeVerantwortliche(z: TcmsZustaendigkeit): {
  berufstraeger: TcmsNamensEintrag;
  hauptbearbeitung: TcmsNamensEintrag;
  vertretung: TcmsNamensEintrag | null;
} {
  const hindernis = aufnahmeHindernis(z);
  if (hindernis || !z.berufstraeger || !z.bearbeitung) {
    throw new ActionError(hindernis ?? AUFNAHME_TEXTE.keineZustaendigkeit);
  }
  return {
    berufstraeger: z.berufstraeger,
    hauptbearbeitung: z.bearbeitung,
    vertretung: z.vertretung,
  };
}

/**
 * Namen für den eingefrorenen Inhalt einer Beschreibung
 * (`BeschreibungFreigabeAnfordernBodySchema.namen`): alle Mitarbeiter des
 * Tenants – auch ausgeschiedene, deren Designbeurteilungen oder Zuständigkeiten
 * im Inhalt stehen – und alle Kontakte genau dieses Mandanten. Der Dienst
 * übernimmt nur die Namen der im Inhalt referenzierten IDs; die Liste selbst
 * speichert er nicht. Mehr Einträge als der Vertrag erlaubt: Abbruch statt
 * Kürzung, weil ein fehlender Name im unveränderlichen Inhalt als „—“
 * eingefroren würde.
 */
export async function freigabeNamenTx(
  tx: TxClient,
  bezug: TcmsMandantBezug,
): Promise<TcmsNamensEintrag[]> {
  const grenze = MAX_PERSONEN_JE_AUFRUF + 1;
  const staff = await tx.staffUser.findMany({
    where: { tenantId: bezug.tenantId },
    select: { id: true, fullName: true },
    orderBy: { id: 'asc' },
    take: grenze,
  });
  const kontakte = await tx.clientContact.findMany({
    where: { tenantId: bezug.tenantId, clientId: bezug.mandantId },
    select: { id: true, fullName: true },
    orderBy: { id: 'asc' },
    take: grenze,
  });
  const namen = new Map<string, TcmsNamensEintrag>();
  for (const p of [...staff, ...kontakte]) {
    const e = eintrag(p.id, p.fullName);
    if (e && !namen.has(e.id)) namen.set(e.id, e);
  }
  if (namen.size > MAX_PERSONEN_JE_AUFRUF) throw new ActionError(ZU_VIELE_PERSONEN);
  return [...namen.values()];
}
