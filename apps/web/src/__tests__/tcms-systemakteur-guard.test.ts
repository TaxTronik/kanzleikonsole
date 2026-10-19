// =============================================================================
// TCMS Stufe 4: Die Web-App bildet keinen Systemakteur (ADR 0001 §3.4 des
// TCMS-Repos; Aufgabe kk-tcms-s4).
//
// Den Systemakteur – Dienstnutzer je Tenant, der den Postausgang abholt und
// Zustellungen bestätigt – bildet und signiert allein der Zustell-Worker
// (apps/worker/src/tcms/). Zwei Schichten halten die Web-App davon fern:
//   1. Laufzeit: Der Client der Web-App (server/tcms/dienst.ts) ist mit
//      PERSONEN_AKTEURE gebaut und signiert keinen Systemakteur
//      (server/tcms/__tests__/dienst.test.ts).
//   2. Quelltext (dieser Guard): Kein Produktionscode unter apps/web/src
//      formt eine Bestätigung der Art SYSTEM, baut einen eigenen Client,
//      wählt Akteursarten außer PERSONEN_AKTEURE, ruft den Postausgang oder
//      importiert Worker-Code. Die Proben belegen, dass jede Regel greift.
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB_SRC = fileURLToPath(new URL('..', import.meta.url));
const DIENST = 'server/tcms/dienst.ts';

interface Regel {
  name: string;
  muster: RegExp;
  /** Datei (relativ zu apps/web/src), in der das Muster erlaubt ist. */
  erlaubtIn?: string;
}

const REGELN: readonly Regel[] = [
  { name: 'Akteursart SYSTEM', muster: /\bknd\s*:\s*(?:['"`]SYSTEM['"`]|[A-Za-z_$][\w$.]*\b)/ },
  {
    name: 'Akteursart SYSTEM als Wert',
    muster: /['"`]SYSTEM['"`]\s+as\s+const|knd\s*===?\s*['"`]SYSTEM/,
  },
  { name: 'Systemclient', muster: /\bNUR_SYSTEMAKTEUR\b|akteurArten\s*:\s*\[/ },
  { name: 'Akteursarten', muster: /\bakteurArten\b/, erlaubtIn: DIENST },
  { name: 'eigener TcmsClient', muster: /\bnew\s+TcmsClient\s*\(/, erlaubtIn: DIENST },
  {
    name: 'Postausgang',
    muster:
      /\b(?:holeOffeneNachrichten|meldeNachrichtZugestellt|nachrichtenOffenLesen|nachrichtZugestelltMelden)\b|\/v1\/nachrichten\//,
  },
  {
    name: 'Worker-Code',
    muster: /from\s+['"](?:@taxtronik\/worker|(?:\.\.\/)+(?:apps\/)?worker\/)/,
  },
];

/** Verstöße einer Datei (Pfad relativ zu apps/web/src). */
export function systemakteurVerstoesse(datei: string, code: string): string[] {
  const treffer: string[] = [];
  for (const regel of REGELN) {
    if (regel.erlaubtIn === datei) continue;
    if (regel.muster.test(code)) treffer.push(regel.name);
  }
  return treffer;
}

function istTest(pfad: string): boolean {
  return pfad.split(sep).includes('__tests__') || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(pfad);
}

function quellen(verzeichnis: string): string[] {
  const dateien: string[] = [];
  for (const name of readdirSync(verzeichnis)) {
    const pfad = join(verzeichnis, name);
    if (statSync(pfad).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      dateien.push(...quellen(pfad));
    } else if (/\.[cm]?[jt]sx?$/.test(name) && !istTest(pfad)) {
      dateien.push(pfad);
    }
  }
  return dateien;
}

describe('Web-App bildet keinen Systemakteur (TCMS Stufe 4)', () => {
  it('kein Produktionscode unter apps/web/src verletzt eine Regel', () => {
    const dateien = quellen(WEB_SRC);
    expect(dateien.length).toBeGreaterThan(500);
    const verstoesse = dateien.flatMap((pfad) => {
      const datei = relative(WEB_SRC, pfad).split(sep).join('/');
      return systemakteurVerstoesse(datei, readFileSync(pfad, 'utf8')).map(
        (regel) => `${datei}: ${regel}`,
      );
    });
    expect(verstoesse).toEqual([]);
  });

  it('der Client der Web-App bestätigt ausdrücklich nur Personen', () => {
    const dienst = readFileSync(join(WEB_SRC, DIENST), 'utf8');
    expect(dienst).toMatch(/new TcmsClient\(\{ config, akteurArten: PERSONEN_AKTEURE \}\)/);
    expect(dienst.match(/new TcmsClient\(/g)).toHaveLength(1);
  });

  it('Proben: jede Regel erkennt ihren Verstoß', () => {
    const proben: Array<[string, string, string]> = [
      ['server/x.ts', "const a = { tnt, sub, knd: 'SYSTEM', nam };", 'Akteursart SYSTEM'],
      ['server/x.ts', 'const art = KND; const a = { knd: art };', 'Akteursart SYSTEM'],
      ['server/x.ts', "const art = 'SYSTEM' as const;", 'Akteursart SYSTEM als Wert'],
      ['server/x.ts', 'new TcmsClient({ config, akteurArten: NUR_SYSTEMAKTEUR });', 'Systemclient'],
      [
        'server/tcms/dienst.ts',
        "new TcmsClient({ config, akteurArten: ['SYSTEM'] });",
        'Systemclient',
      ],
      ['server/x.ts', 'const c = new TcmsClient({ config });', 'eigener TcmsClient'],
      ['server/x.ts', 'await holeOffeneNachrichten(client, { akteur, limit: 1 });', 'Postausgang'],
      [
        'server/x.ts',
        'await rufeEndpunkt(c, ENDPUNKTE.nachrichtZugestelltMelden, e);',
        'Postausgang',
      ],
      ['server/x.ts', 'await fetch(`${url}/v1/nachrichten/offen`);', 'Postausgang'],
      [
        'server/x.ts',
        "import { x } from '@taxtronik/worker/src/tcms/systemakteur';",
        'Worker-Code',
      ],
      ['server/x.ts', "import { x } from '../../../worker/src/tcms/systemakteur';", 'Worker-Code'],
    ];
    for (const [datei, code, regel] of proben) {
      expect(systemakteurVerstoesse(datei, code), code).toContain(regel);
    }
    // Erlaubt: Personen-Bestätigungen und der eine Client in dienst.ts.
    expect(
      systemakteurVerstoesse(DIENST, 'new TcmsClient({ config, akteurArten: PERSONEN_AKTEURE });'),
    ).toEqual([]);
    expect(
      systemakteurVerstoesse(
        'server/tcms/akteur.ts',
        "return { tnt, sub, knd: 'KANZLEI' as const };",
      ),
    ).toEqual([]);
  });
});
