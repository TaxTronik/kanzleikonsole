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

/**
 * Norm-Referenz. Die Engine liefert zwei Varianten:
 *  - Karten:  { zitat, ids: ["norm:UStG:2:abs2:nr2"] }      (granular, plural)
 *  - Risiken: { zitat, id: "norm:KStG:8", titel, text:"" }  (singular + Titel)
 * Beide tragen die stabile Norm-ID, mit der `/v1/normgraph/aufloesen` den
 * Gesetzestext liefert. `text` ist in der Analyse-Antwort leer (lazy via aufloesen).
 */
const NormRefSchema = z
  .object({
    zitat: z.string(),
    id: z.string().nullish(),
    ids: z.array(z.string()).nullish(),
    titel: z.string().nullish(),
    // Katalog-Kuratierung, von der Engine zurückgespiegelt: quelle "katalog"
    // (Standardvorschlag) vs. "berater" (katalogweit ergänzt); verworfen = vom
    // Berater abgelehnter Vorschlag. Fehlt bei unkuratiertem Katalog.
    quelle: z.string().nullish(),
    verworfen: z.boolean().nullish(),
  })
  .catchall(z.unknown());

/**
 * Herkunfts-Objekt der Engine (Detektionsschicht + Methode). `methode` ist das
 * verlässlichste Provenienz-Signal: die LLM-Schicht trägt `schicht:"2"` ABER
 * `methode:"llm"` — ohne `methode` würde Schicht 2 fälschlich als Embedding/
 * Heuristik gemappt. `interpretation:true` markiert Modell-/Heuristik-Stellen.
 */
const HerkunftSchema = z
  .object({
    schicht: z.union([z.string(), z.number()]).nullish(),
    methode: z.string().nullish(),
    interpretation: z.boolean().nullish(),
  })
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
    status: z.string().nullish(),
    ist_streitig: z.boolean().nullish(),
    // Textuelles Streitsignal ("streitig"/"umstritten"/"fraglich" …); ergänzt
    // ist_streitig — manche Stellen tragen nur das Signal.
    streit_signal: z.string().nullish(),
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
    status: z.string().nullish(),
    ist_streitig: z.boolean().nullish(),
    streit_signal: z.string().nullish(),
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

/** `GET /v1/katalog/kuratierung?katalog_id=&nutzer=` — aufbereitete Sicht EINES
 *  Begriffs (zum Überlagern der Norm-Anzeige im Panel). */
export const KatalogKuratierungBegriffSchema = z
  .object({
    katalog_id: z.string().nullish(),
    verworfen: z.array(z.string()).default([]),
    ergaenzt: z
      .array(z.object({ zitat: z.string(), id: z.string().nullish() }).catchall(z.unknown()))
      .default([]),
  })
  .catchall(z.unknown());
export type KatalogKuratierungBegriff = z.infer<typeof KatalogKuratierungBegriffSchema>;

/** `GET /v1/katalog/kuratierung?nutzer=` — ALLE Kuratierungen (Review/Governance),
 *  scope-gefiltert (geteilt + persönliche des Nutzers). */
export const KatalogKuratierungListeSchema = z
  .object({
    kuratierungen: z
      .array(
        z
          .object({
            katalog_id: z.string(),
            norm_zitat: z.string().nullish(),
            norm_id: z.string().nullish(),
            aktion: z.string(),
            scope: z.string().nullish(),
            autor: z.string().nullish(),
            eingetragen_am: z.string().nullish(),
          })
          .catchall(z.unknown()),
      )
      .default([]),
  })
  .catchall(z.unknown());
export type KatalogKuratierungListe = z.infer<typeof KatalogKuratierungListeSchema>;

/** `POST /v1/katalog/norm_kuratieren` → katalogweite Norm-Kuratierung (Begriffs-
 *  Karten). `ok:false` trägt `fehler`. Permissiv (catchall) — wir lesen ok/fehler. */
export const KatalogKuratiereResponseSchema = z
  .object({
    ok: z.boolean().default(false),
    katalog_id: z.string().nullish(),
    norm: z.string().nullish(),
    aktion: z.string().nullish(),
    scope: z.string().nullish(),
    fehler: z.string().nullish(),
  })
  .catchall(z.unknown());
export type KatalogKuratiereResponse = z.infer<typeof KatalogKuratiereResponseSchema>;

/** `POST /v1/katalog/review` → Review-Lebenszyklus eines GETEILTEN Berater-
 *  Eintrags (nur vorwärts: entwurf → geprüft → freigegeben; seit Engine 1.1.0).
 *  Die Antwort nennt den VOLLSTÄNDIGEN Übergang (alter_status → neuer_status) —
 *  das ist die Grundlage für den Audit-Chain-Eintrag des Hosts, die Engine
 *  auditiert nicht. `ok:false` (HTTP 400) trägt `fehler`. */
export const KatalogReviewResponseSchema = z
  .object({
    ok: z.boolean().default(false),
    id: z.string().nullish(),
    alter_status: z.string().nullish(),
    neuer_status: z.string().nullish(),
    pruefer: z.string().nullish(),
    fehler: z.string().nullish(),
  })
  .catchall(z.unknown());
export type KatalogReviewResponse = z.infer<typeof KatalogReviewResponseSchema>;

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

