// Server-Wrapper, der den initialen Unread-Counter holt und an die
// Client-Component reicht. Sodass der erste Render schon den korrekten
// Counter zeigt (kein Flash 0 → N).

import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { NotificationsBell } from './notifications-bell';

export async function NotificationsBellServer() {
  const session = await staffAuth();
  if (!session?.user) return null;
  const { tenantId, staffId } = session.user;
  const unread = await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
    tx.notification.count({
      where: { OR: [{ staffId }, { staffId: null }], readAt: null },
    }),
  );
  return <NotificationsBell initialUnread={unread} />;
}
