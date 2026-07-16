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
import {
  Bookmarks,
  LatestNotifications,
  PersonalNotes,
  MyDay,
  MyWorkflows,
  MyReminders,
} from './widgets/personal';

export async function renderWidget(type: WidgetType, ctx: RenderCtx): Promise<ReactNode> {
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
    case 'recent_activity':
      return RecentActivity(ctx);
    case 'upcoming_requests':
      return UpcomingRequests(ctx);
    case 'gwg_expiring':
      return GwgExpiring(ctx);
    case 'unreviewed_notices':
      return UnreviewedNotices(ctx);
    case 'my_tax_deadlines':
      return TaxDeadlines(ctx);
    case 'calendar':
      return CalendarWidget(ctx);
    case 'tax_news':
      return TaxNews(ctx);
    case 'phone_notes':
      return PhoneNotesWidget(ctx);
    case 'bookmarks':
      return Bookmarks(ctx);
    case 'personal_notes':
      return PersonalNotes(ctx);
    case 'my_workflow_items':
      return MyDay(ctx);
    case 'my_workflows':
      return MyWorkflows(ctx);
    case 'my_reminders':
      return MyReminders(ctx);
    case 'latest_notifications':
      return LatestNotifications(ctx);
    default:
      return <div className="card p-4 text-xs text-muted">Unbekanntes Widget: {type}</div>;
  }
}
