import { NextResponse } from 'next/server';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';

export async function GET() {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { tenantId, staffId } = session.user;

  const unreadSummary = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.notification.aggregate({
        where: { OR: [{ staffId }, { staffId: null }], readAt: null },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
  );

  return NextResponse.json(
    {
      unread: unreadSummary._count._all,
      latestUnreadAt: unreadSummary._max.createdAt?.toISOString() ?? null,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
