// =============================================================================
// Mandantengerichteter Mail-Versand aus dem Worker.
//
// Pendant zu apps/web/src/server/mail/dispatch.ts + integrations.ts:
// re-exportiert die Versand-Funktionen von @taxtronik/mail. K-10: Logger und
// Worker-n8n-Emitter registriert der Worker-Eintritt (index.ts) explizit über
// registerWorkerMailIntegrations() — der Import hat keine Seiteneffekte mehr.
//
// Nicht zu verwechseln mit mailer.ts (sendOpsMail): das bleibt der bewusst
// minimale Plaintext-Kanal für Ops-Alerts an OPS_ALERT_EMAIL.
// =============================================================================

import { setMailLogger, setN8nEmitter } from '@taxtronik/mail';
import { log } from './logger';
import { emitN8nEventFromWorker } from './n8n-emit';

let registered = false;

/** Registriert Logger und n8n-Emitter des Workers; weitere Aufrufe sind No-ops. */
export function registerWorkerMailIntegrations(): void {
  if (registered) return;
  setMailLogger(log);
  setN8nEmitter(emitN8nEventFromWorker);
  registered = true;
}

export {
  notifyAutomaticTaxRequestOpened,
  notifyClientContacts,
  notifyRequestOpened,
  sendTemplateMail,
} from '@taxtronik/mail';
