// =============================================================================
// Unbehandelte Request-Fehler mit Request-ID ins Log (Review-Befund F-06).
//
// Next.js meldet Fehler aus Server Components, Server Actions, Route Handlern
// und dem Proxy über `onRequestError` (instrumentation.ts) und schreibt sie
// sonst nur unstrukturiert auf die Konsole — ohne Bezug zum Request. Hier
// entsteht eine strukturierte Zeile mit Request-ID, Routenmuster und Fehler.
// Bewusst NICHT der konkrete Pfad: Query-Strings tragen Einmal-Token
// (/poa/sign, /gwg-onboarding), Pfadsegmente Datensatz-IDs.
// =============================================================================

import type { Instrumentation } from 'next';
import { currentRequestId } from './log-context';
import { REQUEST_ID_HEADER, isWellFormedRequestId } from './log-request-id';
import { log } from './logger';

type OnRequestErrorArgs = Parameters<Instrumentation.onRequestError>;

function requestIdOf(request: OnRequestErrorArgs[1]): string | null {
  const header = request.headers[REQUEST_ID_HEADER];
  const fromHeader = isWellFormedRequestId(header) ? header : null;
  return currentRequestId() ?? fromHeader;
}

export function logRequestError(...[error, request, context]: OnRequestErrorArgs): void {
  const requestId = requestIdOf(request);
  const err = error instanceof Error ? error : null;
  const digest = (error as { digest?: unknown } | null)?.digest;
  log.error(
    {
      component: 'request-error',
      ...(requestId ? { requestId } : {}),
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
      ...(context.renderSource ? { renderSource: context.renderSource } : {}),
      ...(typeof digest === 'string' ? { digest } : {}),
      errName: err?.name ?? typeof error,
      err: err?.message ?? String(error),
      stack: err?.stack,
    },
    'request: unbehandelter Fehler',
  );
}
