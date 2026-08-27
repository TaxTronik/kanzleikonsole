// =============================================================================
// Struktur-Guardrail: geschuetzte API-Routes muessen das passende Auth-Primitiv
// referenzieren. UI-/Server-Action-Tests reichen nicht fuer direkte API-Zugriffe:
// eine neue route.ts unter /api/staff oder /api/portal darf nicht versehentlich
// ohne staffAuth/portalAuth entstehen.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry === 'route.ts') out.push(p);
  }
  return out;
}

const protectedRouteFiles = walk(join(APP_DIR, 'api')).filter((file) => {
  const rel = relative(APP_DIR, file).replace(/\\/g, '/');
  return rel.startsWith('api/staff/') || rel.startsWith('api/portal/');
});

interface AlternativeAuth {
  reason: string;
  validate: (source: string) => boolean;
}

const validatesKnowledgeStaffActionGuard = (source: string): boolean =>
  /import\s+\{[^}]*\bstaffActionGuard\b[^}]*\}\s+from\s+['"]@\/server\/actions\/staff-action['"]/.test(
    source,
  ) && /staffActionGuard\s*\(\s*\{\s*module:\s*['"]knowledge['"]\s*\}\s*\)/.test(source);

const ALTERNATIVE_AUTH: Record<string, AlternativeAuth> = {
  // Die Wissens-Anhangsrouten brauchen neben der Staff-Session zugleich die
  // Modulfreigabe und nutzen deshalb den zentralen Guard, der beides koppelt.
  'api/staff/knowledge/attachments/route.ts': {
    reason: 'der zentrale Staff-Action-Guard bindet Session und Wissensmodul zusammen',
    validate: validatesKnowledgeStaffActionGuard,
  },
  'api/staff/knowledge/attachments/[id]/route.ts': {
    reason: 'der zentrale Staff-Action-Guard bindet Session und Wissensmodul zusammen',
    validate: validatesKnowledgeStaffActionGuard,
  },
  // Token-gated Kalenderfeed fuer externe Kalender-Apps. verifyIcalToken()
  // ist hier das Auth-Primitive; eine Session waere fuer ICS-Abos ungeeignet.
  'api/portal/ical/[token]/route.ts': {
    reason: 'der Kalenderfeed muss sein dediziertes iCal-Token validieren',
    validate: (source) => /\bverifyIcalToken\s*\(/.test(source),
  },
  // Selbstheilungs-Logout mit zwei bewusst verschiedenen Vertrauensstufen:
  // GET darf nur lokale Cookies loeschen (kein globaler Session-Widerruf);
  // POST darf global widerrufen, muss dafuer aber Same-Origin pruefen und das
  // Widerrufssubjekt aus der signierten Staff-Session ableiten. Die engen
  // Aufrufmuster verhindern, dass ein blosses Importieren der Helfer genuegt.
  'api/staff/force-logout/route.ts': {
    reason:
      'GET darf nur lokal bereinigen; POST braucht Same-Origin und ein sessiongebundenes Widerrufssubjekt',
    validate: (source) =>
      /export\s+async\s+function\s+GET\s*\([^)]*\)[\s\S]*?return\s+logout\s*\(\s*req\s*,\s*false\s*\)/.test(
        source,
      ) &&
      /export\s+async\s+function\s+POST\s*\([^)]*\)[\s\S]*?assertSameOrigin\s*\(\s*req\s*,\s*env\.NEXTAUTH_URL\s*\)[\s\S]*?return\s+logout\s*\(\s*req\s*,\s*true\s*\)/.test(
        source,
      ) &&
      /if\s*\(\s*revoke\s*\)[\s\S]*?staffSessionSubject\s*\(\s*\)[\s\S]*?revokeAllSessions\s*\(\s*['"]staff['"]\s*,\s*staffId\s*\)/.test(
        source,
      ) &&
      /\bstaffSignOut\s*\(\s*\{\s*redirect:\s*false\s*\}\s*\)/.test(source),
  },
  // Portal-Logout bleibt bei defekter Auth.js-Abmeldung cookie-seitig
  // selbstheilend. Der zustandsaendernde globale Widerruf ist aber nur nach
  // Same-Origin-Pruefung zulaessig und wird an das signierte Session-Subjekt
  // gebunden; auch hier reicht die blosse Helfer-Praesenz nicht.
  'api/portal/logout/route.ts': {
    reason:
      'POST braucht Same-Origin und ein aus der signierten Portal-Session abgeleitetes Widerrufssubjekt',
    validate: (source) =>
      /export\s+async\s+function\s+POST\s*\([^)]*\)[\s\S]*?assertSameOrigin\s*\(\s*req\s*,\s*portalBaseUrl\s*\)[\s\S]*?if\s*\(\s*csrf\s*\)\s*return\s+csrf/.test(
        source,
      ) &&
      /portalSessionSubject\s*\(\s*\)[\s\S]*?revokeAllSessions\s*\(\s*['"]portal['"]\s*,\s*contactId\s*\)/.test(
        source,
      ) &&
      /\bportalSignOut\s*\(\s*\{\s*redirect:\s*false\s*\}\s*\)/.test(source),
  },
};

describe('geschuetzte API-Routes sind autorisiert (Struktur-Guardrail)', () => {
  it('findet die Staff-/Portal-API-Route-Flaeche', () => {
    expect(protectedRouteFiles.length).toBeGreaterThan(20);
  });

  for (const file of protectedRouteFiles) {
    const rel = relative(APP_DIR, file).replace(/\\/g, '/');
    const source = readFileSync(file, 'utf8');
    const expectedPrimitive = rel.startsWith('api/staff/') ? 'staffAuth' : 'portalAuth';
    const alternative = ALTERNATIVE_AUTH[rel];

    it(`${rel}: referenziert ${expectedPrimitive} oder dokumentierte Alternative`, () => {
      const hasExpected = source.includes(expectedPrimitive);
      const hasAlternative = alternative?.validate(source) ?? false;
      expect(
        hasExpected || hasAlternative,
        `${rel} muss ${expectedPrimitive} oder eine explizit dokumentierte Alternative nutzen` +
          (alternative ? ` (${alternative.reason}).` : '.'),
      ).toBe(true);
    });
  }
});
