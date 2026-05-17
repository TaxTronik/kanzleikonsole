// =============================================================================
// Unit-Test: signOutboundN8n aus @taxtronik/n8n-shared.
//
// Bewacht die Outbound-Signatur, die für jeden POST an n8n verwendet wird.
// Regressionen würden bedeuten:
//   - n8n kann eingehende Requests nicht mehr verifizieren (Verfügbarkeit kippt)
//   - oder ein Replay-Schutz greift nicht mehr (Audit Round 14, Finding 5)
//
// Die Tests prüfen reines Verhalten ohne DB/Redis/Netzwerk.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signOutboundN8n, isAllowedN8nEvent } from '@taxtronik/n8n-shared';

const SECRET = 'a'.repeat(32);

describe('signOutboundN8n — Format & Verifikation', () => {
  it('liefert sha256=<64-hex>-Signatur', () => {
    const { signature } = signOutboundN8n('client.created', '{"a":1}', SECRET);
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('Signatur ist gegen `event\\nts\\nnonce\\nbody` mit demselben Secret verifizierbar', () => {
    const event = 'request.opened';
    const body = JSON.stringify({ id: '42' });
    const { signature, timestamp, nonce } = signOutboundN8n(event, body, SECRET);

    const expected = createHmac('sha256', SECRET)
      .update(`${event}\n${timestamp}\n${nonce}\n${body}`)
      .digest('hex');
    expect(signature).toBe(`sha256=${expected}`);
  });

  it('event wird mitsigniert (M-8): andere Events ergeben andere Signaturen', () => {
    const body = '{}';
    const a = signOutboundN8n('client.created', body, SECRET);
    const b = signOutboundN8n('invoice.due', body, SECRET);
    expect(a.signature).not.toBe(b.signature);
  });

  it('body wird mitsigniert: andere Bodies ergeben andere Signaturen', () => {
    const a = signOutboundN8n('client.created', '{"x":1}', SECRET);
    const b = signOutboundN8n('client.created', '{"x":2}', SECRET);
    expect(a.signature).not.toBe(b.signature);
  });

  it('Nonce ist 128-Bit (32 hex-chars)', () => {
    const { nonce } = signOutboundN8n('taxtronik.ping', '', SECRET);
    expect(nonce).toMatch(/^[a-f0-9]{32}$/);
  });

  it('Nonce ist zwischen Aufrufen einzigartig (Replay-Schutz-Material)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(signOutboundN8n('taxtronik.ping', '', SECRET).nonce);
    }
    expect(seen.size).toBe(100);
  });

  it('timestamp ist Epoch-Millisekunden als String', () => {
    const before = Date.now();
    const { timestamp } = signOutboundN8n('taxtronik.ping', '', SECRET);
    const after = Date.now();
    const ts = Number(timestamp);
    expect(Number.isFinite(ts)).toBe(true);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('Falsches Secret ergibt anderen Hash (timing-safe Vergleich auf Empfängerseite)', () => {
    const body = '{}';
    const { signature: a } = signOutboundN8n('client.created', body, SECRET);
    const { signature: b } = signOutboundN8n('client.created', body, 'b'.repeat(32));
    expect(a).not.toBe(b);
  });
});

describe('isAllowedN8nEvent — Whitelist', () => {
  it('akzeptiert bekannte System-Events', () => {
    expect(isAllowedN8nEvent('client.created')).toBe(true);
    expect(isAllowedN8nEvent('gwg.expired')).toBe(true);
    expect(isAllowedN8nEvent('taxtronik.ping')).toBe(true);
  });

  it('akzeptiert Workflow-Step-Events mit erlaubtem Suffix', () => {
    expect(isAllowedN8nEvent('workflow.step.onboarding_done')).toBe(true);
    expect(isAllowedN8nEvent('workflow.step.review-required')).toBe(true);
  });

  it('lehnt unbekannte Top-Level-Events ab', () => {
    expect(isAllowedN8nEvent('client.deleted_silently')).toBe(false);
    expect(isAllowedN8nEvent('admin.exfiltrate')).toBe(false);
    expect(isAllowedN8nEvent('')).toBe(false);
  });

  it('lehnt Workflow-Steps mit Punkten ab (L-7: Subpath-Trennung verhindern)', () => {
    expect(isAllowedN8nEvent('workflow.step.foo.bar')).toBe(false);
  });

  it('lehnt Workflow-Steps mit Großbuchstaben ab', () => {
    expect(isAllowedN8nEvent('workflow.step.FOO')).toBe(false);
  });

  it('lehnt überlange Workflow-Steps ab (Suffix > 41 chars)', () => {
    const longSuffix = 'a'.repeat(42);
    expect(isAllowedN8nEvent(`workflow.step.${longSuffix}`)).toBe(false);
  });
});
