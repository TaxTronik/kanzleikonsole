// =============================================================================
// fireAndForget — bewusst nicht-awaited Hintergrund-Promises absichern.
//
// `void someAsyncCall()` lässt Rejections als unhandledRejection eskalieren
// (unter Node Prozess-Crash-Risiko) und verschluckt den Fehler fürs Log.
// Dieser Helfer hängt einen catch an, der strukturiert loggt — blockiert den
// aufrufenden Pfad aber nicht. Backoff/Retry ist bewusst nicht implementiert:
// bei persistentem Ausfall hilft Retry nicht, und der Aufrufer-Pfad (Login,
// Server-Action-Antwort) muss schnell antworten.
//
// Ursprünglich privater Helfer in auth/staff.ts (Q6) — hierher verschoben,
// damit auch Mail-Side-Effects (`notifyClientContacts`, `sendTemplateMail`)
// in Server-Actions ihn nutzen können statt `void ...`.
// =============================================================================

import { log } from '@/server/logger';

export function fireAndForget(label: string, p: Promise<unknown>): void {
  p.catch((err: unknown) => {
    log.warn({ label, err: (err as Error).message }, 'fire-and-forget failed');
  });
}
