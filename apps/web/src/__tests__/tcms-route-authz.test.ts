// =============================================================================
// Struktur-Guardrail (TCMS Stufe 3): Route Handler des Tax-CMS (Datei-Abrufe
// wie Nachweise und Anlagen) beginnen mit dem gemeinsamen Einstieg aus
// server/tcms/route.ts.
//
// Jede `route.ts` unter einem Verzeichnis `tcms` im App-Router
//   1. liegt unter `app/api/staff/` oder `app/api/portal/` (dort greift
//      zusätzlich api-route-authz.test.ts),
//   2. exportiert nur `GET` (Abrufe; Schreiben läuft über Server Actions mit
//      tcmsKanzleiAktion/tcmsPortalAktion),
//   3. ruft in `GET` nach dem Auflösen der Route-Params als ERSTES
//      `await tcmsMandantRoute(<id aus params>)` (Staff) bzw.
//      `await tcmsPortalRoute()` (Portal), importiert nur aus
//      `@/server/tcms/route`,
//   4. greift nicht selbst auf Client, Akteur, Dienst, Seiten-/Aktions-Helfer
//      oder Sitzung zu (nur über den Einstieg).
// Zusätzlich prüft der Test die Reihenfolge im Einstieg selbst: Sitzung
// zuerst, Modulbereich `tcms`, Mandantenzugriff (canAccessClientTx) vor der
// Akteursbestätigung. Die Semantik prüft server/tcms/__tests__/route.test.ts.
//
// Statischer Check über den TS-AST, ohne DB.
// Fachkatalog: TCMS-AKTEUR-001, ACCESS-CLIENT-MODE-001
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = join(SRC, 'app');
const ROUTE_HELFER = join(SRC, 'server', 'tcms', 'route.ts');
const ROUTE_MODUL = '@/server/tcms/route';

/** Direkte Zugänge, die ein TCMS-Route-Handler nicht selbst nutzen darf. */
const VERBOTENE_IMPORTE = [
  '@taxtronik/tcms-client',
  '@/server/tcms/dienst',
  '@/server/tcms/akteur',
  '@/server/tcms/seite',
  '@/server/tcms/aktion',
  '@/server/auth/staff',
  '@/server/auth/portal',
] as const;

const HTTP_METHODEN = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

type Funktion = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (entry === 'route.ts') files.push(path);
  }
  return files;
}

/** Relativer Pfad unter app/ mit `/`. */
function rel(file: string): string {
  return relative(APP_DIR, file).replaceAll('\\', '/');
}

function istTcmsRoute(relPfad: string): boolean {
  return relPfad.split('/').slice(0, -1).includes('tcms');
}

function parse(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function hatModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function istFunktionswert(
  node: ts.Node | undefined,
): node is ts.FunctionExpression | ts.ArrowFunction {
  return !!node && (ts.isFunctionExpression(node) || ts.isArrowFunction(node));
}

/** Exportierte Namen mit ihrer Funktion (falls eine). */
function exporte(source: ts.SourceFile): Map<string, Funktion | null> {
  const ergebnis = new Map<string, Funktion | null>();
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      hatModifier(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      ergebnis.set(statement.name?.text ?? 'default', statement);
    } else if (
      ts.isVariableStatement(statement) &&
      hatModifier(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          ergebnis.set(d.name.text, istFunktionswert(d.initializer) ? d.initializer : null);
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      // `export { GET } from …` / `export { x as POST }` – nicht statisch prüfbar.
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const e of statement.exportClause.elements) ergebnis.set(e.name.text, null);
      } else {
        ergebnis.set('*', null);
      }
    } else if (ts.isExportAssignment(statement)) {
      ergebnis.set('default', null);
    }
  }
  return ergebnis;
}

/** Importierte Module und lokale Namen für `name` aus `modul`. */
function importe(source: ts.SourceFile): {
  module_: string[];
  lokal: (modul: string, name: string) => Set<string>;
} {
  const module_: string[] = [];
  const deklarationen: ts.ImportDeclaration[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      module_.push(statement.moduleSpecifier.text);
      deklarationen.push(statement);
    }
  }
  return {
    module_,
    lokal(modul, name) {
      const namen = new Set<string>();
      for (const d of deklarationen) {
        if ((d.moduleSpecifier as ts.StringLiteral).text !== modul) continue;
        const clause = d.importClause;
        if (!clause || clause.isTypeOnly || !clause.namedBindings) continue;
        if (!ts.isNamedImports(clause.namedBindings)) continue;
        for (const e of clause.namedBindings.elements) {
          if (!e.isTypeOnly && (e.propertyName ?? e.name).text === name) namen.add(e.name.text);
        }
      }
      return namen;
    },
  };
}

