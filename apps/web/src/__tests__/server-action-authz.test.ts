// =============================================================================
// Struktur-Guardrail: jede exportierte Server-Action MUSS eine Autorisierung
// referenzieren (direkt ein Auth-Primitiv ODER einen auth-tragenden Helfer
// derselben Datei). Fängt die „versehentlich gelöschte Authz-Zeile" über ALLE
// ~225 Actions ab — ohne DB, statisch über den TS-AST.
//
// Das ist ein PRÄSENZ-Check, kein Korrektheits-Beweis (richtiger Tenant/Owner
// prüfen die RLS-/Action-Tests). Aber er verhindert die häufigste Regression:
// eine Action, die gar nicht mehr autorisiert.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');

// Bewusste Ausnahmen (Datei-Ebene): Auth-Eintrittspunkte etablieren erst
// Identität (Login / öffentlicher Token), haben also KEINE Session zu prüfen.
const ALLOWLIST_FILES = [
  'gwg-onboarding/actions.ts', // öffentlicher GwG-Onboarding-Token (Magic-Link)
  'portal/(auth)/login/actions.ts', // Magic-Link-Login
  'staff/(auth)/login/actions.ts', // Passwort/TOTP-Login
];

// Bewusste Ausnahmen (Funktions-Ebene): token-basierte öffentliche Actions in
// sonst staff-geschützten Dateien — sie autorisieren über Besitz eines Tokens.
const ALLOWLIST_FNS = new Set([
  // öffentlicher PoA-Signatur-Flow per rawToken (+ OTP) — keine vorgelagerte
  // Session; autorisiert über Token-Besitz (elektronischer PoA-Bestätigungsprozess).
  'staff/(protected)/poa/sign-actions.ts::signPoaAction',
  'staff/(protected)/poa/sign-actions.ts::requestSigningOtpAction',
]);

// Bekannte Autorisierungs-Primitive (Session/Tenant/Ownership) inkl. der
// zentralen Staff- UND Portal-Helfer (kapseln staffAuth/portalAuth + Kontext).
const PRIMITIVE =
  /\b(staffAuth|portalAuth|requireStaffSession|requireStaffAdmin|requireClientAccess|requireSubsumtionAccess|canAccessClient|staffActionGuard|withStaff|portalActionGuard|withPortalContext)\b/;

// Delegation: ruft die Action eine ANDERE *Action auf, ist die Autorisierung dort
// garantiert (jene Action wird von diesem Guardrail selbst geprüft → Transitivität).
// Zählt NUR, wenn das Ziel in der Menge der gesammelten exportierten Action-Namen
// liegt — ein beliebiger lokaler `fooAction(`-Aufruf wäre sonst ein Freifahrtschein.
const DELEGATION_CALL = /\b(\w+Action)\s*\(/g;

function walkActionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkActionFiles(p));
    else if (/actions\.ts$/.test(entry)) out.push(p);
  }
  return out;
}

interface Fn {
  name: string;
  exported: boolean;
  body: string;
}

function isExported(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );
}

/** Top-Level-Funktionen (Declarations + arrow/function-consts) mit Body-Text. */
function topLevelFns(src: ts.SourceFile): Fn[] {
  const fns: Fn[] = [];
  src.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      fns.push({ name: node.name.text, exported: isExported(node), body: node.body.getText(src) });
    } else if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      for (const d of node.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          fns.push({ name: d.name.text, exported, body: d.initializer.getText(src) });
        }
      }
    }
  });
  return fns;
}

const files = walkActionFiles(APP_DIR).filter((f) =>
  readFileSync(f, 'utf8').includes("'use server'"),
);

// ---------------------------------------------------------------------------
// Import-Aufloesung fuer geteilte Guards: Beim Aufteilen grosser Action-Dateien
// wandern auth-tragende Helfer (guard*, claimCheckMutation, …) in ein
// gemeinsames Modul OHNE 'use server'. Der Praesenz-Check muss solche Helfer
// weiter erkennen — sonst waere jede aufgeteilte Datei faelschlich rot und die
// Aufteilung wuerde bestraft. Aufgeloest werden NUR relative Importe (./ ../),
// rekursiv mit Zyklus-Schutz; Aliase (@/server/…) bleiben bewusst aussen vor:
// zentrale Module sind schon ueber PRIMITIVE abgedeckt.
// ---------------------------------------------------------------------------

/** Auth-tragende Top-Level-Funktionen einer Datei (transitiv innerhalb der
 *  Datei UND ueber deren relative Importe). Gecacht + zyklusfest. */
const authFnCache = new Map<string, Set<string>>();

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(fromFile), spec);
  for (const cand of [base + '.ts', base + '.tsx', join(base, 'index.ts')]) {
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      /* nicht vorhanden */
    }
  }
  return null;
}

