// Fachkatalog: AUDIT-VERIFY-ALERT-001
import { describe, it, expect, vi } from 'vitest';

// Modul-Import zieht Queue/Redis/Prisma/Evidence — mocken; getestet wird die
// pure Monotonie-Logik gegen Tail-Truncation der unversiegelten Ketten-Spitze.
vi.mock('bullmq', () => ({
  Worker: class {
    on() {
      return this;
    }
  },
}));
vi.mock('@taxtronik/config', () => ({
  env: { AUDIT_VERIFY_REQUIRE_EXTERNAL_TSA: false, TSA_URL: '' },
}));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {},
  LocalTimestampAdapter: class {},
  createRfc3161Adapter: () => ({}),
  AUDIT_VERIFY_RESULT_SETTING_KEY: 'audit.verify.result',
  AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY: 'audit.recovery.checkpoint',
  toPersistedVerifyResult: (x: unknown) => x,
}));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('../../tenant-context', () => ({ withWorkerTenantContext: vi.fn() }));
vi.mock('../../tsa-port', () => ({ timestampPortFor: vi.fn() }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { detectAnchorTailTruncation, detectTailTruncation } from '../audit-verify-check';

/** Minimaler Vorbefund; nur `lastAuditId` ist für die Monotonie relevant. */
function prevWith(lastAuditId: string | null) {
  return { lastAuditId } as unknown as Parameters<typeof detectTailTruncation>[0];
}

describe('detectTailTruncation', () => {
  it('schlaegt an, wenn die hoechste Audit-ID sinkt', () => {
    const reason = detectTailTruncation(prevWith('100'), 90n);
    expect(reason).toContain('100');
    expect(reason).toContain('90');
    expect(reason).toMatch(/Tail-Truncation/);
  });

  it('schlaegt an, wenn die Kette leer ist obwohl zuvor geprueft wurde', () => {
    expect(detectTailTruncation(prevWith('100'), null)).toMatch(/leer/);
  });

  it('schweigt bei wachsender und bei gleicher ID', () => {
    expect(detectTailTruncation(prevWith('100'), 100n)).toBeNull();
    expect(detectTailTruncation(prevWith('100'), 101n)).toBeNull();
  });

  it('schweigt beim ersten Lauf und ohne früheren Anker', () => {
    expect(detectTailTruncation(null, 5n)).toBeNull();
    expect(detectTailTruncation(prevWith(null), 5n)).toBeNull();
  });

  it('vergleicht numerisch, nicht als Zeichenkette', () => {
    // Als String waere "9" > "10" — der Anker muss als BigInt verglichen werden.
    expect(detectTailTruncation(prevWith('10'), 9n)).toMatch(/gesunken/);
    expect(detectTailTruncation(prevWith('9'), 10n)).toBeNull();
  });

  it('erkennt Schrumpf jenseits von 2^53', () => {
    expect(detectTailTruncation(prevWith('9007199254740993'), 9007199254740992n)).toMatch(
      /gesunken/,
    );
  });
});

describe('Regression: Anker ueberlebt einen fehlgeschlagenen Lauf', () => {
  it('erkennt Truncation weiterhin, wenn der Vorlauf mit Fehler endete', () => {
    // Der Fehlerpfad persistiert `lastAuditId: prev?.lastAuditId ?? null`.
    // Wuerde er wie frueher null schreiben, liefe der Folgelauf in
    // "kein frueherer Anker" und die Erkennung waere dauerhaft blind.
    const nachFehlerlauf = prevWith('100');
    expect(detectTailTruncation(nachFehlerlauf, 90n)).toMatch(/gesunken/);
  });
});

describe('detectAnchorTailTruncation', () => {
  function previous(lastAnchorId: string | null) {
    return { lastAnchorId } as unknown as Parameters<typeof detectAnchorTailTruncation>[0];
  }

  it('erkennt eine geloeschte externe Kettenspitze', () => {
    expect(detectAnchorTailTruncation(previous('12'), 11n)).toMatch(/Tail-Truncation/);
    expect(detectAnchorTailTruncation(previous('12'), null)).toMatch(/leer/);
  });

  it('akzeptiert gleichbleibende und wachsende Anchor-IDs', () => {
    expect(detectAnchorTailTruncation(previous('12'), 12n)).toBeNull();
    expect(detectAnchorTailTruncation(previous('12'), 13n)).toBeNull();
    expect(detectAnchorTailTruncation(previous(null), null)).toBeNull();
  });
});
