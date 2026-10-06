// =============================================================================
// Prozess-Anbindung des Mail-Pakets in der Web-App (Review-Befund K-10)
//
// @taxtronik/mail kennt Logger und n8n-Emitter nur über Setter. Vorher
// registrierte apps/web/src/server/mail/dispatch.ts beide als Seiteneffekt
// beim Import; fehlte der Import auf einem Pfad, fiel ein n8n-Ereignis im
// Dispatch-Modus BOTH mit einer Warnung weg. Jetzt ruft instrumentation.ts
// diese Funktion genau einmal beim Serverstart auf; ohne Registrierung bricht
// das Mail-Paket den Versand mit MailN8nEmitterMissingError ab.
// =============================================================================

import { setMailLogger, setN8nEmitter } from '@taxtronik/mail';
import { emitN8nEvent } from '@/server/n8n/emit';
import { log } from '@/server/logger';

let registered = false;

/** Registriert Logger und n8n-Emitter der Web-App; weitere Aufrufe sind No-ops. */
export function registerMailIntegrations(): void {
  if (registered) return;
  setMailLogger(log);
  setN8nEmitter(emitN8nEvent);
  registered = true;
}
