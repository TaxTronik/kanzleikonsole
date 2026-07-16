import { NextResponse } from 'next/server';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';

const LIMIT = 8;

export async function GET() {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { tenantId, staffId } = session.user;

  const [items, unreadCount] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      Promise.all([
        tx.notification.findMany({
          where: { OR: [{ staffId }, { staffId: null }] },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
          select: {
            id: true,
            kind: true,
            title: true,
            body: true,
            href: true,
            createdAt: true,
            readAt: true,
          },
        }),
        tx.notification.count({
          where: { OR: [{ staffId }, { staffId: null }], readAt: null },
        }),
      ]),
  );

  return NextResponse.json(
    {
      items: items.map((i) => ({
        ...i,
        createdAt: i.createdAt.toISOString(),
        readAt: i.readAt?.toISOString() ?? null,
      })),
      unread: unreadCount,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
