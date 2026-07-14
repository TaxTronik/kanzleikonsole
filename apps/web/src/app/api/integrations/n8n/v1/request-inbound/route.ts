import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  authenticateN8nCallback,
  n8nCallbackRejectResponse,
  runReservedN8nCallback,
} from '@/server/n8n/callback-auth';
import { handleInboundRequestEmail } from '@/server/n8n/operations';
import {
  getCompletedN8nCallbackReceipt,
  N8N_CALLBACK_OPERATIONS,
  N8nCallbackReceiptConflictError,
} from '@/server/n8n/callback-receipts';
import { log } from '@/server/logger';

const InboundSchema = z
  .object({
    requestId: z.string().uuid(),
    fromEmail: z.string().email().max(320),
    message: z.string().min(1).max(5000),
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = await authenticateN8nCallback(request, 'inbound-mail:write');
  if (!auth.ok) {
    log.warn(
      { component: 'n8n-callback', reason: auth.reason, status: auth.status },
      'n8n callback rejected',
    );
    return n8nCallbackRejectResponse(auth);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = InboundSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation_error' }, { status: 400 });
  }

  const callbackReceipt = {
    tenantId: auth.tenantId,
    connectionId: auth.connectionId,
    requestId: auth.requestId,
    operation: N8N_CALLBACK_OPERATIONS.inboundMail,
  };
  const completedReplayResponse = async () =>
    (await getCompletedN8nCallbackReceipt(callbackReceipt))
      ? NextResponse.json({ ok: true, duplicate: true })
      : null;
  const writeInboundResponse = async () => {
    const completedReplay = await completedReplayResponse();
    if (completedReplay) return completedReplay;

    try {
      const result = await handleInboundRequestEmail(auth.tenantId, parsed.data, callbackReceipt);
      if (result.status !== 200) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }
      return NextResponse.json({ ok: true, duplicate: result.duplicate });
    } catch (error) {
      if (error instanceof N8nCallbackReceiptConflictError) {
        return NextResponse.json({ error: 'duplicate_request' }, { status: 409 });
      }
      throw error;
    }
  };

  return runReservedN8nCallback(auth, writeInboundResponse, {
    onReplay: completedReplayResponse,
  });
}
