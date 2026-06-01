// =============================================================================
// Zod-Schemas der §4-Engine-Responses.
//
// Bewusst PERMISSIV: Die Engine-internen Sub-Strukturen (karten/risiken/
// semantik/summary) sind noch nicht feldgenau fixiert. Wir validieren das
// Envelope hart (textHash, katalogVersion, spans) und reichen den Rest
// unverändert in `rawResult` durch (Audit/Replay, schema-evolutionssicher).
// Unbekannte Felder werden von z.object NICHT abgelehnt, nur aus der typisierten
// Sicht gestrippt — der Rohwert bleibt über rawResult erhalten.
//
// Enum-Werte kommen aus der Engine in deutschem Klartext (klein); die
// Normalisierung auf die TaxTronik-Domänen-Enums (UPPERCASE) passiert in
// mapping.ts, nicht hier — Schema validiert nur die Form.
// =============================================================================

import { z } from 'zod';

/**
 * Eine positionsbehaftete Markierung aus der Engine. Quelle der Wahrheit für
 * `RiskMarking`: jeder Treffer (deterministisch ODER semantisch/LLM) trägt
 * Start/Ende im Text und seine Provenienz (`herkunft`).
 */
export const EngineMarkingSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  matchedText: z.string(),
  herkunft: z.string(),
  begriffId: z.string().nullish(),
  begriff: z.string(),
  normAnker: z.array(z.string()).default([]),
  // Norm-Kaskaden [{glieder, verknuepfung, hinweis}] — 1:1 als JSON durchgereicht.
  normketten: z.unknown().nullish(),
  // Governance-Matrix (optional — nur angereicherte Treffer tragen sie).
  governanceTyp: z.string().nullish(),
  schadensintensitaet: z.string().nullish(),
  wahrscheinlichkeit: z.string().nullish(),
  kaskadenreichweite: z.number().int().nullish(),
});
export type EngineMarking = z.infer<typeof EngineMarkingSchema>;

/**
 * `POST /v1/analyse`. `spans` ist die flache Liste aller positionsbehafteten
 * Markierungen. `karten`/`risiken`/`semantik`/`summary` sind Aggregat- bzw.
 * Vorschlags-Sichten — lose validiert, in rawResult erhalten, von einer
 * späteren UI auswertbar.
 */
export const AnalyseResponseSchema = z.object({
  textHash: z.string().min(1),
  katalogVersion: z.string().min(1),
  // Im Contract-Envelope nicht garantiert — Fallback, damit die Persistenz
  // (engineVersion NOT NULL) nie an einem fehlenden Feld scheitert.
  engineVersion: z.string().default('unbekannt'),
  spans: z.array(EngineMarkingSchema).default([]),
  karten: z.unknown().nullish(),
  risiken: z.unknown().nullish(),
  semantik: z.unknown().nullish(),
  summary: z.unknown().nullish(),
});
export type AnalyseResponse = z.infer<typeof AnalyseResponseSchema>;

/** `POST /v1/katalog/definiere` → angelegter Berater-Begriff. */
export const KatalogDefiniereResponseSchema = z.object({
  begriffId: z.string().min(1),
  scope: z.string(),
});
export type KatalogDefiniereResponse = z.infer<typeof KatalogDefiniereResponseSchema>;

/** `GET /v1/katalog` → Version + Begriffe (Extra-Felder bleiben via catchall erhalten). */
export const KatalogResponseSchema = z.object({
  version: z.string(),
  begriffe: z
    .array(z.object({ id: z.string(), begriff: z.string() }).catchall(z.unknown()))
    .default([]),
});
export type KatalogResponse = z.infer<typeof KatalogResponseSchema>;

/**
 * Normgraph-Responses (`/v1/normgraph/aufloesen`, `/v1/normgraph/suche`) und
 * `POST /v1/embedding/suche`: die Graph-/Vorschlags-Form ist offen — wir geben
 * das geparste JSON als Record durch (Felder bleiben erhalten), ohne es zu
 * verengen. Die TCMS-Sicht, die das auswertet, kommt später.
 */
export const OpaqueObjectSchema = z.object({}).catchall(z.unknown());
export type OpaqueObject = z.infer<typeof OpaqueObjectSchema>;

/** `GET /v1/health`. */
export const HealthResponseSchema = z.object({ status: z.string() }).catchall(z.unknown());
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
