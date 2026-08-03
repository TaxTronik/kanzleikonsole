import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildNotificationSignal,
  clientIdFromHref,
  emitNotificationsGrew,
  onNotificationsGrew,
} from '../live-events';

const A = 'bc2cc432-b881-4c0e-80c3-35a86d08f76d';
const B = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('clientIdFromHref', () => {
  it('erkennt den Mandanten in allen mandantenbezogenen Links', () => {
    expect(clientIdFromHref(`/staff/clients/${A}`)).toBe(A);
    expect(clientIdFromHref(`/staff/clients/${A}/gwg`)).toBe(A);
    expect(clientIdFromHref(`/staff/clients/${A}/subsumtion/${B}?marking=${B}`)).toBe(A);
    expect(clientIdFromHref(`/staff/clients/${A}#documents`)).toBe(A);
  });

  it('liefert null für alles ohne Mandantenbezug', () => {
    // Systemmeldungen, Dashboard, Portal → kein Block darf davon aufwachen.
    for (const href of [
      null,
      undefined,
      '',
      '/staff/dashboard',
      '/staff/invoices',
      '/staff/admin/audit',
      '/portal/documents',
    ]) {
      expect(clientIdFromHref(href)).toBeNull();
    }
  });

  it('fällt nicht auf ähnlich aussehende Pfade herein', () => {
    expect(clientIdFromHref('/staff/clients/new')).toBeNull();
    expect(clientIdFromHref('/staff/clients')).toBeNull();
    // Kein Präfix-Treffer mitten im Pfad.
    expect(clientIdFromHref(`/portal/staff/clients/${A}`)).toBeNull();
  });

  it('normalisiert Grossschreibung (Links aus Altbestand)', () => {
    expect(clientIdFromHref(`/staff/clients/${A.toUpperCase()}`)).toBe(A);
  });
});

describe('buildNotificationSignal', () => {
  it('sammelt betroffene Mandanten und Arten aus den UNGELESENEN Einträgen', () => {
    const s = buildNotificationSignal([
      { href: `/staff/clients/${A}`, kind: 'RISK_MARKING_ASSIGNED', readAt: null },
      { href: `/staff/clients/${B}/gwg`, kind: 'GWG_EXPIRED', readAt: null },
      { href: '/staff/dashboard', kind: 'SYSTEM_BACKUP_FAILED', readAt: null },
    ]);
    expect(s.clientIds.sort()).toEqual([A, B].sort());
    expect(s.kinds).toContain('RISK_MARKING_ASSIGNED');
  });

  it('ignoriert bereits gelesene Einträge', () => {
    // Sonst löst jeder Zuwachs ein Nachladen für ALLE Mandanten der Kurzliste
    // aus — auch für längst gesehene Meldungen.
    const s = buildNotificationSignal([
      { href: `/staff/clients/${A}`, kind: 'X', readAt: '2026-08-01T10:00:00Z' },
      { href: `/staff/clients/${B}`, kind: 'Y', readAt: null },
    ]);
    expect(s.clientIds).toEqual([B]);
  });

  it('entdoppelt mehrere Meldungen zum selben Mandanten', () => {
    const s = buildNotificationSignal([
      { href: `/staff/clients/${A}`, kind: 'X', readAt: null },
      { href: `/staff/clients/${A}/subsumtion/${B}`, kind: 'Y', readAt: null },
    ]);
    expect(s.clientIds).toEqual([A]);
  });

  it('liefert leere Listen, wenn nichts Mandantenbezogenes dabei ist', () => {
    const s = buildNotificationSignal([
      { href: '/staff/dashboard', kind: 'SYSTEM_AUDIT_OK', readAt: null },
    ]);
    expect(s.clientIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Abonnement mit Mandantenfilter — der eigentliche Zweck der Aenderung: ein
// offener Block soll NUR nachladen, wenn es seinen Mandanten betrifft.
// Kein jsdom noetig: Node bringt EventTarget/CustomEvent mit.
// ---------------------------------------------------------------------------

// Kein jsdom in diesem Projekt — `vi.stubGlobal` setzt window/document nur fuer
// diese Tests; Node bringt EventTarget/CustomEvent selbst mit.
function stubDom(hidden = false): void {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', { hidden });
}

beforeEach(() => stubDom());
afterEach(() => vi.unstubAllGlobals());

describe('onNotificationsGrew', () => {
  it('weckt nur den Block des betroffenen Mandanten', () => {
    const trefferA = vi.fn();
    const trefferB = vi.fn();
    onNotificationsGrew(trefferA, { clientId: A });
    onNotificationsGrew(trefferB, { clientId: B });

    emitNotificationsGrew({ clientIds: [A], kinds: ['RISK_MARKING_ASSIGNED'] });

    expect(trefferA).toHaveBeenCalledTimes(1);
    // Genau das war vorher das Problem: B haette blind mitgeladen.
    expect(trefferB).not.toHaveBeenCalled();
  });

  it('ohne clientId-Option hoert der Abonnent alles', () => {
    const alle = vi.fn();
    onNotificationsGrew(alle);
    emitNotificationsGrew({ clientIds: [A], kinds: [] });
    expect(alle).toHaveBeenCalledTimes(1);
  });

  it('schweigt bei verstecktem Tab', () => {
    stubDom(true);
    const h = vi.fn();
    onNotificationsGrew(h, { clientId: A });
    emitNotificationsGrew({ clientIds: [A], kinds: [] });
    expect(h).not.toHaveBeenCalled();
  });

  it('meldet sich sauber ab', () => {
    const h = vi.fn();
    const ab = onNotificationsGrew(h, { clientId: A });
    ab();
    emitNotificationsGrew({ clientIds: [A], kinds: [] });
    expect(h).not.toHaveBeenCalled();
  });

  it('vergleicht Mandanten-IDs unabhaengig von der Schreibweise', () => {
    const h = vi.fn();
    onNotificationsGrew(h, { clientId: A.toUpperCase() });
    emitNotificationsGrew({ clientIds: [A], kinds: [] });
    expect(h).toHaveBeenCalledTimes(1);
  });
});
