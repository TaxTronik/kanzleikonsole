// Fachkatalog: ACCESS-STAFF-PERMISSION-001, ACCESS-TENANT-RLS-001,
// ACCESS-SEARCH-SCOPE-001, PORTAL-INBOX-SUBMISSION-001
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOOLEAN_TENANT_MODULES } from '@taxtronik/db/tenant-modules';
import {
  enabledDashboardWidgetTypes,
  parseLayout,
  WIDGET_BY_TYPE,
  type WidgetType,
} from '@/server/dashboard/widgets';
import { MyWorkBasket } from '../widgets/my-work-basket';
import { renderWidget } from '../widgets';
import type { RenderCtx } from '../widgets/_shared';

vi.mock('../my-day-toggle', () => ({
  MyDayToggle: ({ id }: { id: string }) => <button data-workflow-id={id}>Erledigen</button>,
}));
vi.mock('../widgets/list-widgets', () => ({
  RecentActivity: vi.fn(),
  UpcomingRequests: vi.fn(),
  GwgExpiring: vi.fn(),
  UnreviewedNotices: vi.fn(),
  TaxDeadlines: vi.fn(),
  PhoneNotesWidget: vi.fn(),
}));
vi.mock('../widgets/personal', () => ({
  Bookmarks: vi.fn(),
  LatestNotifications: vi.fn(),
  PersonalNotes: vi.fn(),
  MyDay: vi.fn(),
  MyWorkflows: vi.fn(),
  MyReminders: vi.fn(),
}));
vi.mock('../widgets/calendar', () => ({ CalendarWidget: vi.fn() }));
vi.mock('../widgets/tax-news', () => ({ TaxNews: vi.fn() }));

