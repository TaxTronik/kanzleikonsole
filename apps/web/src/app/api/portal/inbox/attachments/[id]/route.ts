import { NextResponse, type NextRequest } from 'next/server';
import { portalAuth } from '@/server/auth/portal';
import { isUuid } from '@/lib/uuid';
import { checkPortalReadLimit } from '@/server/rate-limit';
import { portalInboxAttachmentDownloadResponse } from '@/server/inbox/attachment-delivery';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await portalAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const limit = await checkPortalReadLimit(session.user.contactId);
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'rate_limited', retryAfter: limit.retryAfter },
      { status: 429, headers: { 'retry-after': String(limit.retryAfter) } },
    );
  }
  return portalInboxAttachmentDownloadResponse(request, session, id);
}
