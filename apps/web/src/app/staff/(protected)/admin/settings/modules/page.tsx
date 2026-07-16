import { requireStaffPage } from '@/server/auth/staff-page';
import { readModules } from '@/server/settings/modules';
import { readClientLayout } from '@/server/settings/client-layout';
import { readAccessPolicy } from '@/server/settings/access-policy';
import { ModulesForm } from '../modules-form';
import { ClientLayoutForm } from '../client-layout-form';
import { AccessPolicyForm } from '../access-policy-form';
import { SectionCard } from '../section-card';

export default async function ModulesSettingsPage() {
  const session = await requireStaffPage({ admin: true });
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const [modules, layout, accessPolicy] = await Promise.all([
    readModules(ctx),
    readClientLayout(ctx),
    readAccessPolicy(ctx),
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
        title="Zugriffsmodell"
        description="Dürfen Mitarbeiter mandantenübergreifend arbeiten, oder nur an ihren zugeordneten Mandanten? Im offenen Modus trägt das Audit-Log die Nachvollziehbarkeit."
      >
        <AccessPolicyForm initial={accessPolicy} />
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
