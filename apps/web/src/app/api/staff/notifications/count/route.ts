import { NextResponse } from 'next/server';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { readUnreadNotificationSummaryTx } from '@/server/notifications/unread-summary';

export async function GET() {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { tenantId, staffId } = session.user;

  const unreadSummary = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) => readUnreadNotificationSummaryTx(tx, staffId),
  );

  return NextResponse.json(
    {
      unread: unreadSummary.unread,
      latestUnreadAt: unreadSummary.latestUnreadAt,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
