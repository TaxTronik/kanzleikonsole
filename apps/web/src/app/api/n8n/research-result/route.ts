// =============================================================================
// POST /api/n8n/research-result
//
// Inbound von n8n: das Ergebnis eines zuvor relayten (anonymisierten)
// Rechercheauftrags. HMAC-gated (verify.ts signiert auch den Body).
//
// Zuordnung:
//  - mit `researchRequestId` (Korrelations-Token): automatisch der Ursprungs-
//    Markierung zugeordnet, der Body wird mit dem gespeicherten Mapping
//    DE-ANONYMISIERT (Platzhalter→Original).
//  - ohne Korrelation: `tenantId` ist Pflicht; das Ergebnis landet NEU in der
//    Ablage und wird in der UI heuristisch einer Markierung vorgeschlagen.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyN8nSignature, n8nRejectResponse } from '@/server/n8n/verify';
import { receiveResearchResult } from '@/server/risk';
import { log } from '@/server/logger';

const Schema = z.object({
  researchRequestId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
  title: z.string().max(500).optional(),
  body: z.string().min(1).max(100_000),
  source: z.string().max(100).optional(),
});

export async function POST(req: NextRequest) {
  const ver = await verifyN8nSignature(req);
  if (!ver.ok) {
    log.warn({ component: 'n8n', reason: ver.error }, 'n8n-verify: rejected (research-result)');
    // Befund 10: zentrales Status-Mapping (503/500 retrybar, sonst 401).
    return n8nRejectResponse(ver);
  }

  let body: unknown;
  try {
    body = JSON.parse(ver.body ?? '{}');
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation_error' }, { status: 400 });
  }
  if (!parsed.data.researchRequestId && !parsed.data.tenantId) {
    return NextResponse.json({ error: 'missing_correlation' }, { status: 400 });
  }

  const res = await receiveResearchResult(parsed.data);
  if (!res) {
    return NextResponse.json({ error: 'not_assignable' }, { status: 422 });
  }
  return NextResponse.json({ ok: true, resultId: res.resultId });
}
