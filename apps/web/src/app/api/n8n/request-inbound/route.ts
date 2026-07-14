// Legacy endpoint. New workflows use /api/integrations/n8n/v1/request-inbound.
// Existing installations keep the HMAC/body contract including tenantId.
// The shared operation still enforces the module toggle, a tenantbound open
// request and a known active sender. Attachments are intentionally unsupported.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { n8nRejectResponse, runReservedN8nRequest, verifyN8nSignature } from '@/server/n8n/verify';
import { handleInboundRequestEmail } from '@/server/n8n/operations';
import { log } from '@/server/logger';
import { legacyN8nCallbackDisabledResponse } from '@/server/n8n/legacy-access';

const InboundSchema = z.object({
  tenantId: z.string().uuid(),
  requestId: z.string().uuid(),
  fromEmail: z.string().email().max(320),
  message: z.string().min(1).max(5000),
});

export async function POST(req: NextRequest) {
  const disabled = legacyN8nCallbackDisabledResponse();
  if (disabled) return disabled;

  const verification = await verifyN8nSignature(req);
  if (!verification.ok) {
    log.warn({ component: 'n8n', reason: verification.error }, 'n8n-verify: rejected');
    return n8nRejectResponse(verification);
  }

  let body: unknown;
  try {
    body = JSON.parse(verification.body ?? '{}');
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = InboundSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation_error' }, { status: 400 });
  }

  return runReservedN8nRequest(verification, async () => {
    const { tenantId, ...input } = parsed.data;
    const result = await handleInboundRequestEmail(tenantId, input);
    if (result.status !== 200) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true });
  });
}
