import { NextResponse, type NextRequest } from 'next/server';
import { staffAuth } from '@/server/auth/staff';
import { hasStaffPermission } from '@/server/auth/rbac';
import { isUuid } from '@/lib/uuid';
import { staffInboxAttachmentDownloadResponse } from '@/server/inbox/attachment-delivery';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await staffAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!hasStaffPermission(session, 'PORTAL_INBOX_MANAGE')) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return staffInboxAttachmentDownloadResponse(request, session, id);
}