function context() {
  const db = {
    workflowItem: { findMany: vi.fn().mockResolvedValue([]) },
    clientReminder: { findMany: vi.fn().mockResolvedValue([]) },
    appointment: { findMany: vi.fn().mockResolvedValue([]) },
    phoneNote: { findMany: vi.fn().mockResolvedValue([]) },
    portalInboxThread: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const ctx: RenderCtx = {
    tx: db as unknown as RenderCtx['tx'],
    tenantId: 'tenant-a',
    staffId: 'staff-a',
    deniedClientIds: ['client-denied'],
    modules: {
      ...DEFAULT_BOOLEAN_TENANT_MODULES,
      workflows: false,
      reminders: false,
      appointments: false,
      phoneNotes: false,
    },
    portalInboxEnabled: false,
  };
  return { db, ctx };
}

describe('Mein Arbeitskorb im Dashboard', () => {
  it.each(['constructor', '__proto__', 'toString'])(
    'behandelt geerbte Objektnamen weiter als unbekanntes Widget (%s)',
    async (type) => {
      const { ctx, db } = context();
      const html = renderToStaticMarkup(await renderWidget(type as WidgetType, ctx));
      expect(html).toContain(`Unbekanntes Widget: ${type}`);
      expect(db.workflowItem.findMany).not.toHaveBeenCalled();
      expect(db.portalInboxThread.findMany).not.toHaveBeenCalled();
    },
  );

  it('ist zusätzlich zu Mein Tag auswählbar und akzeptiert gespeicherte Layouts', () => {
    const { ctx } = context();
    expect(WIDGET_BY_TYPE.my_workflow_items.label).toBe('Mein Tag');
    expect(WIDGET_BY_TYPE.my_work_basket.label).toBe('Mein Arbeitskorb');
    expect(enabledDashboardWidgetTypes(ctx.modules)).toContain('my_work_basket');
    expect(
      parseLayout({
        version: 2,
        widgets: [{ id: 'basket', type: 'my_work_basket', x: 0, y: 0, w: 4, h: 12 }],
      }).widgets,
    ).toHaveLength(1);
  });

  it('rendert registriert nur aktive Quellen persönlich und mit unverändertem Mandantenausschluss', async () => {
    const { ctx, db } = context();
    ctx.modules.workflows = true;
    db.workflowItem.findMany.mockResolvedValue([
      {
        id: 'workflow-a',
        title: 'Erklärung vorbereiten',
        dueDate: new Date('2026-01-01T12:00:00Z'),
        instance: { clientId: 'client-a', name: 'Jahresabschluss', client: { name: 'Mandat A' } },
      },
    ]);

    const html = renderToStaticMarkup(await renderWidget('my_work_basket', ctx));

    expect(db.workflowItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
        where: {
          assigneeStaffId: 'staff-a',
          doneAt: null,
          instance: { status: 'ACTIVE', clientId: { notIn: ['client-denied'] } },
        },
      }),
    );
    expect(db.clientReminder.findMany).not.toHaveBeenCalled();
    expect(db.appointment.findMany).not.toHaveBeenCalled();
    expect(db.phoneNote.findMany).not.toHaveBeenCalled();
    expect(db.portalInboxThread.findMany).not.toHaveBeenCalled();
    expect(html).toContain('Erklärung vorbereiten');
    expect(html).toContain('href="/staff/clients/client-a/workflows"');
    expect(html).toContain('data-workflow-id="workflow-a"');
    expect(html).toContain('Überfällig');
    expect(html).toContain('href="/staff/work"');
  });

  it('bindet freigeschaltete Mandantenpost nur an den persönlichen Slot des aktuellen Tenants', async () => {
    const { ctx, db } = context();
    ctx.portalInboxEnabled = true;
    db.portalInboxThread.findMany.mockResolvedValue([
      {
        id: 'inbox-a',
        subject: 'Neue Mandantenpost',
        lastMessageAt: new Date('2026-01-02T12:00:00Z'),
        client: { name: 'Mandat A' },
        messages: [],
      },
    ]);

    const html = renderToStaticMarkup(await MyWorkBasket(ctx));

    expect(db.portalInboxThread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
        where: expect.objectContaining({
          tenantId: 'tenant-a',
          assignedStaffId: 'staff-a',
          clientId: { notIn: ['client-denied'] },
          status: 'OPEN',
          attention: 'STAFF',
        }),
      }),
    );
    expect(html).toContain('Neue Mandantenpost');
    expect(html).toContain('href="/staff/inbox/inbox-a"');
    expect(html).toContain('Ohne Termin');
  });

  it.each([false, true])(
    'zeigt ohne aktive Quelle/fehlenden Tenant einen ehrlichen Leerzustand (%s)',
    async (enabled) => {
      const { ctx, db } = context();
      ctx.portalInboxEnabled = enabled;
      ctx.tenantId = undefined;

      const html = renderToStaticMarkup(await MyWorkBasket(ctx));

      expect(db.portalInboxThread.findMany).not.toHaveBeenCalled();
      expect(html).toContain('Keine offenen Einträge in Ihrem persönlichen Arbeitskorb.');
      expect(html).toContain('Arbeitskorb öffnen');
      expect(html).not.toContain('scrollbare Liste');
    },
  );

  it('begrenzt die echte Arbeitskorbvorschau auf 20 ohne eine Gesamtzahl zu behaupten', async () => {
    const { ctx, db } = context();
    ctx.modules.reminders = true;
    db.clientReminder.findMany.mockResolvedValue(
      Array.from({ length: 24 }, (_, index) => ({
        id: `reminder-${index}`,
        subject: `Wiedervorlage ${index}`,
        dueDate: new Date(Date.UTC(2026, 0, index + 1)),
        client: null,
      })),
    );

    const html = renderToStaticMarkup(await MyWorkBasket(ctx));

    expect(html.match(/class="work-basket-row /g)).toHaveLength(20);
    expect(html).not.toContain('Wiedervorlage 20');
    expect(html).toContain('Weitere Einträge im Arbeitskorb.');
    expect(html).not.toContain('24 Einträge');
  });

  it('zeigt priorisierte Aufgaben auch neben mehr als 20 älteren Telefonzetteln', async () => {
    const { ctx, db } = context();
    ctx.modules.workflows = true;
    ctx.modules.phoneNotes = true;
    db.workflowItem.findMany.mockResolvedValue([
      {
        id: 'workflow-priority',
        title: 'Überfällige Aufgabe vor Telefonzetteln',
        dueDate: new Date('2026-02-01T12:00:00Z'),
        instance: { clientId: 'client-a', name: 'Jahresabschluss', client: { name: 'Mandat A' } },
      },
    ]);
    db.phoneNote.findMany.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => ({
        id: `phone-${index}`,
        subject: `Telefonzettel ${index}`,
        callerName: 'Anrufer',
        createdAt: new Date(Date.UTC(2026, 0, index + 1)),
        client: null,
      })),
    );

    const html = renderToStaticMarkup(await MyWorkBasket(ctx));

    expect(html.match(/class="work-basket-row /g)).toHaveLength(20);
    expect(html).toContain('Überfällige Aufgabe vor Telefonzetteln');
    expect(html.indexOf('Überfällige Aufgabe vor Telefonzetteln')).toBeLessThan(
      html.indexOf('Telefonzettel 0'),
    );
    expect(html).not.toContain('Telefonzettel 19');
    expect(db.phoneNote.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });
});
