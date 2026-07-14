import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  authenticateN8nCallback,
  n8nCallbackRejectResponse,
  runReservedN8nCallback,
} from '@/server/n8n/callback-auth';
import { receiveResearchResultForTenant } from '@/server/n8n/operations';
import {
  getCompletedN8nCallbackReceipt,
  N8N_CALLBACK_OPERATIONS,
  N8nCallbackReceiptConflictError,
} from '@/server/n8n/callback-receipts';
import { log } from '@/server/logger';

const ResearchResultSchema = z
  .object({
    researchRequestId: z.string().uuid().optional(),
    title: z.string().max(500).optional(),
    body: z.string().min(1).max(100_000),
    source: z.string().max(100).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = await authenticateN8nCallback(request, 'research:write');
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
  const parsed = ResearchResultSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation_error' }, { status: 400 });
  }

  const callbackReceipt = {
    tenantId: auth.tenantId,
    connectionId: auth.connectionId,
    requestId: auth.requestId,
    operation: N8N_CALLBACK_OPERATIONS.researchResult,
  };
  const completedReplayResponse = async () => {
    const receipt = await getCompletedN8nCallbackReceipt(callbackReceipt);
    return receipt?.resultId
      ? NextResponse.json({ ok: true, resultId: receipt.resultId, duplicate: true })
      : null;
  };
  const writeResearchResult = async () => {
    const completedReplay = await completedReplayResponse();
    if (completedReplay) return completedReplay;

    try {
      const result = await receiveResearchResultForTenant(
        auth.tenantId,
        parsed.data,
        callbackReceipt,
      );
      if (!result) {
        return NextResponse.json({ error: 'not_assignable' }, { status: 422 });
      }
      return NextResponse.json({
        ok: true,
        resultId: result.resultId,
        duplicate: result.duplicate,
      });
    } catch (error) {
      if (error instanceof N8nCallbackReceiptConflictError) {
        return NextResponse.json({ error: 'duplicate_request' }, { status: 409 });
      }
      throw error;
    }
  };

  return runReservedN8nCallback(auth, writeResearchResult, {
    onReplay: completedReplayResponse,
  });
}
