// =============================================================================
// Prüfer-Self-Service: zeitlich begrenzter, signierter Token für read-only
// Evidence-Verifikation durch externe Wirtschaftsprüfer.
//
// Stateless HMAC (HKDF-domain-getrennt aus AUTH_SECRET), Payload enthält
// tenantId + Ablaufzeitpunkt. Kein DB-Eintrag; Revocation global über
// AUTH_SECRET-Rotation oder durch Ablauf. Der Token gibt KEINEN Daten-Zugriff
// — nur die Integritäts-Attestierung der Hash-Chain (keine Mandantendaten).
// =============================================================================

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { env } from '@taxtronik/config';

function auditKey(): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      env.AUTH_SECRET,
      Buffer.from('taxtronik-audit-access-salt', 'utf8'),
      Buffer.from('taxtronik-audit-access-v1', 'utf8'),
      32,
    ),
  );
}

export function signAuditToken(tenantId: string, expiresAtMs: number): string {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, e: expiresAtMs })).toString('base64url');
  const sig = createHmac('sha256', auditKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyAuditToken(token: string): { tenantId: string; expiresAt: Date } | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = createHmac('sha256', auditKey()).update(payload).digest('base64url');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof obj !== 'object' ||
    obj === null ||
    typeof (obj as { t?: unknown }).t !== 'string' ||
    typeof (obj as { e?: unknown }).e !== 'number'
  ) {
    return null;
  }
  const { t, e } = obj as { t: string; e: number };
  if (Date.now() > e) return null; // abgelaufen
  return { tenantId: t, expiresAt: new Date(e) };
}

/** Default-Gültigkeit für einen Prüfer-Link. */
export const AUDIT_TOKEN_TTL_DAYS = 14;
