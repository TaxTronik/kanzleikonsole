import { staffAuth } from '@/server/auth/staff';
import { readModules } from '@/server/settings/modules';
import { readClientLayout } from '@/server/settings/client-layout';
import { ModulesForm } from '../modules-form';
import { ClientLayoutForm } from '../client-layout-form';
import { SectionCard } from '../section-card';
import { redirect } from 'next/navigation';

export default async function ModulesSettingsPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const [modules, layout] = await Promise.all([
    readModules(ctx),
    readClientLayout(ctx),
  ]);

  return (
    <div className="space-y-6">
      <SectionCard
        title="Module"
        description="Welche Bereiche der App nutzt Ihre Kanzlei? Deaktivierte Module verschwinden aus der Seitenleiste und sind für Mitarbeiter und Mandanten unsichtbar."
      >
        <ModulesForm initial={modules} />
      </SectionCard>

      <SectionCard
        title="Mandanten-Cockpit Layout"
        description="In welcher Reihenfolge sollen die Karten oben im Mandanten-Cockpit angezeigt werden? Drag-and-Drop sortiert pro Kanzlei — alle Mitarbeiter sehen dieselbe Reihenfolge."
      >
        <ClientLayoutForm initial={layout} />
      </SectionCard>
    </div>
  );
}
