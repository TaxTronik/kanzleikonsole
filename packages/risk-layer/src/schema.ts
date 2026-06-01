// =============================================================================
// Zod-Schemas der §4-Engine-Responses (echte Engine, v1.0.0 / Katalog 0.3.0).
//
// `/v1/analyse` liefert die Marking-Substanz in `karten[]` (deterministische
// Katalog-Treffer) und `risiken[]` (Trigger-/Semantik-Kandidaten); `spans[]`
// sind nur die positionierten Highlights mit `ref` auf eine Karte/ein Risiko.
// Wir mappen daher karten + risiken (sie tragen start/end + alle Felder).
//
// Bewusst PERMISSIV (catchall): die Engine-Antwort ist sehr reich (Gesetzestext,
// Quellen, Audit …) — alles bleibt unverändert in `rawResult` erhalten; hier
// validieren wir nur die Felder, die wir auf RiskMarking abbilden. Feldnamen
// sind snake_case wie von der Engine geliefert.
// =============================================================================

import { z } from 'zod';

/** Norm-Referenz {zitat, ids?}. */
const NormRefSchema = z.object({ zitat: z.string() }).catchall(z.unknown());

/** Herkunfts-Objekt der Engine (Schicht/Methode). Nur `schicht` brauchen wir. */
const HerkunftSchema = z
  .object({ schicht: z.union([z.string(), z.number()]).nullish() })
  .catchall(z.unknown())
  .nullish();

/** Katalog-Karte: deterministischer Treffer mit voller Subsumtionsbasis. */
export const KarteSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    matched_text: z.string().default(''),
    begriff: z.string().default(''),
    begriff_id: z.string().nullish(),
    norm_anker: z.array(NormRefSchema).default([]),
    normketten: z.unknown().nullish(),
    governance_typ: z.string().nullish(),
    schadensintensitaet: z.string().nullish(),
    wahrscheinlichkeit: z.string().nullish(),
    kaskadenreichweite: z.number().int().nullish(),
    via: z.string().nullish(),
    herkunft: HerkunftSchema,
  })
  .catchall(z.unknown());
export type Karte = z.infer<typeof KarteSchema>;

/** Risiko-Kandidat (Trigger/Semantik). `titel` ist der Begriff/die Norm. */
export const RisikoSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    matched_text: z.string().default(''),
    titel: z.string().default(''),
    norm_anker: z.array(NormRefSchema).default([]),
    norm_vorschlag: z.array(NormRefSchema).default([]),
    governance_typ: z.string().nullish(),
    schadensintensitaet: z.string().nullish(),
    wahrscheinlichkeit: z.string().nullish(),
    kaskadenreichweite: z.number().int().nullish(),
    quelle: z.string().nullish(),
    via: z.string().nullish(),
    herkunft: HerkunftSchema,
  })
  .catchall(z.unknown());
export type Risiko = z.infer<typeof RisikoSchema>;

/**
 * `POST /v1/analyse`. snake_case wie geliefert; spans/semantik/summary/audit
 * bleiben via catchall im rawResult erhalten (von einer späteren UI nutzbar).
 */
export const AnalyseResponseSchema = z
  .object({
    text_hash: z.string().min(1),
    katalog_version: z.string().default('unbekannt'),
    engineVersion: z.string().default('unbekannt'),
    karten: z.array(KarteSchema).default([]),
    risiken: z.array(RisikoSchema).default([]),
  })
  .catchall(z.unknown());
export type AnalyseResponse = z.infer<typeof AnalyseResponseSchema>;

/** `POST /v1/katalog/definiere` → angelegter Berater-Begriff. */
export const KatalogDefiniereResponseSchema = z.object({
  begriffId: z.string().min(1),
  scope: z.string().default('tenant'),
});
export type KatalogDefiniereResponse = z.infer<typeof KatalogDefiniereResponseSchema>;

/** `GET /v1/katalog` → Version + Begriffe (Extra-Felder via catchall erhalten). */
export const KatalogResponseSchema = z.object({
  version: z.string(),
  begriffe: z
    .array(z.object({ id: z.string(), begriff: z.string() }).catchall(z.unknown()))
    .default([]),
});
export type KatalogResponse = z.infer<typeof KatalogResponseSchema>;

/**
 * Normgraph-/Embedding-Responses: Form offen → als Record durchgereicht.
 */
export const OpaqueObjectSchema = z.object({}).catchall(z.unknown());
export type OpaqueObject = z.infer<typeof OpaqueObjectSchema>;

/** `GET /v1/health`. Die Engine liefert `{ok, engineVersion, katalogVersion, …}`. */
export const HealthResponseSchema = z.object({}).catchall(z.unknown());
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
