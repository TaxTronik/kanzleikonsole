// =============================================================================
// Logger-Indirektion für @taxtronik/mail.
//
// Das Paket wird von Web (pino via @/server/logger) UND Worker (eigenes pino)
// verwendet — beide registrieren ihren Logger beim Modul-Load ihres Adapters
// (Web: @/server/mail/dispatch, Worker: apps/worker/src/mail.ts). Ohne
// Registrierung fällt das Paket auf console zurück (Tests, CLI-Tools), damit
// Warnungen nie still verschluckt werden.
// =============================================================================

export interface MailLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

const consoleLogger: MailLogger = {
  warn: (obj, msg) => console.warn(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};

let logger: MailLogger = consoleLogger;

export function setMailLogger(l: MailLogger): void {
  logger = l;
}

export function mailLog(): MailLogger {
  return logger;
}
