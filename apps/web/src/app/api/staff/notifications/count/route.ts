import { NextResponse } from 'next/server';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';

export async function GET() {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { tenantId, staffId } = session.user;

  const unread = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.notification.count({
        where: { OR: [{ staffId }, { staffId: null }], readAt: null },
      }),
  );

  return NextResponse.json(
    { unread },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
