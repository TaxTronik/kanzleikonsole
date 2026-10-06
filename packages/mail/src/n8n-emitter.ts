// =============================================================================
// n8n-Emitter-Indirektion für @taxtronik/mail.
//
// Der Outbox-Enqueue hängt an prozess-spezifischer Infrastruktur (Web:
// @/server/n8n/emit mit withTimeout-Deckelung; Worker: eigene BullMQ-Queue).
// Das Mail-Paket kennt deshalb nur diesen Setter.
//
// K-10: Die Prozesse registrieren ihren Emitter EXPLIZIT beim Start (Web:
// instrumentation.ts, Worker: Eintrittspunkt) statt als Seiteneffekt beim
// Import eines Adapter-Moduls. Fehlt die Registrierung, wird ein Ereignis nicht
// mehr mit einer Warnung ausgelassen: Der Versand bricht vor dem SMTP-Kontakt
// mit MailN8nEmitterMissingError ab. Eine zweite, abweichende Registrierung
// wird abgewiesen.
// =============================================================================

import type { N8nEventName } from '@taxtronik/n8n-shared';

export interface MailN8nEmitOptions {
  tenantId?: string;
  /**
   * F-08: stabiler Schlüssel je Versandauftrag (mail_outbox). Ein Retry des
   * Workers löst das n8n-Ereignis damit nicht ein zweites Mal aus.
   */
  dedupeKey?: string;
}

export type MailN8nEmitter = (
  event: N8nEventName,
  payload: Record<string, unknown>,
  opts: MailN8nEmitOptions,
) => Promise<unknown>;

declare global {
  // Prozessweit statt modulweit: übersteht die Neuauswertung des Moduls
  // (Next.js-HMR), ohne dass die Registrierung erneut laufen muss.
  // noinspection ES6ConvertVarToLetConst
  var __taxtronik_mail_n8n_emitter: MailN8nEmitter | undefined;
}

/** Der Prozess hat keinen n8n-Emitter registriert; es wurde nichts versendet. */
export class MailN8nEmitterMissingError extends Error {
  constructor(event: N8nEventName) {
    super(
      `mail.dispatch=BOTH, aber kein n8n-Emitter registriert (Ereignis ${event}). ` +
        'registerMailIntegrations()/registerWorkerMailIntegrations() beim Prozessstart aufrufen.',
    );
    this.name = 'MailN8nEmitterMissingError';
  }
}

/**
 * Registriert den n8n-Emitter des Prozesses. Dieselbe Funktion erneut zu
 * registrieren ist ein No-op; eine abweichende zweite Registrierung wirft.
 */
export function setN8nEmitter(e: MailN8nEmitter): void {
  const current = globalThis.__taxtronik_mail_n8n_emitter;
  if (current && current !== e) {
    throw new Error('n8n-Emitter des Mail-Pakets ist bereits registriert.');
  }
  globalThis.__taxtronik_mail_n8n_emitter = e;
}

export function hasN8nEmitter(): boolean {
  return globalThis.__taxtronik_mail_n8n_emitter !== undefined;
}

/** Nur für Tests: Registrierung zurücksetzen. */
export function resetN8nEmitterForTests(): void {
  globalThis.__taxtronik_mail_n8n_emitter = undefined;
}

/** Vor jedem externen Versand prüfen, damit ohne Registrierung nichts halb passiert. */
export function assertN8nEmitterRegistered(event: N8nEventName): void {
  if (!hasN8nEmitter()) throw new MailN8nEmitterMissingError(event);
}

/**
 * Emittiert über den registrierten Emitter; ohne Registrierung
 * MailN8nEmitterMissingError. Fehler des Emitters werden NICHT gefangen — die
 * Aufrufer in dispatch.ts behandeln sie identisch zum bisherigen
 * emitN8nEvent-Verhalten.
 */
export async function emitViaConfiguredN8n(
  event: N8nEventName,
  payload: Record<string, unknown>,
  opts: MailN8nEmitOptions,
): Promise<void> {
  const emitter = globalThis.__taxtronik_mail_n8n_emitter;
  if (!emitter) throw new MailN8nEmitterMissingError(event);
  await emitter(event, payload, opts);
}