/**
 * Queue-Auslastung des llama-server (Schicht 2). Zwei Quellen:
 *  - /slots:   { quelle:"slots", slots_gesamt, aktiv, frei, slots:[{id,aktiv}] }
 *  - /metrics: { quelle:"metrics", aktiv, wartend }
 * Permissiv (catchall) — wir lesen nur die Auslastungszahlen.
 */
export const LlmQueueSchema = z
  .object({
    quelle: z.string().nullish(),
    slots_gesamt: z.number().nullish(),
    aktiv: z.number().nullish(),
    frei: z.number().nullish(),
    wartend: z.number().nullish(),
  })
  .catchall(z.unknown());

/** `GET /v1/llm/status` — Status + Queue des llama-server. `queue` = null, wenn
 *  der Server nicht läuft oder weder /slots noch /metrics exponiert. */
export const LlmStatusResponseSchema = z
  .object({
    url: z.string().nullish(),
    verfuegbar: z.boolean().default(false),
    queue: LlmQueueSchema.nullable().default(null),
    modell_geladen: z.boolean().nullish(),
    binary_vorhanden: z.boolean().nullish(),
    von_uns_gestartet: z.boolean().nullish(),
    engineVersion: z.string().nullish(),
  })
  .catchall(z.unknown());
export type LlmStatusResponse = z.infer<typeof LlmStatusResponseSchema>;

/** `POST /v1/llm/start` — idempotent, non-blocking (Bereitschaft via status pollen). */
export const LlmStartResponseSchema = z
  .object({ ok: z.boolean().default(true), hinweis: z.string().nullish() })
  .catchall(z.unknown());
export type LlmStartResponse = z.infer<typeof LlmStartResponseSchema>;

// -----------------------------------------------------------------------------
// Quantenlos (beweisbar blinde Compliance-Stichprobe) — Engine 1.3.0.
// -----------------------------------------------------------------------------

/** Zufallsquelle des Loses. `qpu` = echter IBM-Quantenprozessor (attestierbar
 *  via job_id), `simulator`/`csprng` = Test/Fallback (NICHT attestierbar). */
export const LosBackendSchema = z.enum(['qpu', 'simulator', 'csprng']);
export type LosBackend = z.infer<typeof LosBackendSchema>;

/** Entropie-Block des Nachweises. Permissiv (catchall): die Engine liefert je
 *  nach Backend weitere Attestierungs-Felder (Kalibrierung, Shots …) — alles
 *  bleibt im Nachweis erhalten; wir lesen nur die Anzeige-/Prüf-Felder. */
const LosEntropieSchema = z
  .object({
    quelle_klasse: z.string(),
    backend: z.string(),
    /** IBM-Job-ID — nur bei `qpu` (öffentlich nachschlagbar, attestierbar). */
    job_id: z.string().nullish(),
    job_tags: z.array(z.string()).nullish(),
    /** Bindung an die Roh-Messung (Counts-Hash) — Kern der Nachprüfbarkeit. */
    roh_counts_sha256: z.string().nullish(),
  })
  .catchall(z.unknown());

/**
 * Los-Nachweis (protokoll_version 1): selbst-tragendes Beweisdokument der
 * Ziehung. `rahmen.commitment` bindet an die Grundgesamtheit (Hash über die
 * IDs — die Engine sieht NIE Inhalte), `stichprobe` sind die gezogenen IDs.
 * Permissiv (catchall) — der Nachweis wird unverändert abgelegt/zurückgereicht.
 */
export const LosNachweisSchema = z
  .object({
    protokoll_version: z.number().int(),
    gezogen_am: z.string(),
    rahmen: z.object({ commitment: z.string(), n: z.number().int() }).catchall(z.unknown()),
    k: z.number().int(),
    stichprobe: z.array(z.string()),
    entropie: LosEntropieSchema,
    ableitung: z.object({ extraktor: z.string(), drbg: z.string() }).catchall(z.unknown()),
  })
  .catchall(z.unknown());
export type LosNachweis = z.infer<typeof LosNachweisSchema>;

/** Fertige Ziehung — der Nachweis liegt vor. */
const LosFertigSchema = z
  .object({ ok: z.literal(true), status: z.literal('fertig'), nachweis: LosNachweisSchema })
  .catchall(z.unknown());

/** QPU-Queue: der Job läuft noch — job_id merken und später `losAbholen`. */
const LosWartetSchema = z
  .object({
    ok: z.literal(true),
    status: z.literal('wartet'),
    job_id: z.string(),
    backend: z.string(),
    commitment: z.string(),
    k: z.number().int(),
  })
  .catchall(z.unknown());

/** `POST /v1/los/ziehen` und `POST /v1/los/abholen` antworten beide in der
 *  fertig- ODER wartet-Form (Fehler kommen als non-2xx → RiskLayerHttpError). */
export const LosErgebnisSchema = z.discriminatedUnion('status', [LosFertigSchema, LosWartetSchema]);
export type LosErgebnis = z.infer<typeof LosErgebnisSchema>;

/** `POST /v1/los/pruefen` → Nachweis-Verifikation (offline; `online:true`
 *  prüft zusätzlich die IBM-Job-Attestierung). */
export const LosPruefenResponseSchema = z
  .object({
    ok: z.literal(true),
    gueltig: z.boolean(),
    geprueft: z.array(z.string()).default([]),
    hinweise: z.array(z.string()).default([]),
  })
  .catchall(z.unknown());
export type LosPruefenResponse = z.infer<typeof LosPruefenResponseSchema>;
