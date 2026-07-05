// =============================================================================
// Zod-Schemata für die Antworten der eric-bridge.
//
// Die Bridge ist ein interner Dienst, aber die Antworten werden trotzdem
// validiert (Muster Risk-Layer): Versions-Drift zwischen Bridge und App fällt
// so sofort als Schema-Fehler auf statt als stilles undefined.
// =============================================================================

import { z } from 'zod';

/** `GET /healthz` — Betriebszustand der Bridge (ohne Token abrufbar). */
export const BridgeHealthSchema = z.object({
  ok: z.boolean(),
  eric: z.enum(['geladen', 'fehlt']),
  cert: z.enum(['konfiguriert', 'fehlt']),
  herstellerId: z.enum(['konfiguriert', 'fehlt']),
});
export type BridgeHealth = z.infer<typeof BridgeHealthSchema>;

/** `POST /v1/validate` — lokale Validierung (Stufe 1, kein Serverkontakt). */
export const ValidateResponseSchema = z.object({
  ok: z.boolean(),
  returnCode: z.number().int(),
  result: z.string().nullable(),
  errorText: z.string().nullable(),
});
export type ValidateResponse = z.infer<typeof ValidateResponseSchema>;

/**
 * `POST /v1/abfrage` / `POST /v1/kontoabfrage` — authentifizierte Abfrage
 * (Stufe 2). `phase: 'transferheader'` markiert Fehler VOR dem Serverkontakt.
 */
export const AbfrageResponseSchema = z.object({
  ok: z.boolean(),
  returnCode: z.number().int(),
  phase: z.literal('transferheader').optional(),
  result: z.string().nullable(),
  serverantwort: z.string().nullable().optional(),
  errorText: z.string().nullable(),
});
export type AbfrageResponse = z.infer<typeof AbfrageResponseSchema>;

/** Antwort der Kontoabfrage: zusätzlich das NutzdatenTicket (Audit/GoBD-Bezug). */
export const KontoabfrageResponseSchema = AbfrageResponseSchema.extend({
  nutzdatenTicket: z.string(),
});
export type KontoabfrageResponse = z.infer<typeof KontoabfrageResponseSchema>;

// --- Eingaben der Kontoabfrage (strukturiert, kein Schema-Wissen nötig) ------

/** Steuerarten der Kontoabfrage. `alle` ist nur bei der I-Abfrage zulässig. */
export const KontoSteuerartSchema = z.enum(['ESt', 'KSt', 'USt', 'LSt', 'GewSt', 'ZaSt', 'KapESt']);
export type KontoSteuerart = z.infer<typeof KontoSteuerartSchema>;

const Steuernummer13 = z
  .string()
  .regex(/^[0-9]{13}$/, 'Steuernummer im 13-stelligen ELSTER-Format erwartet');

/** I-Abfrage: Istbuchungen ab/zu einem Wertstellungsdatum. */
export const IstAbfrageSchema = z.object({
  art: z.literal('I'),
  steuernummer: Steuernummer13,
  steuerart: z.union([KontoSteuerartSchema, z.literal('alle')]),
  /** TTMMJJJJ. */
  wertstellungsdatum: z.string().regex(/^[0-9]{8}$/),
  /** 'J' = genau dieses Datum, 'V' = ab diesem Datum. */
  wertstellungsdatumOption: z.enum(['J', 'V']),
});

/** O-Abfrage: offene Beträge. */
export const OffeneBetraegeAbfrageSchema = z.object({
  art: z.literal('O'),
  steuernummer: Steuernummer13,
});

/** ZS-Abfrage: Sollstellungen eines Jahres — der TaxTronik-Kernfall. */
export const SollstellungenAbfrageSchema = z.object({
  art: z.literal('ZS'),
  steuernummer: Steuernummer13,
  steuerart: KontoSteuerartSchema,
  /** Vierstelliges Jahr. */
  zeitraum: z.string().regex(/^[0-9]{4}$/),
});

export const KontoabfrageTeilSchema = z.discriminatedUnion('art', [
  IstAbfrageSchema,
  OffeneBetraegeAbfrageSchema,
  SollstellungenAbfrageSchema,
]);
export type KontoabfrageTeil = z.infer<typeof KontoabfrageTeilSchema>;
