// =============================================================================
// Auflösung der vertrauenswürdigen TSA-Trust-Anchors.
//
// Der eingebaute Default deckt nur GlobalSign R6 ab (den kostenlosen
// Standard-Anbieter). Wer eine eIDAS-qualifizierte TSA einsetzt (D-Trust,
// Swisscom, …), muss deren self-signed Root out-of-band hinterlegen, damit
// verifyTimestampResponse `valid` (voll trust-verankert) liefert. Ohne diesen
// Anker schlägt die Verifikation fail-closed fehl.
//
// Konfiguration (On-Premise-freundlich): `TSA_TRUSTED_ROOTS_FILE` zeigt auf
// eine PEM-Datei mit einem ODER mehreren `-----BEGIN CERTIFICATE-----`-Blöcken.
// Diese werden mit dem eingebauten Default gemergt. Fehlt die Datei oder ist
// sie unlesbar, wird NICHT hart gefailt (die Hash-Kette trägt weiterhin) — es
// wird eine Warnung auf stderr geschrieben und der Default verwendet.
// =============================================================================

import { readFileSync } from 'node:fs';
import { DEFAULT_TSA_TRUSTED_ROOTS } from './globalsign-roots';

const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

let cached: readonly string[] | null = null;

/**
 * Vertrauens-Roots für die RFC-3161-Verifikation: eingebauter Default plus
 * optionale Operator-Roots aus `TSA_TRUSTED_ROOTS_FILE`. Ergebnis wird
 * prozessweit gecacht (die Datei ändert sich zur Laufzeit nicht).
 */
export function resolveTsaTrustedRoots(): readonly string[] {
  if (cached) return cached;

  const file = process.env['TSA_TRUSTED_ROOTS_FILE']?.trim();
  if (!file) {
    cached = DEFAULT_TSA_TRUSTED_ROOTS;
    return cached;
  }

  try {
    const content = readFileSync(file, 'utf8');
    const blocks = content.match(PEM_CERT_RE) ?? [];
    if (blocks.length === 0) {
      process.stderr.write(
        `[evidence] TSA_TRUSTED_ROOTS_FILE (${file}) enthält kein PEM-Zertifikat — nutze Default-Roots.\n`,
      );
      cached = DEFAULT_TSA_TRUSTED_ROOTS;
      return cached;
    }
    // Dedupe (falls der Default-Root auch in der Datei liegt) über normalisierten Body.
    const seen = new Set(DEFAULT_TSA_TRUSTED_ROOTS.map((p) => p.replace(/\s+/g, '')));
    const extra = blocks.filter((b) => !seen.has(b.replace(/\s+/g, '')));
    cached = [...DEFAULT_TSA_TRUSTED_ROOTS, ...extra];
    return cached;
  } catch (e) {
    process.stderr.write(
      `[evidence] TSA_TRUSTED_ROOTS_FILE (${file}) nicht lesbar: ${(e as Error).message} — nutze Default-Roots.\n`,
    );
    cached = DEFAULT_TSA_TRUSTED_ROOTS;
    return cached;
  }
}

/** Nur für Tests: den prozessweiten Cache zurücksetzen. */
export function __resetTsaRootsCache(): void {
  cached = null;
}
