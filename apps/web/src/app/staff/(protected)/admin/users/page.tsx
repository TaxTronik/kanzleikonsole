// =============================================================================
// /staff/admin/users — Benutzer-Verwaltung (Admin/Partner only)
//
// Übersicht aller Mitarbeiter, Anlegen + Deaktivieren + Rollen-Pflege.
// Passwort-Reset ist hier nicht vorgesehen — Mitarbeiter müssen den
// "Passwort vergessen"-Flow nutzen (existiert oder kommt separat).
// TOTP wird beim ersten Login vom Mitarbeiter selbst eingerichtet.
// =============================================================================

import Link from 'next/link';
import { ArrowLeft, UserPlus, ShieldCheck } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';

import { withTenantContext } from '@taxtronik/db';
import { fmtDateNumeric } from '@/lib/fmt';
import { CreateUserForm } from './create-form';
import { ToggleActiveForm, SetRolesForm, SetPermissionsForm, SetSkillsForm } from './row-forms';
import { SkillBadge } from '@/components/skill-badge';

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin',
  PARTNER: 'Partner',
  EMPLOYEE: 'Mitarbeiter',
};

export default async function UsersAdminPage() {
  const session = await requireStaffPage({ admin: true });
  const { tenantId, staffId } = session.user;

  const [users, allSkills] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.staffUser.findMany({
          orderBy: [{ active: 'desc' }, { fullName: 'asc' }],
          include: {
            roles: true,
            permissions: true,
            skillAssignments: { include: { skill: true } },
          },
        }),
        tx.staffSkill.findMany({
          orderBy: [{ isSystem: 'desc' }, { sortOrder: 'asc' }, { label: 'asc' }],
        }),
      ]),
  );

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/staff/admin" className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Benutzer</h1>
          <p className="text-muted text-sm">
            Mitarbeiter, Rollen und Status. TOTP richtet jeder Benutzer beim ersten Login selbst
            ein.
          </p>
        </div>
      </div>

      <details className="card p-6 mb-6">
        <summary className="cursor-pointer text-sm font-medium text-primary flex items-center gap-2">
          <UserPlus className="h-4 w-4" />
          Neuen Benutzer anlegen
        </summary>
        <div className="mt-4">
          <CreateUserForm />
        </div>
      </details>

      <div className="card overflow-hidden">
        <table className="block w-full text-sm xl:table xl:table-fixed">
          <colgroup className="hidden xl:table-column-group">
            <col className="w-[19%]" />
            <col className="w-[17%]" />
            <col className="w-[20%]" />
            <col className="w-[15%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[11%]" />
          </colgroup>
          <thead className="hidden xl:table-header-group">
            <tr className="bg-gray-50 border-b border-default">
              <th className="text-left px-3 py-3 text-xs font-medium text-muted uppercase">
                Benutzer
              </th>
              <th className="text-left px-3 py-3 text-xs font-medium text-muted uppercase">
                Rollen
              </th>
              <th className="text-left px-3 py-3 text-xs font-medium text-muted uppercase">
                Berechtigungen
              </th>
              <th className="text-left px-3 py-3 text-xs font-medium text-muted uppercase">
                Tätigkeiten
              </th>
              <th className="text-left px-3 py-3 text-xs font-medium text-muted uppercase">2FA</th>
              <th className="text-left px-3 py-3 text-xs font-medium text-muted uppercase">
                Letzter Login
              </th>
              <th className="text-left px-3 py-3 text-xs font-medium text-muted uppercase">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="grid gap-3 p-3 sm:p-4 xl:table-row-group xl:p-0">
            {users.map((u) => {
              const roleNames = u.roles.map((r) => r.role);
              const skillIds = u.skillAssignments.map((a) => a.skillId);
              const skillsForDisplay = u.skillAssignments.map((a) => ({
                id: a.skill.id,
                label: a.skill.label,
                color: a.skill.color,
              }));
              const isSelf = u.id === staffId;
              return (
                <tr
                  key={u.id}
                  className={`grid min-w-0 gap-x-6 gap-y-4 rounded-lg border border-default p-4 sm:grid-cols-2 xl:table-row xl:rounded-none xl:border-0 xl:border-b xl:p-0 xl:last:border-b-0 ${
                    u.active ? 'xl:hover:bg-gray-50' : 'opacity-60'
                  }`}
                >
                  <td className="min-w-0 align-top xl:px-3 xl:py-3">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted xl:hidden">
                      Benutzer
                    </span>
                    <div className="font-medium text-primary">
                      {u.fullName}
                      {isSelf && <span className="ml-2 text-xs text-disabled">(Sie)</span>}
                    </div>
                    <div className="mt-0.5 break-all text-xs text-secondary">{u.email}</div>
                  </td>
                  <td className="min-w-0 align-top xl:px-3 xl:py-3">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted xl:hidden">
                      Rollen
                    </span>
                    <SetRolesForm userId={u.id} currentRoles={roleNames} disabled={isSelf} />
                  </td>
                  <td className="min-w-0 align-top xl:px-3 xl:py-3">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted xl:hidden">
                      Berechtigungen
                    </span>
                    {/* iter87: ADMIN/PARTNER haben implizit alles — Chips nur
                        für EMPLOYEE-only-Benutzer (und nicht für sich selbst). */}
                    {roleNames.includes('ADMIN') || roleNames.includes('PARTNER') ? (
                      <span
                        className="text-xs text-disabled"
                        title="ADMIN/PARTNER haben implizit alle Berechtigungen"
                      >
                        alle (implizit)
                      </span>
                    ) : isSelf ? (
                      <span className="text-xs text-disabled">—</span>
                    ) : (
                      <SetPermissionsForm
                        userId={u.id}
                        currentPermissions={u.permissions.map((p) => p.permission)}
                      />
                    )}
                  </td>
                  <td className="min-w-0 align-top xl:px-3 xl:py-3">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted xl:hidden">
                      Tätigkeiten
                    </span>
                    <div className="flex min-w-0 items-start gap-1">
                      <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                        {skillsForDisplay.length === 0 ? (
                          <span className="text-xs text-disabled">—</span>
                        ) : (
                          skillsForDisplay.map((s) => (
                            <SkillBadge key={s.id} label={s.label} color={s.color} />
                          ))
                        )}
                      </div>
                      <SetSkillsForm
                        userId={u.id}
                        currentSkillIds={skillIds}
                        allSkills={allSkills.map((s) => ({
                          id: s.id,
                          label: s.label,
                          color: s.color,
                        }))}
                      />
                    </div>
                  </td>
                  <td className="min-w-0 align-top xl:px-3 xl:py-3">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted xl:hidden">
                      2FA
                    </span>
                    {u.totpEnrolledAt ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 text-xs">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        aktiv
                      </span>
                    ) : (
                      <span className="text-xs text-disabled">nicht eingerichtet</span>
                    )}
                  </td>
                  <td className="min-w-0 align-top text-xs text-muted xl:px-3 xl:py-3">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted xl:hidden">
                      Letzter Login
                    </span>
                    {u.lastLoginAt ? fmtDateNumeric(u.lastLoginAt) : '—'}
                  </td>
                  <td className="min-w-0 align-top sm:col-span-2 xl:table-cell xl:px-3 xl:py-3">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted xl:hidden">
                      Status
                    </span>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {u.active ? (
                        <span className="badge-green">Aktiv</span>
                      ) : (
                        <span className="badge-gray">Deaktiviert</span>
                      )}
                      {!isSelf && <ToggleActiveForm userId={u.id} active={u.active} />}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-disabled mt-4">
        Verfügbare Rollen: {Object.values(ROLE_LABELS).join(', ')}. Tätigkeitsbereiche werden in{' '}
        <Link href="/staff/admin/skills" className="text-brand-700 hover:underline">
          /admin/skills
        </Link>{' '}
        verwaltet.
      </p>
    </div>
  );
}
