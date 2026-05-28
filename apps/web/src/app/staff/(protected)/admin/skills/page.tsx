// =============================================================================
// /staff/admin/skills — Tätigkeitsbereiche / Skills (FiBu, Lohn, …)
//
// Skill-Katalog der Kanzlei. System-Skills sind vorbelegt und können nicht
// gelöscht werden. Eigene Skills können angelegt, umbenannt, gelöscht werden.
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Tags } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { CreateSkillForm } from './create-form';
import { SkillRow } from './row';

const COLOR_HINT: Record<string, string> = {
  blue: 'Blau',
  amber: 'Bernstein',
  emerald: 'Grün',
  purple: 'Lila',
  pink: 'Pink',
  red: 'Rot',
  yellow: 'Gelb',
  gray: 'Grau',
};

export default async function SkillsAdminPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) {
    redirect('/staff/dashboard');
  }
  const { tenantId, staffId } = session.user;

  const skills = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.staffSkill.findMany({
        orderBy: [{ isSystem: 'desc' }, { sortOrder: 'asc' }, { label: 'asc' }],
        include: { _count: { select: { assignments: true } } },
      }),
  );

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/staff/admin" className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="page-title">
            <Tags className="h-6 w-6 text-brand-600" />
            Tätigkeitsbereiche
          </h1>
          <p className="text-muted text-sm">
            Skills wie Finanzbuchhaltung, Lohnabrechnung, Jahresabschluss. Mitarbeiter
            werden in der Benutzer-Verwaltung diesen Bereichen zugeordnet.
          </p>
        </div>
      </div>

      <details className="card p-6 mb-6">
        <summary className="cursor-pointer text-sm font-medium text-primary">
          + Eigenen Tätigkeitsbereich anlegen
        </summary>
        <div className="mt-4">
          <CreateSkillForm />
        </div>
      </details>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-default">
              <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">Bereich</th>
              <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">Kürzel</th>
              <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">Farbe</th>
              <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">Mitarbeiter</th>
              <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">Typ</th>
              <th className="text-right px-6 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {skills.map((s) => (
              <SkillRow
                key={s.id}
                id={s.id}
                slug={s.slug}
                label={s.label}
                color={s.color}
                isSystem={s.isSystem}
                assignments={s._count.assignments}
                colorHint={s.color ? COLOR_HINT[s.color] ?? s.color : '—'}
              />
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-disabled mt-4">
        System-Bereiche sind vorbelegt (FiBu, Lohn, Jahresabschluss, Steuer, Beratung)
        und können nur umbenannt werden, aber nicht gelöscht.
      </p>
    </div>
  );
}
