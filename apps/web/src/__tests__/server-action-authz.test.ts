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
  'staff/(protected)/poa/actions.ts::signPoaAction',
  'staff/(protected)/poa/actions.ts::requestSigningOtpAction',
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
    const authHelpers = fns.filter((f) => PRIMITIVE.test(f.body)).map((f) => f.name);
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
