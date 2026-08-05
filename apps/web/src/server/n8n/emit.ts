// =============================================================================
// emitN8nEvent — n8n-Event via Outbox (S15)
//
// Vorher: fire-and-forget direkter HTTP-Call an n8n. Bei n8n-Ausfall waren
// Events verloren.
//
// Jetzt: jeder emit-Call schreibt in `n8n_outbox` und reiht einen BullMQ-Job
// in `n8n-deliver`. Der Worker delivered mit Exponential-Backoff (5 Versuche,
// ~9h Worst-Case). Bei dauerhaftem Fehlschlag bleibt die Reihe mit
// status=FAILED stehen — ops kann sie manuell re-triggern.
//
// Interaktive Tests adressieren heute eine gespeicherte, konkrete Endpoint-URL
// in den n8n-Einstellungen. Der alte `<base>/taxtronik.ping`-Sonderweg wurde
// entfernt, damit Tests dieselbe Signatur/Envelope wie echte Deliveries nutzen.
// =============================================================================

import { enqueueN8nEvent } from './outbox';
import type { N8nEnqueueResult } from './outbox';

// Bekannte System-Events. EINZIGE Quelle ist STATIC_EVENT_NAMES in
// @taxtronik/n8n-shared — daraus werden Runtime-Whitelist UND die Typen
// abgeleitet, sodass ein typisiertes Emit nie an der Whitelist scheitern kann.
// Die Typen (inkl. `workflow.step.<suffix>`) leben jetzt ebenfalls dort,
// damit @taxtronik/mail und der Worker sie ohne Web-Import kennen.
export type { StaticN8nEventName, WorkflowStepN8nEvent, N8nEventName } from '@taxtronik/n8n-shared';
import type { N8nEventName } from '@taxtronik/n8n-shared';

export interface EmitOptions {
  /**
   * Tenant-Kontext für die Konfiguration (HMAC-Secret aus tenant_setting
   * oder ENV-Fallback). Bei System-Events (z. B. taxtronik.ping) weglassen.
   */
  tenantId?: string;
}

/**
 * Reiht das Event in die Outbox + BullMQ-Queue ein. Alle Aufrufer warten
 * mindestens den dauerhaften Outbox-Write ab. So kann der Prozess nicht nach
 * der fachlichen Antwort enden, bevor das Event persistiert wurde.
 *
 * Fehler werden als WRITE_FAILED zurückgegeben und geloggt; die bereits
 * abgeschlossene Geschäftsoperation wird dadurch nicht zurückgerollt.
 */
export async function emitN8nEvent(
  event: N8nEventName,
  payload: Record<string, unknown>,
  opts: EmitOptions = {},
): Promise<N8nEnqueueResult> {
  return enqueueN8nEvent(event, payload, opts);
}
