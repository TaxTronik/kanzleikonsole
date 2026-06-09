// =============================================================================
// emitN8nEvent — n8n-Event via Outbox (S15) + Test-Ping
//
// Vorher: fire-and-forget direkter HTTP-Call an n8n. Bei n8n-Ausfall waren
// Events verloren.
//
// Jetzt: jeder emit-Call schreibt in `n8n_outbox` und reiht einen BullMQ-Job
// in `n8n-deliver`. Der Worker delivered mit Exponential-Backoff (5 Versuche,
// ~9h Worst-Case). Bei dauerhaftem Fehlschlag bleibt die Reihe mit
// status=FAILED stehen — ops kann sie manuell re-triggern.
//
// `pingN8nWebhook` bleibt synchron: der Test-Button in den Einstellungen
// soll auf den echten Fehler warten, nicht auf die Outbox vertröstet werden.
// =============================================================================

import { signOutboundN8n } from './sign';
import { enqueueN8nEvent } from './outbox';

/**
 * Bekannte System-Events. Workflow-Step-Events haben das dynamische
 * Präfix `workflow.step.<suffix>` und werden separat typisiert (siehe
 * WorkflowStepN8nEvent).
 */
export type StaticN8nEventName =
  | 'client.created'
  | 'client.handover.ready'
  | 'document.uploaded'
  | 'request.opened'
  | 'request.responded'
  | 'request.closed'
  | 'phone_note.created'
  | 'gwg.expired'
  | 'invoice.due'
  | 'staff.locked'
  // R-5: Urlaubsantrag — vorher fälschlich als staff.locked emittiert.
  // n8n-Workflows, die auf staff.locked als „Account ausgesperrt"-Alarm
  // hören, hätten sonst beim Urlaubsantrag ausgelöst.
  | 'staff.vacation_requested'
  // R-5 (gleiche Bug-Klasse): Termin-Bestätigung/-Ablehnung — vorher fälschlich
  // als client.created emittiert (calendar/actions.ts). Payload trägt
  // kind: 'appointment-accepted' | 'appointment-rejected'.
  | 'appointment.responded'
  | 'risk.research_requested'
  | 'taxtronik.ping';

/**
 * Dynamische Workflow-Step-Events. Suffix wird beim Speichern der
 * Template-Schritte hart validiert (regex `^[a-z][a-z0-9._-]{0,40}$`,
 * siehe saveTemplateAction). Damit ist die URL-Path-Komponente sicher.
 */
export type WorkflowStepN8nEvent = `workflow.step.${string}`;

export type N8nEventName = StaticN8nEventName | WorkflowStepN8nEvent;

export interface EmitOptions {
  /**
   * Tenant-Kontext für die Konfiguration (HMAC-Secret aus tenant_setting
   * oder ENV-Fallback). Bei System-Events (z. B. taxtronik.ping) weglassen.
   */
  tenantId?: string;
}

/**
 * Reiht das Event in die Outbox + BullMQ-Queue ein. Returnt nichts —
 * Fehler beim Outbox-Write werden geloggt, blockieren die Geschäftslogik
 * aber nicht.
 *
 * Bewusst nicht-async für Backward-Compat mit allen Call-Sites (die heute
 * fire-and-forget aufrufen). Wir schicken das Promise selbst weg.
 */
export function emitN8nEvent(
  event: N8nEventName,
  payload: Record<string, unknown>,
  opts: EmitOptions = {},
): void {
  void enqueueN8nEvent(event, payload, opts);
}

/**
 * Synchroner Test-Ping (wartet auf Antwort). Genutzt vom „Test"-Button in
 * den Einstellungen — wirft die echten Fehler zurück, damit der Admin sieht,
 * was schief läuft. Geht NICHT über die Outbox.
 */
export async function pingN8nWebhook(
  webhookBaseUrl: string,
  hmacSecret: string,
): Promise<{ ok: boolean; status: number; latencyMs: number; body: string }> {
  if (!webhookBaseUrl) throw new Error('Webhook-URL fehlt');
  if (!hmacSecret) throw new Error('HMAC-Secret fehlt');

  const url = `${webhookBaseUrl.replace(/\/$/, '')}/taxtronik.ping`;
  const body = JSON.stringify({
    event: 'taxtronik.ping',
    payload: { from: 'taxtronik-settings-ui' },
    occurredAt: new Date().toISOString(),
  });
  const { signature, timestamp, event, nonce } = signOutboundN8n('taxtronik.ping', body, hmacSecret);

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8_000);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-taxtronik-signature': signature,
        'x-taxtronik-timestamp': timestamp,
        'x-taxtronik-event': event,
        // Audit 5: Nonce ist Teil der Signatur (event\nts\nnonce\nbody) —
        // n8n-Empfänger SOLLEN sie für Replay-Schutz nutzen.
        'x-taxtronik-nonce': nonce,
      },
      body,
      signal: ctrl.signal,
      redirect: 'error', // M-6: keine 302 auf interne URL
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      latencyMs: Date.now() - start,
      body: text.slice(0, 400),
    };
  } finally {
    clearTimeout(to);
  }
}
