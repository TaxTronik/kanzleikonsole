// =============================================================================
// Struktur-Guardrail (Review-Befund F-03): einheitliches Fehler-Mapping.
//
// toActionError reicht nur ActionError (und Unterklassen), UnauthorizedError und
// ForbiddenError durch; Datenbank- und Storage-Fehler ordnet es über Prisma-Code/
// SQLSTATE bzw. Fehlerklasse ein. Damit das trägt, gilt statisch über den TS-AST:
//   1. Kein `throw new Error(…)`/`throw Error(…)` in Server-Action-Modulen und
//      Action-Helfern — ein fachlicher Fehler wäre im UI nur „Unerwarteter
//      Fehler“. Ausnahmen sind echte Invarianten (Allowlist mit Begründung).
//   2. Kein `<schema>.parse(…)` in Server-Action-Modulen: Eingaben per
//      `safeParse`/`parseActionInput`, damit Validierung zum Feld-/Action-Fehler
//      wird statt zum ZodError.
//   3. Keine rohe Fehlermeldung (`error: e.message`, `${(e as Error).message}`) in
//      Action-Ergebnissen; erlaubt sind nur Fälle, in denen die Klasse vorher
//      geprüft wurde und die Meldung bewusst UI-tauglich ist (Allowlist).
// Allowlists sind dateigenau mit Anzahl; sinkt eine Zahl, wird sie abgesenkt.
// =============================================================================

import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { hasUseServerDirective, parseSource, walkProductSources } from './use-server-sources';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Helfer, deren Fehler direkt in Action-Ergebnisse laufen (zusätzlich zu 'use server').
 * K-03: dazu die aus Action-Dateien herausgelösten Services (n8n-Einstellungen,
 * Retag, Vollmachten) — ihr Code war vorher als 'use server' erfasst.
 */
const ACTION_HELPER_PREFIXES = ['server/actions/', 'server/risk/', 'server/n8n-settings/'];
const ACTION_HELPER_FILES = new Set([
  'server/db/assert-tenant.ts',
  'server/documents/retag.ts',
  'server/forms/validate-answers.ts',
  'server/gwg-onboarding/submission-transaction.ts',
  'server/n8n/client.ts',
  'server/poa/create-poa.ts',
  'server/poa/revoke-poa.ts',
  'server/poa/send-for-signature.ts',
  'server/privacy/consent-catalog.ts',
  'server/settings/modules.ts',
  'server/settings/portal-features.ts',
]);

type Allowance = { n: number; why: string };

/** Echte Invarianten: Schlüssel `datei::Meldungsanfang` (max. 48 Zeichen). */
const INVARIANT_THROWS: Readonly<Record<string, Allowance>> = {
  'app/staff/(protected)/admin/gwg-retention/actions.ts::STORAGE_VERSION_ID_MISSING: DocumentVersion ':
    {
      n: 1,
      why: 'Betriebsinvariante; der Text landet nur in gwg_destruction_error, das UI zeigt eine feste Meldung.',
    },
  'app/staff/(protected)/admin/gwg-retention/actions.ts::GwG-Vernichtungsfunktion hat keinen Abschlussver':
    {
      n: 1,
      why: 'Nachweis der SECURITY-DEFINER-Funktion fehlt; Diagnose in gwg_destruction_error, UI feste Meldung.',
    },
  'app/staff/(protected)/admin/gwg-retention/actions.ts::GwG-Vernichtungsfunktion lieferte keinen Abschlu':
    {
      n: 1,
      why: 'Rückgabevertrag der DB-Funktion verletzt; das UI zeigt eine feste Meldung.',
    },
  'app/staff/(protected)/admin/gwg-retention/actions.ts::GwG-Vernichtungsfunktion lieferte einen abweiche':
    {
      n: 1,
      why: 'Mandantenbezug der DB-Funktion widerspricht dem Check; Rollback, das UI zeigt eine feste Meldung.',
    },
  'server/risk/los.ts::Quantenlos erfordert einen Staff-Kontext (actorI': {
    n: 2,
    why: 'Die Actions laufen ausschließlich mit Staff-Guard; ein fehlender Akteur ist ein Programmierfehler.',
  },
  'server/risk/research.ts::completed research callback receipt has no resul': {
    n: 1,
    why: 'Datenbankvertrag des Callback-Belegs verletzt (Invariante, kein Bedienfehler).',
  },
};

