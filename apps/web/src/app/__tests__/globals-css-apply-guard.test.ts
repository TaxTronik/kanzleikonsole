// =============================================================================
// CSS-Guard: kein @apply mit semantischen Custom-Token-Klassen
//
// Hintergrund: Tailwind v4's @apply löst Custom-Klassen aus `@layer utilities`
// (z. B. `text-muted`, `bg-surface`, `border-default`) NICHT zuverlässig
// während des PostCSS-Builds auf. Folge ist ein harter Build-Error à la
//   "Cannot apply unknown utility class `text-muted`"
// — der dev-server kracht, Pages werden 500, und der Fehler ist erst beim
// nächsten Browser-Reload sichtbar (TypeScript fängt's nicht).
//
// Wir umgehen das in Component-Klassen, indem wir die Token-Properties
// DIREKT setzen statt über @apply (`color: rgb(var(--text-muted))`).
//
// Dieser Test stellt sicher, dass globals.css NIE ein Custom-Token via @apply
// referenziert — auch wenn neue Komponenten dazukommen.
// =============================================================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const CSS_PATH = resolve(__dirname, '../globals.css');

const FORBIDDEN_IN_APPLY = [
  // Text-Tokens
  'text-primary',
  'text-secondary',
  'text-muted',
  'text-disabled',
  // Surface-Tokens
  'bg-surface',
  'bg-surface-page',
  'bg-surface-raised',
  'bg-surface-sunken',
  // Border-Tokens
  'border-default',
  'border-strong',
  'border-subtle',
  // Divide-Tokens
  'divide-border-default',
  'divide-border-subtle',
];

describe('globals.css @apply guard', () => {
  const css = readFileSync(CSS_PATH, 'utf8');

  // Extrahiere jeden @apply-Inhalt (alles bis zum nächsten Semikolon).
  // Regex erlaubt Multiline, falls eine @apply-Liste sehr lang wird.
  const applyStatements = [...css.matchAll(/@apply\s+([^;]+);/g)].map((m) => ({
    body: m[1]!,
    // Zeilennummer für hilfreiche Fehlermeldungen
    line: css.slice(0, m.index!).split('\n').length,
  }));

  it('finds at least one @apply statement (sanity)', () => {
    expect(applyStatements.length).toBeGreaterThan(0);
  });

  for (const forbidden of FORBIDDEN_IN_APPLY) {
    it(`does not reference \`${forbidden}\` inside any @apply`, () => {
      // Wort-Grenze: matched nur exakte Klassen-Namen, nicht z. B.
      // `text-mutedish` oder als Teil von `dark:text-muted`.
      // (Tailwind erlaubt Modifier wie `hover:`/`dark:` davor — das wäre auch
      // ein @apply-Problem, also auch fangen.)
      const pattern = new RegExp(String.raw`(^|\s|:)${forbidden.replace(/-/g, '\\-')}(?=\s|$)`);
      const hits = applyStatements.filter((s) => pattern.test(s.body));
      if (hits.length > 0) {
        const details = hits.map((h) => `  Line ${h.line}: @apply ${h.body.trim()};`).join('\n');
        throw new Error(
          `'\`${forbidden}\`' wird via @apply benutzt — Tailwind v4 löst Custom-Tokens nicht über @apply auf.\n` +
            `Setze die CSS-Property stattdessen direkt (z. B. \`color: rgb(var(--text-muted))\`).\n\n` +
            `Fundstellen in globals.css:\n${details}`,
        );
      }
      expect(hits).toEqual([]);
    });
  }
});
