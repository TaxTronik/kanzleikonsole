// =============================================================================
// Re-Export aus @taxtronik/mail (Muster M-7, secret-box.ts).
//
// Der Mail-Dispatch lebt jetzt in packages/mail, damit auch der Worker
// mandantengerichtete Template-Mails versenden kann (Auto-Anforderungen aus
// Steuerterminen). Diese Datei bleibt als Re-Export erhalten UND registriert
// beim Laden Logger + n8n-Emitter der Web-App.
//
// KONVENTION: Web-Code importiert IMMER über diesen Pfad (bzw. die anderen
// Re-Export-Dateien), nie direkt aus @taxtronik/mail — sonst fehlt die
// Emitter-Registrierung und der Dispatch-Modus BOTH ließe n8n-Events aus.
// =============================================================================

import { setMailLogger, setN8nEmitter } from '@taxtronik/mail';
import { emitN8nEvent } from '@/server/n8n/emit';
import { log } from '@/server/logger';

setMailLogger(log);
setN8nEmitter(emitN8nEvent);

export {
  sendTemplateMail,
  notifyClientContacts,
  renderTemplate,
  plainTextBody,
  notifyRequestOpened,
  REQUEST_OPENED_FALLBACK,
  type TemplateFallback,
  type DispatchOptions,
  type RequestOpenedInput,
} from '@taxtronik/mail';
