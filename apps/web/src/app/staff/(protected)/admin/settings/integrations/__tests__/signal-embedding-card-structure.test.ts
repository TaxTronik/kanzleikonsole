import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const card = readFileSync(new URL('../signal-embedding-card.tsx', import.meta.url), 'utf8');
const page = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');

describe('Signal-Embedding-Card', () => {
  it('bleibt auf Aus oder wöchentlich begrenzt und wird vom globalen Settings-Guard ignoriert', () => {
    expect(card).toContain('<option value="off">Aus</option>');
    expect(card).toContain('<option value="weekly">Wöchentlich (alle 7 Tage)</option>');
    expect(card.match(/data-settings-no-track/g) ?? []).toHaveLength(2);
    expect(card).toContain("choice === 'weekly' ? { enabled: true, intervalDays: 7 }");
  });

  it('bestätigt den Force-Refresh, sperrt aktive Jobs und pollt den Serverstatus', () => {
    expect(card).toContain('window.confirm(');
    expect(card).toContain('triggerSignalEmbeddingAction()');
    expect(card).toContain('disabled={disabled || pending || polling}');
    expect(card).toContain('window.setInterval(() => router.refresh(), 2_500)');
    expect(card).toContain('const polling = !disabled && remoteJobActive');
    expect(card).not.toContain('acceptedJobId');
  });

  it('lädt und zeigt den Status nur bei aktivem Modul und erreichbarer Engine', () => {
    expect(page).toContain('if (modules.signalEngine)');
    expect(page).toContain('signalEngine?.ok !== true');
    expect(page).toContain('await new RiskLayerClient().embeddingStatus()');
    expect(page).toContain('{modules.signalEngine && (');
  });

  it('zeigt die eindeutige Embedding-Input-Identitaet getrennt vom Graphstand', () => {
    expect(card).toContain('Input-Fingerprint');
    expect(card).toContain('status.index.input_fingerprint');
    expect(card).toContain('Graph-Fingerprint');
  });
});
