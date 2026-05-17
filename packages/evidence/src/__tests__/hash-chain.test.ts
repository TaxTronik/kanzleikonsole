// =============================================================================
// Hash-Chain-Tests — synthetische Kette ohne DB.
//
// Stellt sicher, dass die Hash-Berechnung für Audit-Events deterministisch
// ist und dass eine 3-Event-Kette korrekt verifiziert wird. Bei jedem
// Refactoring der Hash-Logik (Algorithmus / Genesis / canonical_json)
// schlägt das hier an, BEVOR es in Produktion bricht.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../canonical-json';

const GENESIS_PREFIX = Buffer.from('taxtronik-genesis:', 'utf8');

function genesisHash(tenantId: string): Buffer {
  return createHash('sha256').update(GENESIS_PREFIX).update(Buffer.from(tenantId, 'utf8')).digest();
}

function chainHash(prev: Buffer, event: Record<string, unknown>): Buffer {
  const canonical = Buffer.from(canonicalJson(event), 'utf8');
  return createHash('sha256').update(prev).update(canonical).digest();
}

interface AuditRow {
  id: number;
  tenantId: string;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  prevHash: Buffer;
  thisHash: Buffer;
}

function buildEvent(row: AuditRow) {
  return {
    tenantId: row.tenantId,
    occurredAt: row.occurredAt,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    before: row.before ?? null,
    after: row.after ?? null,
  };
}

describe('Hash-Chain — Aufbau und Verifikation', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';

  it('Genesis-Hash ist deterministisch pro Tenant', () => {
    const a = genesisHash(tenantId);
    const b = genesisHash(tenantId);
    expect(a.equals(b)).toBe(true);
    expect(a).toHaveLength(32);
  });

  it('Genesis unterscheidet sich pro Tenant', () => {
    const t1 = genesisHash('00000000-0000-0000-0000-000000000001');
    const t2 = genesisHash('00000000-0000-0000-0000-000000000002');
    expect(t1.equals(t2)).toBe(false);
  });

  it('3-Event-Kette: jeder Hash hängt vom vorherigen ab', () => {
    const events = [
      {
        tenantId,
        occurredAt: '2025-05-10T12:00:00.000Z',
        actorType: 'STAFF',
        actorId: 's1',
        action: 'client.create',
        resourceType: 'client',
        resourceId: 'c1',
        before: null,
        after: { name: 'Mandant A' },
      },
      {
        tenantId,
        occurredAt: '2025-05-10T12:01:00.000Z',
        actorType: 'STAFF',
        actorId: 's1',
        action: 'document.upload',
        resourceType: 'document',
        resourceId: 'd1',
        before: null,
        after: { title: 'Vertrag.pdf' },
      },
      {
        tenantId,
        occurredAt: '2025-05-10T12:02:00.000Z',
        actorType: 'CLIENT_CONTACT',
        actorId: 'cc1',
        action: 'request.response',
        resourceType: 'request',
        resourceId: 'r1',
        before: null,
        after: { message: 'Anbei die Belege.' },
      },
    ];

    const rows: AuditRow[] = [];
    let prev = genesisHash(tenantId);
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      const thisHash = chainHash(prev, ev);
      rows.push({
        id: i + 1,
        ...ev,
        prevHash: prev,
        thisHash,
      });
      prev = thisHash;
    }

    // 1. Verifikation: jeder Eintrag hat den richtigen Hash
    let expectedPrev = genesisHash(tenantId);
    for (const row of rows) {
      expect(row.prevHash.equals(expectedPrev)).toBe(true);
      const recomputed = chainHash(expectedPrev, buildEvent(row));
      expect(row.thisHash.equals(recomputed)).toBe(true);
      expectedPrev = row.thisHash;
    }
  });

  it('Manipulation eines Eintrags bricht die Kette', () => {
    const tenantId2 = '00000000-0000-0000-0000-000000000003';
    const ev1 = {
      tenantId: tenantId2,
      occurredAt: '2025-05-10T12:00:00.000Z',
      actorType: 'STAFF',
      actorId: 's1',
      action: 'invoice.create',
      resourceType: 'invoice',
      resourceId: 'i1',
      before: null,
      after: { amount: 100 },
    };
    const ev2 = {
      tenantId: tenantId2,
      occurredAt: '2025-05-10T12:01:00.000Z',
      actorType: 'STAFF',
      actorId: 's1',
      action: 'invoice.send',
      resourceType: 'invoice',
      resourceId: 'i1',
      before: { status: 'DRAFT' },
      after: { status: 'SENT' },
    };

    const h0 = genesisHash(tenantId2);
    const h1 = chainHash(h0, ev1);
    const h2 = chainHash(h1, ev2);

    // Angreifer ändert nachträglich den Betrag
    const tampered = { ...ev1, after: { amount: 1000000 } };
    const h1Tampered = chainHash(h0, tampered);
    expect(h1Tampered.equals(h1)).toBe(false);
    // Folgende Hashes sind dann auch nicht mehr konsistent
    const h2FromTampered = chainHash(h1Tampered, ev2);
    expect(h2FromTampered.equals(h2)).toBe(false);
  });

  it('Reihenfolge der after-Keys spielt KEINE Rolle (canonical-json)', () => {
    const t = '00000000-0000-0000-0000-000000000004';
    const ev1 = {
      tenantId: t,
      occurredAt: '2025-05-10T12:00:00.000Z',
      actorType: 'STAFF',
      actorId: 's1',
      action: 'x',
      resourceType: 'y',
      resourceId: 'z',
      before: null,
      after: { b: 2, a: 1, c: 3 },
    };
    const ev2 = {
      ...ev1,
      after: { c: 3, a: 1, b: 2 },
    };
    const h0 = genesisHash(t);
    const h1a = chainHash(h0, ev1);
    const h1b = chainHash(h0, ev2);
    expect(h1a.equals(h1b)).toBe(true);
  });
});
