// =============================================================================
// Request-Kontext für den Logger (Review-Befund F-06).
//
// Jede Logzeile, die während eines Requests entsteht, trägt dessen Request-ID
// (logger.ts, pino-`mixin`). Die ID kommt aus einem AsyncLocalStorage und
// überlebt damit jedes `await`, Timer und nicht abgewartete Hintergrund-
// Promises des Requests:
//
//   1. Eigener Kontext (`runWithRequestId`): ausdrücklich gesetzter Bereich,
//      z. B. in Tests oder Skripten; verschachtelt gilt der innerste.
//   2. Sonst der Request-Store, den Next.js für jeden App-Router-Request
//      (Server Components, Server Actions, Route Handler, `after()`) selbst in
//      einem AsyncLocalStorage hält. Daraus wird der vom Proxy gesetzte Header
//      synchron gelesen: pino-Mixins sind synchron, `headers()` ist asynchron
//      und würde statisches Rendern zu dynamischem machen. Der Store ist ein
//      Next-Internum (`.external`-Modul, von Next ausdrücklich zwischen Router,
//      Renderer und Nutzercode geteilt); die Typen prüfen die Form beim
//      Typecheck, log-context.test.ts den Vertrag zur Laufzeit. Statische
//      Prerender-Stores und `use cache` haben keinen Request und damit keine ID.
// =============================================================================

import { AsyncLocalStorage } from 'node:async_hooks';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
import { REQUEST_ID_HEADER, isWellFormedRequestId } from './log-request-id';

interface RequestLogContext {
  requestId: string;
}

const requestLogContext = new AsyncLocalStorage<RequestLogContext>();

/** Führt `fn` mit `requestId` als Request-ID aller darin entstehenden Logzeilen aus. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestLogContext.run({ requestId }, fn);
}

function requestIdOfNextRequest(): string | null {
  const store = workUnitAsyncStorage.getStore();
  if (store?.type !== 'request') return null;
  const requestId = store.headers.get(REQUEST_ID_HEADER);
  // Der Proxy setzt nur wohlgeformte IDs; Requests am Proxy vorbei (Matcher-
  // Ausnahmen) tragen sonst ungeprüfte Client-Werte.
  return isWellFormedRequestId(requestId) ? requestId : null;
}

/** Request-ID des laufenden Requests oder `null` außerhalb eines Requests. */
export function currentRequestId(): string | null {
  return requestLogContext.getStore()?.requestId ?? requestIdOfNextRequest();
}