/** Aufrufe und awaits in Quelltext-Reihenfolge; verschachtelte Funktionen laufen später. */
function ausgefuehrt(body: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) || ts.isAwaitExpression(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return nodes.sort((a, b) => a.getStart() - b.getStart());
}

/** Alle Aufrufe in Quelltext-Reihenfolge, auch in verschachtelten Funktionen (Einstieg). */
function alleAufrufe(body: ts.Node): ts.CallExpression[] {
  const aufrufe: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) aufrufe.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return aufrufe.sort((a, b) => a.getStart() - b.getStart());
}

function aufrufName(node: ts.Node): string | null {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    ? node.expression.text
    : null;
}

/** Name des zweiten Parameters (`{ params }`) bzw. `ctx` für `ctx.params`. */
function paramsAusdruecke(fn: Funktion): Set<string> {
  const namen = new Set<string>();
  const zweiter = fn.parameters[1];
  if (!zweiter) return namen;
  if (ts.isObjectBindingPattern(zweiter.name)) {
    for (const e of zweiter.name.elements) {
      const property = e.propertyName ?? e.name;
      if (ts.isIdentifier(property) && property.text === 'params' && ts.isIdentifier(e.name)) {
        namen.add(e.name.text);
      }
    }
  } else if (ts.isIdentifier(zweiter.name)) {
    namen.add(`${zweiter.name.text}.params`);
  }
  return namen;
}

/** Namen, die aus `await params` destrukturiert werden. */
function paramNamen(fn: Funktion, params: ReadonlySet<string>): Set<string> {
  const namen = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isAwaitExpression(node.initializer) &&
      params.has(node.initializer.expression.getText()) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      for (const e of node.name.elements) if (ts.isIdentifier(e.name)) namen.add(e.name.text);
    }
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return namen;
}

function istObersteEbene(call: ts.CallExpression, body: ts.Node): boolean {
  const awaited = call.parent;
  if (!ts.isAwaitExpression(awaited)) return false;
  const halter = awaited.parent;
  if (ts.isExpressionStatement(halter)) return halter.parent === body;
  return (
    ts.isVariableDeclaration(halter) &&
    halter.initializer === awaited &&
    ts.isVariableDeclarationList(halter.parent) &&
    ts.isVariableStatement(halter.parent.parent) &&
    halter.parent.parent.parent === body
  );
}

/** Importe und Exporte: keine direkten Zugänge, nur GET. */
function dateiVerstoesse(relPfad: string, source: ts.SourceFile): string[] {
  const verstoesse: string[] = [];
  for (const modul of importe(source).module_) {
    if ((VERBOTENE_IMPORTE as readonly string[]).includes(modul)) {
      verstoesse.push(`${relPfad}: direkter Import von ${modul} (nur über ${ROUTE_MODUL})`);
    }
  }
  for (const name of exporte(source).keys()) {
    if ((HTTP_METHODEN.has(name) && name !== 'GET') || name === '*' || name === 'default') {
      verstoesse.push(`${relPfad}: exportiert ${name} (TCMS-Routen nur GET)`);
    }
  }
  return verstoesse;
}

/** Der Einstieg ist der erste ausgeführte Aufruf in GET, unbedingt awaited, mit passender ID. */
function einstiegVerstoesse(
  relPfad: string,
  source: ts.SourceFile,
  get: Funktion & { body: ts.Block },
  staff: boolean,
): string[] {
  const einstieg = staff ? 'tcmsMandantRoute' : 'tcmsPortalRoute';
  const erlaubt = importe(source).lokal(ROUTE_MODUL, einstieg);
  const params = paramsAusdruecke(get);
  const nodes = ausgefuehrt(get.body);
  const aufruf = nodes.find(
    (n): n is ts.CallExpression => erlaubt.has(aufrufName(n) ?? '') && ts.isCallExpression(n),
  );
  if (!aufruf) return [`${relPfad}#GET: ruft ${einstieg} aus ${ROUTE_MODUL} nicht`];
  const verstoesse: string[] = [];
  const istAufloesung = (n: ts.Node) =>
    ts.isAwaitExpression(n) && params.has(n.expression.getText());
  const davor = nodes.find(
    (n) => n.getStart() < aufruf.getStart() && n !== aufruf.parent && !istAufloesung(n),
  );
  if (davor) {
    verstoesse.push(`${relPfad}#GET: ruft vor ${einstieg}: ${davor.getText().split('\n')[0]}`);
  }
  if (!istObersteEbene(aufruf, get.body)) {
    verstoesse.push(`${relPfad}#GET: ${einstieg} nicht unbedingt auf oberster Ebene awaited`);
  }
  const [id] = aufruf.arguments;
  if (staff && (!id || !ts.isIdentifier(id) || !paramNamen(get, params).has(id.text))) {
    verstoesse.push(`${relPfad}#GET: ${einstieg} nicht mit der Mandanten-ID aus params gerufen`);
  }
  if (!staff && aufruf.arguments.length > 0) {
    verstoesse.push(`${relPfad}#GET: ${einstieg} nimmt keinen Mandanten an (nur aus der Sitzung)`);
  }
  return verstoesse;
}

