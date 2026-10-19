// =============================================================================
// Bezeichnung einer Feststellung (TCMS Stufe 3). Vertrauliche Feststellungen
// kommen für Nicht-Beteiligte maskiert (`maskiert: true`: nur Nummer, Status,
// ggf. Erfassung – RT-01 im TCMS-Repo). Die Oberfläche zeigt dann genau
// „<Nummer> · Vertrauliche Feststellung“ und errät keine weiteren Felder.
// Jede Liste und jedes Detail nutzt diese Bausteine statt eigener Zweige.
// =============================================================================

import { Lock } from 'lucide-react';

/** Gemeinsamer Ausschnitt aller Feststellungs-Sichten des Vertrags. */
export type FeststellungKern =
  | { maskiert: true; nummer: string }
  | { maskiert: false; nummer: string; titel: string };

export const VERTRAULICHE_FESTSTELLUNG = 'Vertrauliche Feststellung';
export const VERTRAULICH_HINWEIS = 'Inhalt nur für Beteiligte sichtbar';

/** Text „<Nummer> · <Titel>“ bzw. „<Nummer> · Vertrauliche Feststellung“. */
export function feststellungText(f: FeststellungKern): string {
  return `${f.nummer} · ${f.maskiert ? VERTRAULICHE_FESTSTELLUNG : f.titel}`;
}

/** Bezeichnung mit Schloss bei maskierten Feststellungen. */
export function FeststellungBezeichnung({ f }: { f: FeststellungKern }) {
  if (!f.maskiert) return <span>{feststellungText(f)}</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <Lock className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
      {feststellungText(f)}
    </span>
  );
}
