import { describe, expect, it } from 'vitest';
import { DEFAULT_BOOLEAN_TENANT_MODULES } from '@taxtronik/db/tenant-modules';
import {
  enabledDashboardWidgetTypes,
  filterDashboardLayoutByModules,
  type DashboardLayout,
  type WidgetType,
} from '../widgets';

function layout(...types: WidgetType[]): DashboardLayout {
  return {
    version: 2,
    widgets: types.map((type, index) => ({
      id: `w-${index}`,
      type,
      x: 0,
      y: index,
      w: 4,
      h: 4,
    })),
  };
}

describe('Dashboard-Widget-Modulgates', () => {
  it('filtert persistierte Telefon-, Workflow-, Steuer-, RSS- und Wiedervorlage-Widgets', () => {
    const modules = {
      ...DEFAULT_BOOLEAN_TENANT_MODULES,
      phoneNotes: false,
      workflows: false,
      taxNotices: false,
      rssReader: false,
      reminders: false,
      appointments: false,
    };
    const stored = layout(
      'kpi_clients',
      'kpi_unread_notes',
      'phone_notes',
      'kpi_open_workflows',
      'my_workflows',
      'unreviewed_notices',
      'my_tax_deadlines',
      'calendar',
      'tax_news',
      'my_reminders',
      'my_workflow_items',
    );

    expect(filterDashboardLayoutByModules(stored, modules).widgets.map((w) => w.type)).toEqual([
      'kpi_clients',
    ]);
    expect(enabledDashboardWidgetTypes(modules)).not.toEqual(
      expect.arrayContaining([
        'phone_notes',
        'my_workflows',
        'my_tax_deadlines',
        'tax_news',
        'my_reminders',
      ]),
    );
  });

  it('behält gemischte Widgets bei und überlässt dem Loader die aktiven Teilquellen', () => {
    const modules = {
      ...DEFAULT_BOOLEAN_TENANT_MODULES,
      workflows: false,
      reminders: false,
      phoneNotes: false,
      taxNotices: false,
      appointments: true,
    };

    expect(
      filterDashboardLayoutByModules(layout('calendar', 'my_workflow_items'), modules).widgets.map(
        (w) => w.type,
      ),
    ).toEqual(['calendar', 'my_workflow_items']);
  });
});
