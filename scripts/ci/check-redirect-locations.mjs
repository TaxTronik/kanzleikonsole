#!/usr/bin/env node
// =============================================================================
// Redirect-Ziele des ausgelieferten Standalone-Servers (Review-Befund B-04).
//
//   node scripts/ci/check-redirect-locations.mjs <basis-url>
//
// Im Web-Image und im CI-Job e2e-paranoid bindet der Server an
// HOSTNAME=0.0.0.0. Eine aus req.url gebaute absolute Location zeigte dann auf
// http://0.0.0.0:3000/… statt auf die Adresse, die der Browser aufgerufen hat.
// Geprüft wird je ein Redirect aus dem Proxy und aus Route-Handlern: Status
// 3xx und genau die erwartete pfadrelative Location.
//
// Ohne Nebenwirkungen: keine Sitzung, kein Konto; der Passwortschritt endet
// ohne E-Mail vor Rate-Limit, Datenbank und Audit.
// =============================================================================

import { URL } from 'node:url';

export const REDIRECT_CASES = [
  {
    name: 'Proxy: Staff-Seite ohne Sitzung',
    method: 'GET',
    path: '/staff/dashboard',
    status: 307,
    location: '/staff/login?returnTo=%2Fstaff%2Fdashboard',
  },
  {
    name: 'Proxy: Portal-Seite ohne Sitzung',
    method: 'GET',
    path: '/portal/documents',
    status: 307,
    location: '/portal/login?returnTo=%2Fportal%2Fdocuments',
  },
  {
    name: 'Route-Handler: Passwortschritt ohne Angaben',
    method: 'POST',
    path: '/staff/login/password',
    body: 'email=&password=',
    status: 303,
    location: '/staff/login?error=password-invalid',
  },
  {
    name: 'Route-Handler: Staff-Selbstheilung',
    method: 'GET',
    path: '/api/staff/force-logout',
    status: 303,
    location: '/staff/login',
  },
];

/** Prüft alle Fälle gegen `base`; liefert die Befunde (leer = in Ordnung). */
export async function checkRedirectLocations(base, cases = REDIRECT_CASES) {
  const problems = [];
  for (const testCase of cases) {
    const response = await globalThis.fetch(new URL(testCase.path, base), {
      method: testCase.method,
      redirect: 'manual',
      ...(testCase.body
        ? {
            body: testCase.body,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
          }
        : {}),
    });
    const location = response.headers.get('location');
    const line = `${testCase.name}: ${testCase.method} ${testCase.path} -> ${response.status} ${location}`;
    if (response.status !== testCase.status || location !== testCase.location) {
      problems.push(`${line} (erwartet ${testCase.status} ${testCase.location})`);
    } else {
      console.log(`OK ${line}`);
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2];
  if (!base) {
    console.error('Aufruf: node scripts/ci/check-redirect-locations.mjs <basis-url>');
    process.exit(2);
  }
  const problems = await checkRedirectLocations(base);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`FEHLER ${problem}`);
    process.exit(1);
  }
}
