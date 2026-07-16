import { describe, expect, it, vi } from 'vitest';

// dispatch.ts zieht transitiv die ENV-Validierung (config) — für die reinen
// Render-Helfer werden die Modul-Seiteneffekte weggemockt (wie im
// Nachbar-Test dispatch-profile-context.test.ts).
vi.mock('@/server/mail/send', () => ({ sendMail: vi.fn() }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: vi.fn() }));
vi.mock('@/server/settings/mail-dispatch', () => ({ readMailDispatch: vi.fn() }));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn() } }));

import { plainTextBody, renderTemplate } from '../dispatch';
import { renderSafeMarkdown } from '@/server/markdown';

const SENTINEL_RANGE = /[-]/;

describe('renderTemplate — vertrauenswürdige System-URLs', () => {
  it('lässt {{link}}/{{portalUrl}} unescapt, damit der Autolinker greift', () => {
    const url = 'https://portal.example.de/portal/requests/abc_def-123';
    for (const name of ['link', 'portalUrl']) {
      const body = renderTemplate(`Öffnen: {{${name}}}`, { [name]: url }, { forMarkdown: true });
      expect(body).toBe(`Öffnen: ${url}`);
      expect(SENTINEL_RANGE.test(body)).toBe(false);
      // HTML-Teil: echter klickbarer <a>-Link statt reinem Text.
      expect(renderSafeMarkdown(body)).toContain(`<a href="${url}"`);
    }
  });

  it('escapt Nicht-URL-Werte auch unter vertrauenswürdigen Namen (fail-closed)', () => {
    const body = renderTemplate(
      'Öffnen: {{link}}',
      { link: '**kein** Link https://evil.example' },
      { forMarkdown: true },
    );
    // Wert sieht nicht wie eine reine URL aus → normales Variablen-Escaping.
    expect(body).toContain('\\*\\*kein\\*\\*');
    expect(SENTINEL_RANGE.test(body)).toBe(true);
  });

  it('escapt User-Variablen weiterhin (Anti-Phishing-Sentinel bleibt)', () => {
    const body = renderTemplate(
      'Hallo {{client.name}}',
      { client: { name: 'Besuchen Sie https://evil.example' } },
      { forMarkdown: true },
    );
    expect(SENTINEL_RANGE.test(body)).toBe(true);
    expect(renderSafeMarkdown(body)).not.toContain('<a href="https://evil.example"');
  });
});

describe('plainTextBody — text/plain ohne Sentinels und Backslash-Escapes', () => {
  it('entfernt PUA-Sentinels aus URLs (kein U+E005 im Schema)', () => {
    const escaped = renderTemplate(
      'Login: {{userText}}',
      { userText: 'https://example.de/pfad' },
      { forMarkdown: true },
    );
    expect(SENTINEL_RANGE.test(escaped)).toBe(true);
    const text = plainTextBody(escaped);
    expect(SENTINEL_RANGE.test(text)).toBe(false);
    expect(text).toBe('Login: https://example.de/pfad');
  });

  it('nimmt Markdown-Backslash-Escapes zurück (base64url-Tokens mit _)', () => {
    expect(plainTextBody('token=abc\\_def und \\*stern\\*')).toBe('token=abc_def und *stern*');
  });
});
