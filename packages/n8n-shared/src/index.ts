// =============================================================================
// @taxtronik/n8n-shared — geteilte Konstanten und HMAC-Signing für n8n.
//
// Konsolidiert die Drift-Klasse aus Round 12:
//   - STATIC_EVENT_WHITELIST war in apps/web/src/server/n8n/outbox.ts und
//     apps/worker/src/jobs/n8n-deliver.ts identisch dupliziert. Neue Events
//     ohne Pflege beider Stellen landen sonst stillschweigend in einer
//     Sackgasse (Outbox akzeptiert, Worker lehnt ab — oder umgekehrt).
//   - HMAC-Signing (sign.ts in Web + n8n-deliver.ts inline im Worker) hatte
//     dieselben drei Zeilen `${event}\n${ts}\n${body}` + `sha256=${hex}`.
// =============================================================================

import { createHmac, randomBytes } from 'node:crypto';

/**
 * System-Events, die die App aktiv an n8n schickt. Workflow-Step-Events
 * (`workflow.step.<suffix>`) sind separat über WORKFLOW_STEP_RE typisiert.
 *
 * EINZIGE Quelle: aus dieser Tupel-Konstante werden sowohl die Runtime-
 * Whitelist als auch der TS-Union-Typ `StaticN8nEventName` abgeleitet. So
 * kann ein typisiertes Emit nie an einer fehlenden Whitelist-Zeile scheitern
 * (die Drift-Klasse aus Round 12 bzw. dem appointment.responded-Befund).
 */
export const STATIC_EVENT_NAMES = [
  'client.created',
  'client.handover.ready',
  'document.uploaded',
  'request.opened',
  'request.responded',
  'request.closed',
  'phone_note.created',
  // Termin-Bestätigung/-Ablehnung (calendar/actions.ts). Payload trägt
  // kind: 'appointment-accepted' | 'appointment-rejected'.
  'appointment.responded',
  'gwg.expired',
  'invoice.due',
  'staff.locked',
  // Urlaubsantrag — nicht als staff.locked emittieren (anderer Alarm).
  'staff.vacation_requested',
  'risk.research_requested',
  'taxtronik.ping',
] as const;

export type StaticN8nEventName = (typeof STATIC_EVENT_NAMES)[number];

export const STATIC_EVENT_WHITELIST = new Set<string>(STATIC_EVENT_NAMES);

/**
 * Workflow-Step-Suffix: lowercase + Ziffern + `_-`, kein Punkt (L-7).
 * Beispiele: `workflow.step.onboarding_done`, `workflow.step.review-required`.
 */
export const WORKFLOW_STEP_RE = /^workflow\.step\.[a-z][a-z0-9_-]{0,40}$/;

/**
 * Prüft, ob ein Event-Name in der Whitelist ist (statisch oder Workflow-Step).
 * Wird sowohl beim Outbox-Insert als auch beim Worker-Deliver aufgerufen —
 * Defense in Depth gegen direkte DB-Manipulation an `n8n_outbox.event`.
 */
export function isAllowedN8nEvent(event: string): boolean {
  return STATIC_EVENT_WHITELIST.has(event) || WORKFLOW_STEP_RE.test(event);
}

export interface OutboundSignature {
  signature: string;
  timestamp: string;
  event: string;
  nonce: string;
}

/**
 * Signiert einen Outbound-Request für n8n.
 *
 * Payload: `event \n timestamp \n nonce \n body`
 * Format:  `sha256=<hex(HMAC-SHA256(payload, secret))>`
 *
 * Header-Set:
 *   - x-taxtronik-signature: sha256=<hex>
 *   - x-taxtronik-timestamp: <epoch-ms>
 *   - x-taxtronik-event:     <event>
 *   - x-taxtronik-nonce:     <hex>
 *
 * Begründungen:
 *   - M-8 (event mitsignieren): Replay über andere n8n-Trigger verhindert.
 *   - Audit Round 14, Finding 5 (nonce): jede Anfrage hat eine fresh
 *     128-Bit-Nonce. n8n-Empfänger SOLLEN sie als Replay-Schutz nutzen
 *     (z. B. via Function-Node mit Workflow-Static-Data-Set, das die
 *     letzten N Nonces hält). Bis n8n das umsetzt, ist die Nonce
 *     defense-in-depth — bei Reuse müsste ein Angreifer auch das HMAC
 *     vom alten Payload mitspielen, aber wenn n8n den Replay erkennt
 *     ist die Anfrage abgelehnt.
 */
export function signOutboundN8n(
  event: string,
  body: string,
  hmacSecret: string,
): OutboundSignature {
  const ts = Date.now();
  const nonce = randomBytes(16).toString('hex');
  const payloadToSign = `${event}\n${ts}\n${nonce}\n${body}`;
  const hex = createHmac('sha256', hmacSecret).update(payloadToSign).digest('hex');
  return { signature: `sha256=${hex}`, timestamp: String(ts), event, nonce };
}
