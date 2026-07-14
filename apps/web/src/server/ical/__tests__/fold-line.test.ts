// =============================================================================
// Unit-Tests: ICS-Zeilenfaltung (foldLine, RFC 5545 §3.1).
//
// Kernanforderungen:
//   - Faltung nach OKTETTEN (UTF-8), nicht nach JS-String-Länge.
//   - Nie mitten in einem Multibyte-Zeichen / Surrogatpaar brechen.
//   - Fortsetzungszeilen beginnen mit genau einem Leerzeichen.
//   - Rekonstruktion (Entfalten) ergibt exakt die Eingabe.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';

// feed.ts lädt @taxtronik/config (env) beim Import — im Test mocken, damit die
// ENV-Validierung (SMTP etc.) nicht anschlägt. foldLine selbst nutzt kein env.
vi.mock('@taxtronik/config', () => ({
  env: { AUTH_SECRET: 'test-secret-mit-mindestens-32-zeichen!!' },
}));

import { foldLine } from '../feed';

/** Kehrt die Faltung um: CRLF + führendes Leerzeichen entfernen. */
function unfold(folded: string): string {
  return folded.replace(/\r\n /g, '');
}

/** Größte Oktett-Länge über alle physischen Zeilen. */
function maxOctets(folded: string): number {
  return Math.max(...folded.split('\r\n').map((l) => Buffer.byteLength(l, 'utf8')));
}

describe('foldLine', () => {
  it('kurze ASCII-Zeile bleibt unverändert (keine Faltung)', () => {
    const line = 'SUMMARY:Kurzer Termin';
    expect(foldLine(line)).toBe(line);
    expect(foldLine(line)).not.toContain('\r\n');
  });

  it('Zeile mit exakt 75 Oktetten wird nicht gefaltet', () => {
    const line = 'X'.repeat(75);
    expect(Buffer.byteLength(line, 'utf8')).toBe(75);
    expect(foldLine(line)).toBe(line);
  });

  it('lange ASCII-Zeile: jede physische Zeile ≤ 75 Oktette, Roundtrip exakt', () => {
    const line = 'DESCRIPTION:' + 'a'.repeat(400);
    const folded = foldLine(line);
    expect(folded).toContain('\r\n');
    expect(maxOctets(folded)).toBeLessThanOrEqual(75);
    expect(unfold(folded)).toBe(line);
  });

  it('Fortsetzungszeilen beginnen mit genau einem Leerzeichen', () => {
    const folded = foldLine('a'.repeat(300));
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const cont of parts.slice(1)) {
      expect(cont.startsWith(' ')).toBe(true);
      expect(cont.startsWith('  ')).toBe(false);
    }
  });

  it('Umlaute (2 Oktette) sprengen das Limit nicht und bleiben intakt', () => {
    // 60 Umlaute = 120 Oktette > 75 → muss gefaltet werden.
    const line = 'X-WR-CALNAME:' + 'ä'.repeat(60);
    const folded = foldLine(line);
    expect(maxOctets(folded)).toBeLessThanOrEqual(75);
    expect(unfold(folded)).toBe(line);
    // Kein zerschnittenes Zeichen → kein UTF-8-Ersatzzeichen.
    expect(folded).not.toContain('�');
  });

  it('Emoji (Surrogatpaar, 4 Oktette) wird nie mitten im Zeichen gebrochen', () => {
    // Füllung so wählen, dass eine naive Zeichen-/Byte-Grenze mitten ins Emoji fiele.
    for (let pad = 70; pad <= 78; pad++) {
      const line = 'SUMMARY:' + 'a'.repeat(pad) + '😀Ende';
      const folded = foldLine(line);
      expect(maxOctets(folded)).toBeLessThanOrEqual(75);
      // Entfaltet identisch — Surrogatpaar unversehrt.
      expect(unfold(folded)).toBe(line);
      expect(folded).not.toContain('�');
    }
  });
});
