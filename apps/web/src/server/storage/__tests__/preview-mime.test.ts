// =============================================================================
// Unit-Tests: MIME-Whitelist für Inline-Previews (preview-mime.ts).
//
// Sicherheitskern: text/html, SVG & Co. dürfen NIE inline ausgeliefert werden
// (Stored-XSS über hochgeladene Dateien), und text/plain bekommt seit
// Audit 2026-06 Befund 4 zusätzlich `Content-Security-Policy: sandbox` —
// die Inline-Anzeige hängt damit nicht mehr allein an nosniff.
//
// sanitizeFilenameForHeader (@taxtronik/storage) ist hier gemockt
// (Identität): der Sanitizer hat eigene Tests im storage-Paket; Unit under
// test ist die Whitelist-/Header-Logik.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';

vi.mock('@taxtronik/storage', () => ({
  sanitizeFilenameForHeader: (s: string) => s,
}));

import {
  filenameWithExtension,
  isInlineSafeMime,
  previewContentType,
  previewDisposition,
  previewSecurityHeaders,
} from '../preview-mime';

describe('isInlineSafeMime', () => {
  it('Whitelist: PDF, Bilder, text/plain → true', () => {
    for (const m of ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain']) {
      expect(isInlineSafeMime(m)).toBe(true);
    }
  });

  it('aktive Inhalte: text/html, SVG, JS, XML → false', () => {
    for (const m of ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/javascript', 'application/xml']) {
      expect(isInlineSafeMime(m)).toBe(false);
    }
  });

  it('normalisiert Parameter und Groß-/Kleinschreibung', () => {
    expect(isInlineSafeMime('text/plain; charset=utf-8')).toBe(true);
    expect(isInlineSafeMime('TEXT/PLAIN')).toBe(true);
    expect(isInlineSafeMime('text/HTML; charset=utf-8')).toBe(false);
  });

  it('leer/null/undefined → false (fail-closed)', () => {
    expect(isInlineSafeMime(null)).toBe(false);
    expect(isInlineSafeMime(undefined)).toBe(false);
    expect(isInlineSafeMime('')).toBe(false);
  });
});

describe('previewDisposition / previewContentType', () => {
  it('sichere MIME → inline mit Original-Content-Type', () => {
    expect(previewDisposition('application/pdf', 'Bescheid')).toBe('inline; filename="Bescheid.pdf"');
    expect(previewContentType('application/pdf')).toBe('application/pdf');
  });

  it('unsichere MIME → attachment + application/octet-stream', () => {
    expect(previewDisposition('text/html', 'boese')).toMatch(/^attachment; /);
    expect(previewContentType('text/html')).toBe('application/octet-stream');
  });

  it('alte/falsch gespeicherte PDFs werden anhand MIME-Variante oder Dateiname inline dargestellt', () => {
    expect(previewContentType('application/x-pdf', 'Vollmacht')).toBe('application/pdf');
    expect(previewDisposition('application/octet-stream', 'Vollmacht.pdf')).toBe('inline; filename="Vollmacht.pdf"');
    expect(previewContentType('application/octet-stream', 'Vollmacht.pdf')).toBe('application/pdf');
  });
});

describe('filenameWithExtension', () => {
  it('ergänzt die kanonische Endung aus der MIME', () => {
    expect(filenameWithExtension('Bescheid 2025', 'application/pdf')).toBe('Bescheid 2025.pdf');
    expect(filenameWithExtension('notizen', 'text/plain; charset=utf-8')).toBe('notizen.txt');
  });

  it('lässt vorhandene korrekte Endung (case-insensitive) stehen', () => {
    expect(filenameWithExtension('scan.PDF', 'application/pdf')).toBe('scan.PDF');
  });

  it('unbekannte MIME / leerer Name → kein Raten', () => {
    expect(filenameWithExtension('blob', 'application/x-unbekannt')).toBe('blob');
    expect(filenameWithExtension('   ', 'application/pdf')).toBe('download.pdf');
  });
});

describe('previewSecurityHeaders (Audit 2026-06 Befund 4)', () => {
  it('text/plain → CSP sandbox (auch mit charset-Parameter / Großschreibung)', () => {
    expect(previewSecurityHeaders('text/plain')).toEqual({
      'content-security-policy': 'sandbox',
    });
    expect(previewSecurityHeaders('text/plain; charset=utf-8')).toEqual({
      'content-security-policy': 'sandbox',
    });
    expect(previewSecurityHeaders('TEXT/PLAIN')).toEqual({
      'content-security-policy': 'sandbox',
    });
  });

  it('PDF bleibt ohne sandbox (Chromium-PDF-Viewer würde sonst blockieren)', () => {
    expect(previewSecurityHeaders('application/pdf')).toEqual({});
  });

  it('Bilder und unsichere MIME (laufen ohnehin als attachment) → keine Extra-Header', () => {
    expect(previewSecurityHeaders('image/png')).toEqual({});
    expect(previewSecurityHeaders('text/html')).toEqual({});
  });
});
