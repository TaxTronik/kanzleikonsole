// =============================================================================
// TCMS Stufe 4: Der Systemakteur entsteht nur an einer Stelle des Workers und
// erreicht nur den Postausgang (ADR 0001 §3.4 des TCMS-Repos; MAIL-OUTBOX-001).
//
//   - Eine Bestätigung der Art SYSTEM bildet allein tcms/systemakteur.ts.
//   - Den Client mit NUR_SYSTEMAKTEUR baut allein tcms/dienst.ts; er ruft nur
//     holeOffeneNachrichten/meldeNachrichtZugestellt (die zwei Endpunkte, die
//     den Systemakteur zulassen; rufeEndpunkt prüft `akteure`).
//   - Kein anderer Worker-Code ruft das Tax-CMS (kein rufeEndpunkt, kein
//     ENDPUNKTE, kein eigener Client).
// Die Proben belegen, dass jede Regel greift. Den Laufzeitnachweis (nur
// GET …/offen und POST …/zugestellt, Bestätigung ohne rol/cli) führt
// jobs/__tests__/tcms-nachrichten-db.test.ts mit dem echten Client.
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

const REGELN: ReadonlyArray<{ name: string; muster: RegExp; erlaubtIn: readonly string[] }> = [
  {
    name: 'Bestätigung SYSTEM',
    muster: /\bknd\s*:\s*['"`]SYSTEM['"`]/,
    erlaubtIn: ['tcms/systemakteur.ts'],
  },
  { name: 'Systemclient', muster: /\bNUR_SYSTEMAKTEUR\b/, erlaubtIn: ['tcms/dienst.ts'] },
  { name: 'TcmsClient', muster: /\bnew\s+TcmsClient\s*\(/, erlaubtIn: ['tcms/dienst.ts'] },
  {
    name: 'Postausgang',
    muster: /\b(?:holeOffeneNachrichten|meldeNachrichtZugestellt)\b/,
    erlaubtIn: ['tcms/dienst.ts'],
  },
  {
    name: 'Endpunktregister',
    muster: /\b(?:rufeEndpunkt|ENDPUNKTE|ENDPUNKT_LISTE)\b/,
    erlaubtIn: [],
  },
  { name: 'generischer Aufruf', muster: /\.aufruf\s*\(/, erlaubtIn: [] },
];

export function verstoesse(datei: string, code: string): string[] {
  return REGELN.filter((r) => !r.erlaubtIn.includes(datei) && r.muster.test(code)).map(
    (r) => r.name,
  );
}

function quellen(verzeichnis: string): string[] {
  return readdirSync(verzeichnis).flatMap((name) => {
    const pfad = join(verzeichnis, name);
    if (statSync(pfad).isDirectory()) return name === '__tests__' ? [] : quellen(pfad);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [pfad] : [];
  });
}

describe('Systemakteur nur an einer Stelle des Workers (TCMS Stufe 4)', () => {
  it('kein Worker-Code außerhalb von tcms/ bildet oder nutzt ihn', () => {
    const dateien = quellen(SRC);
    expect(dateien.length).toBeGreaterThan(40);
    const befunde = dateien.flatMap((pfad) => {
      const datei = relative(SRC, pfad).split(sep).join('/');
      return verstoesse(datei, readFileSync(pfad, 'utf8')).map((r) => `${datei}: ${r}`);
    });
    expect(befunde).toEqual([]);
  });

  it('die erlaubten Stellen enthalten genau das Erwartete', () => {
    const akteur = readFileSync(join(SRC, 'tcms/systemakteur.ts'), 'utf8');
    expect(akteur).toMatch(/knd: 'SYSTEM', nam: TCMS_SYSTEMAKTEUR_NAME/);
    expect(akteur).not.toMatch(/\brol\b\s*:|\bcli\b\s*:/);
    const dienst = readFileSync(join(SRC, 'tcms/dienst.ts'), 'utf8');
    expect(dienst).toMatch(/new TcmsClient\(\{ config, akteurArten: NUR_SYSTEMAKTEUR \}\)/);
  });

  it('Proben: jede Regel erkennt ihren Verstoß', () => {
    const proben: Array<[string, string, string]> = [
      ['jobs/x.ts', "const a = { tnt, sub, knd: 'SYSTEM', nam };", 'Bestätigung SYSTEM'],
      ['jobs/x.ts', 'new TcmsClient({ config, akteurArten: NUR_SYSTEMAKTEUR });', 'Systemclient'],
      ['jobs/x.ts', 'const c = new TcmsClient({ config });', 'TcmsClient'],
      ['jobs/x.ts', 'await meldeNachrichtZugestellt(c, e);', 'Postausgang'],
      ['tcms/dienst.ts', 'await rufeEndpunkt(c, ENDPUNKTE.ich, e);', 'Endpunktregister'],
      ['jobs/x.ts', 'await client.aufruf({ methode: "GET" });', 'generischer Aufruf'],
    ];
    for (const [datei, code, regel] of proben) {
      expect(verstoesse(datei, code), code).toContain(regel);
    }
  });
});
