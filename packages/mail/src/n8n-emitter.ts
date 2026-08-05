// =============================================================================
// n8n-Emitter-Indirektion für @taxtronik/mail.
//
// Der Outbox-Enqueue hängt an prozess-spezifischer Infrastruktur (Web:
// @/server/n8n/emit mit withTimeout-Deckelung; Worker: eigene BullMQ-Queue).
// Das Mail-Paket kennt deshalb nur diesen Setter — die Adapter registrieren
// beim Modul-Load ihre Implementierung. Ohne Registrierung wird im
// Dispatch-Modus BOTH gewarnt statt still ausgelassen.
// =============================================================================

import type { N8nEventName } from '@taxtronik/n8n-shared';
import { mailLog } from './logger';

export type MailN8nEmitter = (
  event: N8nEventName,
  payload: Record<string, unknown>,
  opts: { tenantId?: string },
) => Promise<unknown>;

let emitter: MailN8nEmitter | null = null;

export function setN8nEmitter(e: MailN8nEmitter): void {
  emitter = e;
}

/**
 * Emittiert über den registrierten Emitter; ohne Registrierung Warn-Log.
 * Fehler des Emitters werden NICHT gefangen — die Aufrufer in dispatch.ts
 * behandeln sie identisch zum bisherigen emitN8nEvent-Verhalten.
 */
export async function emitViaConfiguredN8n(
  event: N8nEventName,
  payload: Record<string, unknown>,
  opts: { tenantId?: string },
): Promise<void> {
  if (!emitter) {
    mailLog().warn(
      { component: 'mail', event },
      'mail.dispatch=BOTH, aber kein n8n-Emitter registriert — Event wird ausgelassen',
    );
    return;
  }
  await emitter(event, payload, opts);
}
