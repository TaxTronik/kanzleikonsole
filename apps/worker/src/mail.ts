// =============================================================================
// Mandantengerichteter Mail-Versand aus dem Worker.
//
// Pendant zu apps/web/src/server/mail/dispatch.ts: registriert beim Laden
// Worker-Logger + Worker-n8n-Emitter am @taxtronik/mail-Paket und re-exportiert
// die Versand-Funktionen. Worker-Jobs importieren IMMER über diese Datei —
// ein Direktimport aus @taxtronik/mail würde die Registrierung umgehen
// (Dispatch-Modus BOTH ließe n8n-Events aus).
//
// Nicht zu verwechseln mit mailer.ts (sendOpsMail): das bleibt der bewusst
// minimale Plaintext-Kanal für Ops-Alerts an OPS_ALERT_EMAIL.
// =============================================================================

import { setMailLogger, setN8nEmitter } from '@taxtronik/mail';
import { log } from './logger';
import { emitN8nEventFromWorker } from './n8n-emit';

setMailLogger(log);
setN8nEmitter(emitN8nEventFromWorker);

export {
  notifyAutomaticTaxRequestOpened,
  notifyClientContacts,
  notifyRequestOpened,
  sendTemplateMail,
} from '@taxtronik/mail';
