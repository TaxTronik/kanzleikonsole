// =============================================================================
// Redirects mit pfadrelativer Location (Review-Befund B-04).
//
// Der Standalone-Server bindet im Container an HOSTNAME=0.0.0.0 und läuft hinter
// dem Reverse-Proxy. `req.url` eines Route-Handlers trägt deshalb die interne
// Adresse (http://0.0.0.0:3000/…); eine daraus gebaute absolute Location
// schickte den Browser dorthin, wo weder Proxy noch Session-Cookie wirken.
// Eine pfadrelative Location (RFC 9110, Abschnitt 10.2.2) löst der Browser
// gegen die Adresse auf, die er tatsächlich aufgerufen hat.
//
// Redirects im Proxy (src/proxy.ts) bleiben `NextResponse.redirect` mit der
// Request-URL: Next macht eine Location mit demselben Host dort selbst
// relativ und braucht für diese Prüfung eine absolute URL.
// =============================================================================

import { NextResponse } from 'next/server';

export type RedirectStatus = 302 | 303 | 307 | 308;

/** Nur Pfade der eigenen Anwendung: `/…`, kein `//host` und kein Backslash. */
export function isAppPath(target: string): boolean {
  return target.startsWith('/') && !target.startsWith('//') && !target.includes('\\');
}

/**
 * Redirect auf einen Pfad der eigenen Anwendung, unabhängig von der Adresse,
 * an die der Server gebunden ist. Antworten auf Anmelde- und Abmeldevorgänge
 * werden nicht zwischengespeichert.
 */
export function relativeRedirect(target: string, status: RedirectStatus = 303): NextResponse {
  if (!isAppPath(target)) {
    throw new Error(`Redirect-Ziel muss ein Pfad der Anwendung sein: ${target}`);
  }
  return new NextResponse(null, {
    status,
    headers: { location: target, 'cache-control': 'no-store' },
  });
}