/** `.parse(` bewusst ohne safeParse: Schlüssel `datei::Schema-Ausdruck`. */
const PARSE_ALLOWLIST: Readonly<Record<string, Allowance>> = {
  'app/payroll/employee/actions.ts::z.coerce.number().int().nonnegative()': {
    n: 1,
    why: 'payrollAction ordnet ZodError fachlich ein („Eingaben und Pflichtfelder prüfen.“).',
  },
  "app/payroll/employee/actions.ts::z.union([z.uuid(), z.literal('')])": {
    n: 1,
    why: 'payrollAction ordnet ZodError fachlich ein („Eingaben und Pflichtfelder prüfen.“).',
  },
  'app/portal/(protected)/payroll/actions.ts::z.uuid()': {
    n: 1,
    why: 'guardPayrollEmployer → payrollAction ordnet ZodError fachlich ein.',
  },
  "app/portal/(protected)/payroll/actions.ts::z.union([z.uuid(), z.literal('')])": {
    n: 1,
    why: 'guardPayrollEmployer → payrollAction ordnet ZodError fachlich ein.',
  },
  'app/staff/(protected)/payroll/actions.ts::z.uuid()': {
    n: 1,
    why: 'guardPayrollStaff → payrollAction ordnet ZodError fachlich ein.',
  },
  "app/staff/(protected)/payroll/actions.ts::z.union([z.uuid(), z.literal('')])": {
    n: 1,
    why: 'guardPayrollStaff → payrollAction ordnet ZodError fachlich ein.',
  },
  'app/portal/(protected)/interactions/actions.ts::noticeDecisionSnapshot': {
    n: 1,
    why: 'Prüft einen gespeicherten Snapshot (Invariante), keine Eingabe.',
  },
  'app/staff/(protected)/interactions/actions.ts::noticeDecisionSnapshot': {
    n: 1,
    why: 'Prüft den serverseitig gebauten Snapshot vor dem Speichern (Invariante).',
  },
};

/** Typisierte, bewusst UI-taugliche Meldungen: Schlüssel `datei::Ausdruck`. */
const TYPED_MESSAGE_ALLOWLIST: Readonly<Record<string, Allowance>> = {
  'app/staff/(protected)/admin/users/actions.ts::error.message': {
    n: 2,
    why: 'Nur HardwareAccessUnavailableError/-VerificationError (feste Meldungen der WebAuthn-Schicht).',
  },
  'app/staff/(protected)/clients/[id]/bwa/actions.ts::e.message': {
    n: 1,
    why: 'Nur XlsxReadError (bewusst formulierte Lesefehler der hochgeladenen Datei).',
  },
  'app/staff/(protected)/clients/[id]/elster/actions.ts::e.message': {
    n: 2,
    why: 'ElsterKontoabfrageInputError und ElsterBridgeHttpError (nutzdatenfreie Meldungen).',
  },
  'app/staff/(protected)/clients/[id]/subsumtion/actions.ts::e.message': {
    n: 2,
    why: 'Nur UnsupportedDocumentTypeError (unterstützte Dateitypen für den Sachverhalt).',
  },
  'app/staff/(protected)/poa/actions.ts::e.message': {
    n: 1,
    why: 'Nur ActionError, ergänzt um den Hinweis auf das gespeicherte PDF.',
  },
  'app/staff/(protected)/profile/actions.ts::error.message': {
    n: 1,
    why: 'Nur HardwareAccessUnavailableError/-VerificationError (feste Meldungen der WebAuthn-Schicht).',
  },
};

function repoRelative(file: string): string {
  return relative(SRC_DIR, file).split(sep).join('/');
}

function isActionHelper(path: string): boolean {
  return ACTION_HELPER_FILES.has(path) || ACTION_HELPER_PREFIXES.some((p) => path.startsWith(p));
}