/** Verstöße einer TCMS-Route-Datei (relativer Pfad unter app/, Quelltext). */
function routeVerstoesse(relPfad: string, text: string): string[] {
  const staff = relPfad.startsWith('api/staff/');
  if (!staff && !relPfad.startsWith('api/portal/')) {
    return [`${relPfad}: TCMS-Route außerhalb von app/api/staff bzw. app/api/portal`];
  }
  const source = parse(relPfad, text);
  const verstoesse = dateiVerstoesse(relPfad, source);
  const get = exporte(source).get('GET');
  if (!get) return [...verstoesse, `${relPfad}: kein statisch prüfbares GET`];
  if (!get.body || !ts.isBlock(get.body)) {
    return [...verstoesse, `${relPfad}#GET: kein Funktionsrumpf`];
  }
  return [
    ...verstoesse,
    ...einstiegVerstoesse(relPfad, source, get as Funktion & { body: ts.Block }, staff),
  ];
}

/** Reihenfolge im Einstieg server/tcms/route.ts. */
function helferVerstoesse(text: string): string[] {
  const source = parse('route.ts', text);
  const export_ = exporte(source);
  const verstoesse: string[] = [];
  const pruefe = (
    name: string,
    sitzung: string,
    vorAkteur: string | null,
    akteur: string,
  ): void => {
    const fn = export_.get(name);
    if (!fn || !fn.body) {
      verstoesse.push(`${name} fehlt`);
      return;
    }
    const aufrufe = alleAufrufe(fn.body);
    const erster = aufrufe[0];
    if (!erster || aufrufName(erster) !== sitzung || !ts.isAwaitExpression(erster.parent)) {
      verstoesse.push(`${name}: erster Aufruf ist nicht await ${sitzung}()`);
    }
    const modul = aufrufe.find(
      (c) =>
        aufrufName(c) === 'isModuleAreaEnabled' &&
        c.arguments[1] !== undefined &&
        ts.isStringLiteral(c.arguments[1]) &&
        c.arguments[1].text === 'tcms',
    );
    if (!modul) verstoesse.push(`${name}: prüft den Modulbereich tcms nicht`);
    const akteurAufruf = aufrufe.find((c) => aufrufName(c) === akteur);
    if (!akteurAufruf) {
      verstoesse.push(`${name}: ruft ${akteur} nicht`);
      return;
    }
    if (modul && modul.getStart() > akteurAufruf.getStart()) {
      verstoesse.push(`${name}: Modulprüfung erst nach ${akteur}`);
    }
    if (vorAkteur) {
      const zugriff = aufrufe.find((c) => aufrufName(c) === vorAkteur);
      if (!zugriff || zugriff.getStart() > akteurAufruf.getStart()) {
        verstoesse.push(`${name}: ${vorAkteur} nicht vor ${akteur}`);
      }
    }
  };
  pruefe('tcmsMandantRoute', 'staffAuth', 'canAccessClientTx', 'kanzleiAkteurTx');
  pruefe('tcmsPortalRoute', 'portalAuth', null, 'portalAkteurTx');
  return verstoesse;
}

const TCMS_ROUTEN = walk(APP_DIR).filter((file) => istTcmsRoute(rel(file)));

describe('Route Handler des Tax-CMS beginnen mit dem gemeinsamen Einstieg', () => {
  it('Einstieg: Sitzung zuerst, Modul tcms, Zugriff vor der Akteursbestätigung', () => {
    expect(helferVerstoesse(readFileSync(ROUTE_HELFER, 'utf8'))).toEqual([]);
  });

  for (const file of TCMS_ROUTEN) {
    it(`${rel(file)}: ${rel(file).startsWith('api/portal/') ? 'tcmsPortalRoute' : 'tcmsMandantRoute'} zuerst, nur GET`, () => {
      expect(routeVerstoesse(rel(file), readFileSync(file, 'utf8'))).toEqual([]);
    });
  }
});

