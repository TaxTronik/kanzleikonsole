// =============================================================================
// Format-neutrales Report-Modell + Disclaimer — OHNE DB-/Format-Abhängigkeiten.
// Die Renderer (to-docx, to-pdf) hängen NUR hieran; der DB-gebundene Builder
// (report-model.ts) baut das Modell und importiert diese Typen.
// =============================================================================

export interface ReportMarking {
  nr: number;
  /** Der tatsächlich markierte Textausschnitt (Fundstelle im Sachverhalt). */
  fundstelle: string;
  begriff: string;
  herkunftLabel: string;
  herkunftColor: string; // #rrggbb
  engineStatusLabel: string | null;
  streitig: boolean;
  normAnker: string[];
  governanceLabel: string | null;
  schadenLabel: string | null;
  wahrscheinlichkeitLabel: string | null;
  statusLabel: string;
  kontrolle: string | null;
  notiz: string | null;
}

/** Token-Strom des annotierten Sachverhalts: Textstücke + Marker-Nummern. */
export type ReportToken =
  | { kind: 'text'; text: string; color: string | null; streitig: boolean }
  | { kind: 'marker'; nr: number; color: string };

export interface ReportModel {
  title: string;
  clientName: string | null;
  createdAt: Date;
  textHash: string;
  katalogVersion: string;
  engineVersion: string;
  llmEnriched: boolean;
  tokens: ReportToken[];
  markings: ReportMarking[];
  counts: { gesamt: number; eigen: number };
}

export const DISCLAIMER =
  'Das System lenkt Aufmerksamkeit, es übernimmt keine Subsumtion. Markierungen sind Hinweise auf ' +
  'definitions- und subsumtionsbedürftige Stellen — keine Rechtsfolgenbestimmung. Die Bewertung ' +
  'schuldet der Berufsträger höchstpersönlich (§§ 33, 57 StBerG).';