function literalHead(node: ts.Expression | undefined): string {
  if (!node) return '<ohne Meldung>';
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.slice(0, 48);
  }
  if (ts.isTemplateExpression(node)) return node.head.text.slice(0, 48);
  return `<${ts.SyntaxKind[node.kind]}>`;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function count(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** 1. `throw new Error(…)` und `throw Error(…)`. */
export function plainErrorThrows(source: ts.SourceFile, file: string): Map<string, number> {
  const hits = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isThrowStatement(node) && node.expression) {
      const thrown = unwrap(node.expression);
      if (
        (ts.isNewExpression(thrown) || ts.isCallExpression(thrown)) &&
        ts.isIdentifier(thrown.expression) &&
        thrown.expression.text === 'Error'
      ) {
        count(hits, `${file}::${literalHead(thrown.arguments?.[0])}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

const NON_SCHEMA_PARSERS = new Set(['JSON', 'Date', 'Number', 'URL', 'path']);

/** 2. `<schema>.parse(…)` (nicht JSON.parse & Co.). */
export function schemaParseCalls(source: ts.SourceFile, file: string): Map<string, number> {
  const hits = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'parse'
    ) {
      const target = node.expression.expression;
      if (!(ts.isIdentifier(target) && NON_SCHEMA_PARSERS.has(target.text))) {
        count(hits, `${file}::${target.getText(source).replaceAll(/\s+/g, ' ')}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

/** `x.message` bzw. `(x as Error).message` auf einem Bezeichner (nicht `issue.message` o. Ä.). */
function isRawMessageAccess(node: ts.Node): node is ts.PropertyAccessExpression {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'message') return false;
  const target = unwrap(node.expression);
  return ts.isIdentifier(target) && !/^(?:issue|i|first|parsed)$/.test(target.text);
}

/** 3. Rohe Fehlermeldungen im `error`-Feld von Action-Ergebnissen. */
export function rawMessageResults(source: ts.SourceFile, file: string): Map<string, number> {
  const hits = new Map<string, number>();
  const inspect = (node: ts.Node): void => {
    if (isRawMessageAccess(node)) count(hits, `${file}::${node.getText(source)}`);
    ts.forEachChild(node, inspect);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'error'
    ) {
      inspect(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function collect(
  files: readonly string[],
  inspect: (source: ts.SourceFile, file: string) => Map<string, number>,
): Record<string, number> {
  const all = new Map<string, number>();
  for (const file of files) {
    for (const [key, n] of inspect(parseSource(file), repoRelative(file))) {
      all.set(key, (all.get(key) ?? 0) + n);
    }
  }
  return Object.fromEntries([...all].sort(([a], [b]) => a.localeCompare(b)));
}

function expected(allowlist: Readonly<Record<string, Allowance>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(allowlist)
      .map(([key, value]) => [key, value.n] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

const productFiles = walkProductSources(SRC_DIR);
const actionModules = productFiles.filter((file) => hasUseServerDirective(parseSource(file)));
const helperModules = productFiles.filter((file) => isActionHelper(repoRelative(file)));

describe('Fehler-Mapping-Guardrail (F-03)', () => {
  it('erkennt Wurf, parse und rohe Meldung in Fixtures', () => {
    const fixture = ts.createSourceFile(
      'fixture.ts',
      `
        function a() { throw new Error('Fachfehler.'); }
        function b() { throw Error(\`Vorlage \${x}\`); }
        function c() { throw new ActionError('ok'); }
        const d = Schema.parse(input);
        const e = JSON.parse(text);
        const f = Schema.safeParse(input);
        const g = { ok: false, error: (err as Error).message };
        const h = { ok: false, error: \`Fehler: \${e.message}\` };
        const i = { ok: false, error: parsed.error.issues[0]?.message ?? 'x' };
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(Object.fromEntries(plainErrorThrows(fixture, 'f.ts'))).toEqual({
      'f.ts::Fachfehler.': 1,
      'f.ts::Vorlage ': 1,
    });
    expect(Object.fromEntries(schemaParseCalls(fixture, 'f.ts'))).toEqual({ 'f.ts::Schema': 1 });
    expect(Object.fromEntries(rawMessageResults(fixture, 'f.ts'))).toEqual({
      'f.ts::(err as Error).message': 1,
      'f.ts::e.message': 1,
    });
  });

  it('Server-Actions und Action-Helfer werfen Fachfehler nur als ActionError', () => {
    expect(
      collect([...new Set([...actionModules, ...helperModules])], plainErrorThrows),
      'Fachfehler als ActionError werfen; echte Invarianten mit Begründung in INVARIANT_THROWS.',
    ).toEqual(expected(INVARIANT_THROWS));
  });

  it('Server-Actions prüfen Eingaben per safeParse statt parse', () => {
    expect(
      collect(actionModules, schemaParseCalls),
      'safeParse/parseActionInput verwenden; Ausnahmen mit Begründung in PARSE_ALLOWLIST.',
    ).toEqual(expected(PARSE_ALLOWLIST));
  });

  it('Server-Actions geben keine rohen Fehlermeldungen zurück', () => {
    expect(
      collect(actionModules, rawMessageResults),
      'toActionError bzw. eine Klassen-Einordnung verwenden; typisierte UI-Meldungen in TYPED_MESSAGE_ALLOWLIST.',
    ).toEqual(expected(TYPED_MESSAGE_ALLOWLIST));
  });
});