describe('Guard erkennt Verstöße (Selbsttest)', () => {
  const STAFF = 'api/staff/clients/[id]/tcms/nachweise/[nachweisId]/route.ts';
  const PORTAL = 'api/portal/tcms/anlagen/[nachweisId]/route.ts';
  const importStaff = `import { tcmsMandantRoute } from '${ROUTE_MODUL}';\n`;
  const importPortal = `import { tcmsPortalRoute } from '${ROUTE_MODUL}';\n`;
  const get = (rumpf: string) =>
    `export async function GET(req: Request, { params }: { params: Promise<{ id: string; nachweisId: string }> }) {\n${rumpf}\n}\n`;
  const gut =
    'const { id, nachweisId } = await params;\nconst route = await tcmsMandantRoute(id);\nif (!route.ok) return route.antwort;\nreturn liefere(req, route, nachweisId);';

  it('akzeptiert den vorgesehenen Aufbau', () => {
    expect(routeVerstoesse(STAFF, importStaff + get(gut))).toEqual([]);
    expect(
      routeVerstoesse(
        PORTAL,
        importPortal +
          get(
            'const { nachweisId } = await params;\nconst route = await tcmsPortalRoute();\nif (!route.ok) return route.antwort;\nreturn liefere(req, route, nachweisId);',
          ),
      ),
    ).toEqual([]);
  });

  it('findet fehlenden oder späten Einstieg, falschen Import und falsche ID', () => {
    expect(routeVerstoesse(STAFF, get(gut))).toEqual([
      `${STAFF}#GET: ruft tcmsMandantRoute aus ${ROUTE_MODUL} nicht`,
    ]);
    expect(
      routeVerstoesse(STAFF, "import { tcmsMandantRoute } from './eigen';\n" + get(gut)),
    ).toEqual([`${STAFF}#GET: ruft tcmsMandantRoute aus ${ROUTE_MODUL} nicht`]);
    expect(
      routeVerstoesse(
        STAFF,
        importStaff +
          get(
            'const { id } = await params;\nconst d = await ladeDokument(id);\nconst route = await tcmsMandantRoute(id);\nreturn d;',
          ),
      ),
    ).toEqual([`${STAFF}#GET: ruft vor tcmsMandantRoute: await ladeDokument(id)`]);
    expect(
      routeVerstoesse(
        STAFF,
        importStaff +
          get(
            "const { id } = await params;\nconst route = await tcmsMandantRoute('fest');\nreturn route;",
          ),
      ),
    ).toEqual([`${STAFF}#GET: tcmsMandantRoute nicht mit der Mandanten-ID aus params gerufen`]);
    expect(
      routeVerstoesse(
        STAFF,
        importStaff +
          get(
            'const { id } = await params;\nif (id) { await tcmsMandantRoute(id); }\nreturn null;',
          ),
      ),
    ).toEqual([`${STAFF}#GET: tcmsMandantRoute nicht unbedingt auf oberster Ebene awaited`]);
  });

  it('findet Schreib-Exporte, direkte Zugänge und falsche Orte', () => {
    const quelle =
      importStaff +
      "import { tcmsClient } from '@/server/tcms/dienst';\n" +
      get(gut) +
      'export async function POST() { return null; }\n';
    expect(routeVerstoesse(STAFF, quelle)).toEqual([
      `${STAFF}: direkter Import von @/server/tcms/dienst (nur über ${ROUTE_MODUL})`,
      `${STAFF}: exportiert POST (TCMS-Routen nur GET)`,
    ]);
    expect(routeVerstoesse('staff/(protected)/tcms/x/route.ts', importStaff + get(gut))).toEqual([
      'staff/(protected)/tcms/x/route.ts: TCMS-Route außerhalb von app/api/staff bzw. app/api/portal',
    ]);
    expect(
      routeVerstoesse(
        PORTAL,
        importPortal + get('const route = await tcmsPortalRoute(MANDANT);\nreturn route;'),
      ),
    ).toEqual([`${PORTAL}#GET: tcmsPortalRoute nimmt keinen Mandanten an (nur aus der Sitzung)`]);
  });

  it('findet eine falsche Reihenfolge im Einstieg', () => {
    const helfer = readFileSync(ROUTE_HELFER, 'utf8');
    const ohneZugriff = helfer.replace(
      /if \(!\(await canAccessClientTx\(tx, session, mandantId\)\)\) return abbruch\('NICHT_GEFUNDEN'\);/,
      '',
    );
    expect(ohneZugriff).not.toBe(helfer);
    expect(helferVerstoesse(ohneZugriff)).toEqual([
      'tcmsMandantRoute: canAccessClientTx nicht vor kanzleiAkteurTx',
    ]);
    const modulAus = helfer.replaceAll("'tcms')) return abbruch", "'risk')) return abbruch");
    expect(helferVerstoesse(modulAus)).toEqual([
      'tcmsMandantRoute: prüft den Modulbereich tcms nicht',
      'tcmsPortalRoute: prüft den Modulbereich tcms nicht',
    ]);
    const sitzungSpaet = helfer.replace(
      'const session = await staffAuth();',
      'await readModules(null as never);\n  const session = await staffAuth();',
    );
    expect(helferVerstoesse(sitzungSpaet)).toEqual([
      'tcmsMandantRoute: erster Aufruf ist nicht await staffAuth()',
    ]);
  });
});
