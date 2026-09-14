// =============================================================================
// /staff/admin/skills — Tätigkeitsbereiche / Skills (FiBu, Lohn, …)
//
// Skill-Katalog der Kanzlei. System-Skills sind vorbelegt und können nicht
// gelöscht werden. Eigene Skills können angelegt, umbenannt, gelöscht werden.
// =============================================================================

import Link from 'next/link';
import { ArrowLeft, Tags } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';

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
  const session = await requireStaffPage({ admin: true });
  const { tenantId, staffId } = session.user;

  const skills = await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
    tx.staffSkill.findMany({
      orderBy: [{ isSystem: 'desc' }, { sortOrder: 'asc' }, { label: 'asc' }],
      include: { _count: { select: { assignments: true } } },
    }),
  );

  return (
    <div className="min-w-0 max-w-4xl p-4 sm:p-6 lg:p-8">
      <Link href="/staff/admin" className="back-link mb-3">
        <ArrowLeft className="h-3 w-3" />
        Administration
      </Link>
      <div className="mb-6">
        <h1 className="page-title [overflow-wrap:anywhere]">
          <Tags className="h-6 w-6 shrink-0 text-brand-600" />
          Tätigkeitsbereiche
        </h1>
        <p className="text-muted text-sm">
          Skills wie Finanzbuchhaltung, Lohnabrechnung, Jahresabschluss. Mitarbeiter werden in der
          Benutzer-Verwaltung diesen Bereichen zugeordnet.
        </p>
      </div>

      <details className="card mb-6 p-4 sm:p-6">
        <summary className="cursor-pointer text-sm font-semibold text-primary">
          Tätigkeitsbereich anlegen
        </summary>
        <div className="mt-4">
          <CreateSkillForm />
        </div>
      </details>

      <div
        className="card overflow-x-auto"
        role="region"
        aria-label="Tätigkeitsbereiche"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Horizontale Tabellenspalten müssen per Tastatur erreichbar sein.
        tabIndex={0}
      >
        <table className="w-full min-w-[48rem] text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-default">
              <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">
                Bereich
              </th>
              <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">
                Kürzel
              </th>
              <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">
                Farbe
              </th>
              <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">
                Mitarbeiter
              </th>
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
                colorHint={s.color ? (COLOR_HINT[s.color] ?? s.color) : '—'}
              />
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-disabled mt-4">
        System-Bereiche sind vorbelegt (FiBu, Lohn, Jahresabschluss, Steuer, Beratung) und können
        nur umbenannt werden, aber nicht gelöscht.
      </p>
    </div>
  );
}
