import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const wizard = readFileSync(new URL('../wizard.tsx', import.meta.url), 'utf8');

describe('GwG-Onboarding – explizite Doppelrollen-UX', () => {
  it('startet neutral und blockiert Weiter ohne bewusste Rollenentscheidung', () => {
    expect(wizard).toContain('linkedOwnerId: undefined');
    expect(wizard).toContain('— bitte ausdrücklich auswählen —');
    expect(wizard).toContain('representative.linkedOwnerId === undefined');
    expect(wizard).toContain('Bitte entscheiden Sie ausdrücklich');
  });

  it('übermittelt stabile lokale IDs und entweder Owner-Link oder eigenen Ausweis', () => {
    expect(wizard).toContain('linkedOwnerLocalId: representative.linkedOwnerId ?? null');
    expect(wizard).toContain('idFrontDocumentId: representative.idFront?.documentId ?? null');
    expect(wizard).toContain('Ja – {owner.fullName');
    expect(wizard).toContain('Nein – eigenständige Person erfassen');
  });
});