function importedFnsBySource(src: ts.SourceFile): Map<string, string[]> {
  const bySpec = new Map<string, string[]>();
  src.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly) return;
    const names: string[] = [];
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        if (!el.isTypeOnly) names.push(el.name.text);
      }
    }
    if (names.length > 0) bySpec.set(node.moduleSpecifier.text, names);
  });
  return bySpec;
}

function authCarryingFns(file: string, seen: Set<string> = new Set()): Set<string> {
  const cached = authFnCache.get(file);
  if (cached) return cached;
  if (seen.has(file)) return new Set(); // Zyklus → keine neuen Erkenntnisse
  seen.add(file);

  let src: ts.SourceFile;
  try {
    src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  } catch {
    return new Set();
  }
  const fns = topLevelFns(src);

  // Basis: direkte Primitive + auth-tragende Importe aus relativen Modulen.
  const auth = new Set<string>(fns.filter((f) => PRIMITIVE.test(f.body)).map((f) => f.name));
  for (const [spec, names] of importedFnsBySource(src)) {
    const target = resolveRelative(file, spec);
    if (!target) continue;
    const targetAuth = authCarryingFns(target, seen);
    for (const n of names) if (targetAuth.has(n)) auth.add(n);
  }

  // Fixpunkt: Helfer, die auth-tragende Helfer aufrufen, tragen selbst.
  for (let davor = -1; davor !== auth.size; ) {
    davor = auth.size;
    for (const f of fns) {
      if (auth.has(f.name)) continue;
      if ([...auth].some((h) => new RegExp(`\\b${h}\\b`).test(f.body))) auth.add(f.name);
    }
  }

  authFnCache.set(file, auth);
  return auth;
}

// Erster Pass: Surface sammeln (alle Top-Level-Funktionen je Datei) + Menge
// der exportierten Action-Namen — das Delegations-Ziel muss darin liegen.
const parsedFiles = files.map((file) => {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  return { file, fns: topLevelFns(src) };
});
const exportedActionNames = new Set(
  parsedFiles.flatMap(({ fns }) =>
    fns.filter((f) => f.exported && /Action$/.test(f.name)).map((f) => f.name),
  ),
);

/** True, wenn der Body eine ANDERE gesammelte exportierte Action aufruft. */
function delegatesToKnownAction(body: string, self: string): boolean {
  for (const m of body.matchAll(DELEGATION_CALL)) {
    const target = m[1]!;
    if (target !== self && exportedActionNames.has(target)) return true;
  }
  return false;
}

describe('Server-Actions sind autorisiert (Struktur-Guardrail)', () => {
  it('findet die Server-Action-Fläche', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  for (const { file, fns } of parsedFiles) {
    const rel = relative(APP_DIR, file).replace(/\\/g, '/');
    if (ALLOWLIST_FILES.some((a) => rel === a || rel.endsWith('/' + a))) continue;

    // Auth-tragende Helfer derselben Datei (z. B. `guard`, `guardAnalysis`): ihr
    // Body enthält selbst ein Primitiv → ein Aufruf gilt als Autorisierung.
    //
    // Transitiv aufgelöst: Ein Helfer, der einen auth-tragenden Helfer aufruft,
    // trägt die Autorisierung ebenfalls (z. B. `guardAnalysisWrite` → ruft
    // `guardAnalysis` → enthält `requireSubsumtionAccess`). Ohne diese Auflösung
    // erzwingt der Guard flache Helfer und bestraft genau die Schichtung, die
    // Schreib- von Leserechten trennt. Seit der Aufteilung der grossen
    // Action-Dateien loest `authCarryingFns` zusaetzlich ueber relative
    // Importe auf (geteilte Guard-Module ohne 'use server').
    const authHelpers = [...authCarryingFns(file)];
    const authorized = (fn: Fn) =>
      PRIMITIVE.test(fn.body) ||
      delegatesToKnownAction(fn.body, fn.name) ||
      authHelpers.some((h) => new RegExp(`\\b${h}\\b`).test(fn.body));

    const actions = fns.filter(
      (f) => f.exported && /Action$/.test(f.name) && !ALLOWLIST_FNS.has(`${rel}::${f.name}`),
    );

    it(`${rel}: alle Actions referenzieren eine Autorisierung`, () => {
      const missing = actions.filter((a) => !authorized(a)).map((a) => a.name);
      expect(
        missing,
        `Ohne Auth-Referenz (staffAuth/portalAuth/guard*/require*/canAccessClient): ${missing.join(', ')}`,
      ).toEqual([]);
    });
  }
});
