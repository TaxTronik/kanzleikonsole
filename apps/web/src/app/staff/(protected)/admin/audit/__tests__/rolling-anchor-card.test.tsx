import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PersistedAnchorStatus } from '@taxtronik/evidence';
import { RollingAnchorCard } from '../rolling-anchor-card';
import type { AnchorSummary } from '../audit-page-data';

const summary: AnchorSummary = {
  last_anchored_audit_id: 9007199254741107n,
  tsa_gen_time: new Date('2026-09-14T08:00:00Z'),
  trust_anchored: true,
  pending_count: 0n,
  oldest_pending_at: null,
};

function render(
  overrides: Partial<AnchorSummary> = {},
  status: PersistedAnchorStatus | null = null,
) {
  const value = { ...summary, ...overrides };
  return renderToStaticMarkup(
    <RollingAnchorCard
      summary={value}
      status={status}
      pendingCount={Number(value.pending_count)}
    />,
  );
}

describe('AUDIT-RFC3161-ANCHOR-001: external evidence stays separate from local hashes', () => {
  it('shows a trusted stored anchor and its complete Audit-ID', () => {
    const html = render();
    expect(html).toContain('RFC-3161-verankert bis Audit-ID 9007199254741107');
    expect(html).toContain('Trust-verankert');
    expect(html).toContain('lucide-shield-check');
  });

  it.each([false, null])('does not show success when stored trust is %s', (trust_anchored) => {
    const html = render({ trust_anchored });
    expect(html).toContain('Trust-Anchor fehlt');
    expect(html).not.toContain('lucide-shield-check');
    expect(html).not.toContain('bg-green-50');
  });

  it('shows an empty external history neutrally', () => {
    const html = render({ last_anchored_audit_id: null, tsa_gen_time: null, trust_anchored: null });
    expect(html).toContain('Noch kein externer Rolling-Anker vorhanden');
    expect(html).not.toContain('Kein unverankerter lokaler Restbestand');
    expect(html).not.toContain('bg-green-50');
  });

  it('keeps pending local events and a delayed TSA attempt visible', () => {
    const status: PersistedAnchorStatus = {
      state: 'DELAYED',
      lastAttemptAt: '2026-09-14T08:01:00Z',
      lastSuccessAt: '2026-09-14T08:00:00Z',
      lastAnchoredAuditId: String(summary.last_anchored_audit_id),
      tsaGenTime: '2026-09-14T08:00:00Z',
      trustAnchored: true,
      consecutiveFailures: 1,
      nextRetryAt: '2026-09-14T08:02:00Z',
      error: 'TSA nicht erreichbar',
    };
    const html = render(
      { pending_count: 3n, oldest_pending_at: new Date('2026-09-14T08:00:30Z') },
      status,
    );
    expect(html).toContain('3 lokal verkettete Änderungen warten');
    expect(html).toContain('TSA nicht erreichbar');
    expect(html).toContain('nächster Versuch');
    expect(html).not.toContain('lucide-shield-check');
  });

  it('labels local-only timestamp mode even without an error detail', () => {
    const html = render(
      {},
      {
        state: 'LOCAL_ONLY',
        lastAttemptAt: '2026-09-14T08:01:00Z',
        lastSuccessAt: null,
        lastAnchoredAuditId: null,
        tsaGenTime: null,
        trustAnchored: false,
        consecutiveFailures: 0,
        nextRetryAt: null,
        error: null,
      },
    );
    expect(html).toContain('Zeitstempel-Modus: lokal');
    expect(html).toContain('kein externer TSA-Nachweis');
    expect(html).not.toContain('lucide-shield-check');
  });
});
