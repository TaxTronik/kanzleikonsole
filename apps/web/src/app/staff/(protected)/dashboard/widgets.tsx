import type { ReactNode } from 'react';
/**
 * Dashboard-Widget-Renderer (Dispatcher).
 *
 * Pro `WidgetType`-Enum-Wert ein Render-Pfad. Die eigentlichen Widget-
 * Implementierungen liegen in `./widgets/` (eine Datei pro thematischer
 * Gruppe). Vorher war alles in einer 962-LoC-Datei zusammen, was beim
 * Editieren immer das gesamte Widget-Universum laden ließ.
 */

import { Users, Inbox, FileText, Phone, IdCard, Workflow } from 'lucide-react';
import type { WidgetType } from '@/server/dashboard/widgets';
import { kpi, type RenderCtx } from './widgets/_shared';
import {
  RecentActivity,
  UpcomingRequests,
  GwgExpiring,
  UnreviewedNotices,
  TaxDeadlines,
  PhoneNotesWidget,
} from './widgets/list-widgets';
import { CalendarWidget } from './widgets/calendar';
import { TaxNews } from './widgets/tax-news';
import { MyWorkBasket } from './widgets/my-work-basket';
import {
  Bookmarks,
  LatestNotifications,
  PersonalNotes,
  MyDay,
  MyWorkflows,
  MyReminders,
} from './widgets/personal';

const CONTENT_RENDERERS: Partial<Record<WidgetType, (ctx: RenderCtx) => Promise<ReactNode>>> = {
  recent_activity: RecentActivity,
  upcoming_requests: UpcomingRequests,
  gwg_expiring: GwgExpiring,
  unreviewed_notices: UnreviewedNotices,
  my_tax_deadlines: TaxDeadlines,
  calendar: CalendarWidget,
  tax_news: TaxNews,
  phone_notes: PhoneNotesWidget,
  bookmarks: Bookmarks,
  personal_notes: PersonalNotes,
  my_workflow_items: MyDay,
  my_work_basket: MyWorkBasket,
  my_workflows: MyWorkflows,
  my_reminders: MyReminders,
  latest_notifications: LatestNotifications,
};

export async function renderWidget(type: WidgetType, ctx: RenderCtx): Promise<ReactNode> {
  const contentRenderer = Object.hasOwn(CONTENT_RENDERERS, type)
    ? CONTENT_RENDERERS[type]
    : undefined;
  if (contentRenderer) return contentRenderer(ctx);

  switch (type) {
    case 'kpi_clients':
      return kpi(ctx, Users, 'Mandanten', '/staff/clients', (t) => t.client.count());
    case 'kpi_open_requests':
      return kpi(
        ctx,
        Inbox,
        'Offene Anforderungen',
        '/staff/requests?status=OPEN',
        (t) => t.request.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
        'yellow',
      );
    case 'kpi_documents':
      return kpi(ctx, FileText, 'Dokumente', '/staff/documents', (t) =>
        t.document.count({ where: { deletedAt: null } }),
      );
    case 'kpi_unread_notes':
      return kpi(
        ctx,
        Phone,
        'Offene Telefonzettel',
        '/staff/phone-notes',
        (t) => t.phoneNote.count({ where: { doneAt: null } }),
        'yellow',
      );
    case 'kpi_pending_change_requests':
      return kpi(
        ctx,
        IdCard,
        'Offene Stammdaten-Anträge',
        '/staff/dashboard',
        (t) => t.clientMasterChangeRequest.count({ where: { status: 'PENDING' } }),
        'yellow',
      );
    case 'kpi_open_workflows':
      return kpi(ctx, Workflow, 'Laufende Workflows', '/staff/workflows', (t) =>
        t.workflowInstance.count({ where: { status: 'ACTIVE' } }),
      );
    default:
      return <div className="card p-4 text-xs text-muted">Unbekanntes Widget: {type}</div>;
  }
}
