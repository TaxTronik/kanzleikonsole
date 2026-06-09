// =============================================================================
// Unit-Tests: signOutboundN8n + Event-Whitelist (@taxtronik/n8n-shared).
//
// Das Package exportiert nur die SIGN-Seite (die Verify-Seite liegt beim
// n8n-Empfänger bzw. in apps/web/src/server/n8n/verify.ts für eingehende
// Calls). „Verify" heißt hier deshalb: die Signatur mit denselben Inputs
// nachrechnen — exakt das, was ein Empfänger tut. Manipulation an Body/
// Timestamp/Nonce/Event/Secret → Nachrechnung weicht ab (verify schlägt fehl).
//
// Fake-Clock (vi.setSystemTime) macht den Timestamp deterministisch.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  signOutboundN8n,
  isAllowedN8nEvent,
  STATIC_EVENT_WHITELIST,
  WORKFLOW_STEP_RE,
} from '../index';

const SECRET = 'unit-test-hmac-secret-with-at-least-32-chars';
const FIXED_NOW = new Date('2026-06-09T12:00:00.000Z');

/** Empfänger-Seite: Signatur aus den übertragenen Headern nachrechnen. */
function recompute(
  event: string,
  timestamp: string,
  nonce: string,
  body: string,
  secret = SECRET,
): string {
  const payload = `${event}\n${timestamp}\n${nonce}\n${body}`;
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('signOutboundN8n — Roundtrip', () => {
  it('sign → Nachrechnung mit denselben Inputs stimmt überein (verify ok)', () => {
    const body = JSON.stringify({ event: 'taxtronik.ping', payload: { a: 1 } });
    const sig = signOutboundN8n('taxtronik.ping', body, SECRET);
    expect(sig.signature).toBe(recompute(sig.event, sig.timestamp, sig.nonce, body));
  });

  it('Timestamp ist der aktuelle Epoch-ms-Zeitpunkt', () => {
    const sig = signOutboundN8n('taxtronik.ping', '{}', SECRET);
    expect(sig.timestamp).toBe(String(FIXED_NOW.getTime()));
  });

  it('Format: sha256=<64 hex>, Nonce = 32 hex (128 Bit)', () => {
    const sig = signOutboundN8n('taxtronik.ping', '{}', SECRET);
    expect(sig.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sig.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it('jede Anfrage bekommt eine frische Nonce (Audit Round 14, Finding 5)', () => {
    const a = signOutboundN8n('taxtronik.ping', '{}', SECRET);
    const b = signOutboundN8n('taxtronik.ping', '{}', SECRET);
    expect(a.nonce).not.toBe(b.nonce);
    // Gleicher Body + gleicher Timestamp, aber andere Nonce → andere Signatur.
    expect(a.signature).not.toBe(b.signature);
  });
});

describe('signOutboundN8n — Manipulation lässt verify fehlschlagen', () => {
  const body = JSON.stringify({ clientId: 'victim' });

  it('manipulierter Body → mismatch', () => {
    const sig = signOutboundN8n('client.created', body, SECRET);
    const tampered = JSON.stringify({ clientId: 'attacker' });
    expect(sig.signature).not.toBe(recompute(sig.event, sig.timestamp, sig.nonce, tampered));
  });

  it('manipulierter Timestamp → mismatch (Replay mit verschobener Zeit)', () => {
    const sig = signOutboundN8n('client.created', body, SECRET);
    const shifted = String(Number(sig.timestamp) + 1);
    expect(sig.signature).not.toBe(recompute(sig.event, shifted, sig.nonce, body));
  });

  it('manipulierte Nonce → mismatch', () => {
    const sig = signOutboundN8n('client.created', body, SECRET);
    const otherNonce = sig.nonce.endsWith('0')
      ? sig.nonce.slice(0, -1) + '1'
      : sig.nonce.slice(0, -1) + '0';
    expect(sig.signature).not.toBe(recompute(sig.event, sig.timestamp, otherNonce, body));
  });

  it('manipuliertes Event → mismatch (M-8: Replay über anderen Trigger)', () => {
    const sig = signOutboundN8n('client.created', body, SECRET);
    expect(sig.signature).not.toBe(recompute('staff.locked', sig.timestamp, sig.nonce, body));
  });

  it('falsches Secret → mismatch', () => {
    const sig = signOutboundN8n('client.created', body, SECRET);
    expect(sig.signature).not.toBe(
      recompute(sig.event, sig.timestamp, sig.nonce, body, 'wrong-secret-with-at-least-32-chars!!'),
    );
  });
});

describe('isAllowedN8nEvent — Whitelist (Outbox + Worker, Defense in Depth)', () => {
  it('alle statischen Whitelist-Events sind erlaubt', () => {
    for (const event of STATIC_EVENT_WHITELIST) {
      expect(isAllowedN8nEvent(event)).toBe(true);
    }
  });

  it.each([
    ['workflow.step.onboarding_done'],
    ['workflow.step.review-required'],
    ['workflow.step.a'],
    [`workflow.step.a${'b'.repeat(40)}`], // Suffix-Maximallänge 41
  ])('Workflow-Step %s ist erlaubt', (event) => {
    expect(WORKFLOW_STEP_RE.test(event)).toBe(true);
    expect(isAllowedN8nEvent(event)).toBe(true);
  });

  it.each([
    ['client.deleted'], // nicht in der Whitelist
    ['workflow.step.'], // leerer Suffix
    ['workflow.step.Foo'], // Großschreibung
    ['workflow.step.1abc'], // muss mit Buchstabe beginnen
    ['workflow.step.foo.bar'], // kein Punkt im Suffix (L-7)
    [`workflow.step.a${'b'.repeat(41)}`], // Suffix > 41 Zeichen
    [''],
  ])('%j ist NICHT erlaubt', (event) => {
    expect(isAllowedN8nEvent(event)).toBe(false);
  });
});
