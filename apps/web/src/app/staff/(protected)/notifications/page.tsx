import { Bell, Check } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { markNotificationReadAction, markAllNotificationsReadAction } from './actions';
import { fmtDateTimeShort } from '@/lib/fmt';
import { NOTIFICATION_KIND_LABELS } from '@/lib/domain-labels';
import { NotificationOpenLink } from '@/components/notification-open-link';

export default async function NotificationsPage() {
  const session = await requireStaffPage();

  const { tenantId, staffId } = session.user;

  const notifications = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.notification.findMany({
        where: { OR: [{ staffId }, { staffId: null }] },
        orderBy: [{ readAt: 'asc' }, { createdAt: 'desc' }],
        take: 100,
      }),
  );

  const unreadCount = notifications.filter((n) => n.readAt === null).length;

  return (
    <div className="p-8">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Benachrichtigungen</h1>
          <p className="text-muted text-sm">
            {unreadCount > 0 ? `${unreadCount} ungelesen` : 'Alles gelesen.'}
          </p>
        </div>
        {unreadCount > 0 && (
          <form action={markAllNotificationsReadAction}>
            <button type="submit" className="btn-secondary">
              <Check className="h-4 w-4" />
              Alle als gelesen markieren
            </button>
          </form>
        )}
      </div>

      <div className="card overflow-hidden">
        {notifications.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <Bell className="h-12 w-12 text-disabled mx-auto mb-3" />
            <p className="text-sm text-disabled">Keine Benachrichtigungen.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {notifications.map((n) => (
              <li key={n.id} className={n.readAt ? 'px-6 py-4' : 'px-6 py-4 bg-yellow-50/30'}>
                <div className="flex items-start gap-3">
                  <div
                    className={
                      n.readAt
                        ? 'h-2 w-2 rounded-full bg-gray-200 mt-2 shrink-0'
                        : 'h-2 w-2 rounded-full bg-brand-500 mt-2 shrink-0'
                    }
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-primary">{n.title}</span>
                      <span className="badge-gray text-[10px]">
                        {NOTIFICATION_KIND_LABELS[n.kind] ?? n.kind}
                      </span>
                    </div>
                    {n.body && <p className="text-sm text-secondary mt-1">{n.body}</p>}
                    <p className="text-xs text-disabled mt-1">
                      {fmtDateTimeShort(n.createdAt)}
                      {n.href && (
                        <>
                          {' · '}
                          <NotificationOpenLink
                            id={n.id}
                            href={n.href}
                            unread={!n.readAt}
                            className="text-brand-700 hover:underline"
                          >
                            öffnen →
                          </NotificationOpenLink>
                        </>
                      )}
                    </p>
                  </div>
                  {!n.readAt && (
                    <form action={markNotificationReadAction}>
                      <input type="hidden" name="id" value={n.id} />
                      <button
                        type="submit"
                        className="text-disabled hover:text-secondary p-1"
                        title="Als gelesen markieren"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
