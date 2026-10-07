// Fachkatalog: AUDIT-VERIFY-ALERT-001
import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ notify: vi.fn(), withWorkerTenantContext: vi.fn() }));

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
vi.mock('@taxtronik/crypto', () => ({
  deriveAuditCheckpointMacKey: () => Buffer.alloc(32, 7),
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
vi.mock('../../tenant-context', () => ({ withWorkerTenantContext: h.withWorkerTenantContext }));
vi.mock('../../notify', () => ({ notify: h.notify }));
vi.mock('../../tsa-port', () => ({ timestampPortFor: vi.fn() }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  FULL_VERIFY_BUDGET_MS,
  FULL_VERIFY_INTERVAL_MS,
  acceptsPreviousTailRecovery,
  checkpointedVerifyOptions,
  detectAnchorTailTruncation,
  detectTailTruncation,
  evaluateTenantVerification,
  failedRunVerifyResult,
  manualProgressMessage,
  notifyAuditBreak,
  pendingFullVerification,
  preserveMonotonicId,
} from '../audit-verify-check';

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

describe('AUDIT-VERIFY-ALERT-001: persistierte Monotonie und Recovery', () => {
  it('senkt einen einmal beobachteten Audit-/Anchor-Endpunkt nie ab', () => {
    expect(preserveMonotonicId('100', '90')).toBe('100');
    expect(preserveMonotonicId('100', null)).toBe('100');
    expect(preserveMonotonicId('100', '101')).toBe('101');
    expect(preserveMonotonicId(null, '5')).toBe('5');
  });

  it('akzeptiert nur einen neuen Checkpoint nach dem dokumentierten Tail-Befund', () => {
    const previous = {
      ok: false,
      error: null,
      checkedAt: '2026-09-01T08:00:00.000Z',
      policyBreaks: ['Höchste Audit-ID gesunken (Tail-Truncation).'],
    } as never;
    expect(
      acceptsPreviousTailRecovery(previous, {
        auditId: '101',
        createdAt: '2026-09-01T08:05:00.000Z',
      } as never),
    ).toBe(true);
    expect(
      acceptsPreviousTailRecovery(previous, {
        auditId: '80',
        createdAt: '2026-08-31T08:00:00.000Z',
      } as never),
    ).toBe(false);
  });

  it('prüft täglich ab dem Prüf-Checkpoint und erzwingt bei manuellen Läufen die Vollprüfung', () => {
    // P-04: fortsetzbare Vollprüfung ab Genesis, sobald die letzte mindestens
    // sieben Tage zurückliegt; zehn Minuten Budget je Lauf.
    expect(FULL_VERIFY_INTERVAL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(FULL_VERIFY_BUDGET_MS).toBe(10 * 60 * 1000);
    expect(checkpointedVerifyOptions(false)).toEqual({
      requireExternalTsa: false,
      checkpointKey: Buffer.alloc(32, 7),
      fullVerifyIntervalMs: FULL_VERIFY_INTERVAL_MS,
      fullVerifyBudgetMs: FULL_VERIFY_BUDGET_MS,
      forceFullVerify: false,
      progressAnchor: null,
    });
    expect(checkpointedVerifyOptions(true).forceFullVerify).toBe(true);
  });

  it('meldet eine nicht abgeschlossene Vollprüfung als laufend statt abgeschlossen', () => {
    expect(pendingFullVerification({})).toBeNull();
    expect(
      pendingFullVerification({
        incremental: {
          mode: 'incremental',
          startAuditId: 10n,
          rowsHashed: 5,
          lastFullVerifiedAt: null,
          fullVerification: { startedAt: new Date(), auditId: 70n, targetAuditId: 900n },
        },
      }),
    ).toEqual({ auditId: 70n, targetAuditId: 900n });
    const message = manualProgressMessage({ auditId: 70n, targetAuditId: 900n });
    expect(message.title).toBe('Audit-Vollpruefung laeuft');
    expect(message.body).toContain('bis Audit-ID 70 von 900');
    expect(message.body).not.toContain('abgeschlossen:');
  });

  it('grenzt Lauf-Exceptions nicht per Checkpoint als Recovery ab', () => {
    expect(
      acceptsPreviousTailRecovery(
        {
          ok: false,
          error: 'database unavailable',
          checkedAt: '2026-09-01T08:00:00.000Z',
          policyBreaks: ['Tail-Truncation'],
        } as never,
        { auditId: '101', createdAt: '2026-09-01T08:05:00.000Z' } as never,
      ),
    ).toBe(false);
  });
});

describe('B15: Fortschrittsanker im persistierten Prüfergebnis', () => {
  const anchor = {
    incrementalVerifiedAt: '2026-10-07T01:00:00.000Z',
    sweep: { sweepId: 'sweep-1', verifiedAt: '2026-10-07T01:05:00.000Z', auditId: '70' },
    mac: 'ab'.repeat(32),
  };

  it('reicht den Anker des vorigen Ergebnisses in den nächsten Prüflauf', () => {
    expect(checkpointedVerifyOptions(false, anchor).progressAnchor).toBe(anchor);
    expect(checkpointedVerifyOptions(true).progressAnchor).toBeNull();
  });

  it('speichert den Anker dieses Laufs, auch wenn er einen Befund meldet', () => {
    const result = {
      ok: false,
      checked: 40,
      firstBreak: null,
      lastAuditId: 90n,
      lastAnchorId: null,
      lastAnchoredAuditId: null,
      sealBreaks: [],
      anchorBreaks: [],
      policyBreaks: ['Stand der laufenden Vollprüfung liegt hinter … (Manipulationsverdacht).'],
      incremental: {
        mode: 'incremental',
        startAuditId: 80n,
        rowsHashed: 7,
        lastFullVerifiedAt: null,
        fullVerification: null,
        progressAnchor: anchor,
      },
    };
    const outcome = evaluateTenantVerification(
      null,
      {
        checkedAt: new Date('2026-10-07T02:00:00.000Z'),
        result: result as never,
        recoveryResult: null,
        recovered: false,
      },
      'request-1',
    );
    expect(outcome.freshFailure).toBe(true);
    expect(outcome.persisted.progressAnchor).toBe(anchor);
  });

  it('übernimmt Monotonie- und Fortschrittsanker in das Ergebnis eines Fehlerlaufs', () => {
    const previous = {
      lastAuditId: '100',
      lastAnchorId: '7',
      lastAnchoredAuditId: '90',
      progressAnchor: anchor,
    } as never;
    expect(
      failedRunVerifyResult({
        checkedAt: new Date('2026-10-07T03:00:00.000Z'),
        requestId: null,
        previous,
        errorMessage: 'database unavailable',
      }),
    ).toMatchObject({
      ok: false,
      error: 'database unavailable',
      checkedAt: '2026-10-07T03:00:00.000Z',
      lastAuditId: '100',
      lastAnchorId: '7',
      lastAnchoredAuditId: '90',
      progressAnchor: anchor,
    });
    expect(
      failedRunVerifyResult({
        checkedAt: new Date(),
        requestId: null,
        previous: null,
        errorMessage: 'x',
      }).progressAnchor,
    ).toBeNull();
  });
});

describe('notifyAuditBreak (R-11)', () => {
  it('meldet über notify() an aktive ADMIN/PARTNER, Schlüssel inkl. Bruchstelle', async () => {
    const tx = {
      staffUser: { findMany: vi.fn().mockResolvedValue([{ id: 'a-1' }, { id: 'p-1' }]) },
    };
    h.withWorkerTenantContext.mockImplementation(
      async (_tenantId: string, fn: (value: unknown) => Promise<unknown>) => fn(tx),
    );
    h.notify.mockResolvedValue({ created: 2, updated: 0 });

    await notifyAuditBreak('tenant-1', { body: 'Bruch bei 42', resourceId: '42' });

    expect(tx.staffUser.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        active: true,
        roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
      },
      select: { id: true },
    });
    // Früher überschrieb ein Upsert resourceId einer offenen Meldung — das
    // verbietet der Scope-Trigger. Jetzt gehört die Bruchstelle zum Schlüssel.
    expect(h.notify).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        staffId: 'a-1',
        kind: 'SYSTEM_AUDIT_BREAK',
        resourceType: 'audit_log',
        resourceId: '42',
        body: 'Bruch bei 42',
      }),
      expect.objectContaining({ staffId: 'p-1', resourceId: '42' }),
    ]);
  });
});
