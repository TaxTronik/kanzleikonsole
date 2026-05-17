// =============================================================================
// /staff/admin/users — Benutzer-Verwaltung (Admin/Partner only)
//
// Übersicht aller Mitarbeiter, Anlegen + Deaktivieren + Rollen-Pflege.
// Passwort-Reset ist hier nicht vorgesehen — Mitarbeiter müssen den
// "Passwort vergessen"-Flow nutzen (existiert oder kommt separat).
// TOTP wird beim ersten Login vom Mitarbeiter selbst eingerichtet.
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, UserPlus, ShieldCheck } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { CreateUserForm } from './create-form';
import { ToggleActiveForm, SetRolesForm, SetSkillsForm } from './row-forms';
import { SkillBadge } from '@/components/skill-badge';

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin',
  PARTNER: 'Partner',
  EMPLOYEE: 'Mitarbeiter',
};

export default async function UsersAdminPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) {
    redirect('/staff/dashboard');
  }
  const { tenantId, staffId } = session.user;

  const [users, allSkills] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.staffUser.findMany({
          orderBy: [{ active: 'desc' }, { fullName: 'asc' }],
          include: {
            roles: true,
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
        <Link href="/staff/admin" className="text-gray-400 hover:text-gray-600 mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Benutzer</h1>
          <p className="text-gray-500 text-sm">
            Mitarbeiter, Rollen und Status. TOTP richtet jeder Benutzer beim ersten Login selbst ein.
          </p>
        </div>
      </div>

      <details className="card p-6 mb-6">
        <summary className="cursor-pointer text-sm font-medium text-gray-900 flex items-center gap-2">
          <UserPlus className="h-4 w-4" />
          Neuen Benutzer anlegen
        </summary>
        <div className="mt-4">
          <CreateUserForm />
        </div>
      </details>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[64rem]">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Name</th>
              <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">E-Mail</th>
              <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Rollen</th>
              <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Tätigkeiten</th>
              <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">2FA</th>
              <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Letzter Login</th>
              <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="text-right px-6 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
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
                <tr key={u.id} className={u.active ? 'hover:bg-gray-50' : 'opacity-60'}>
                  <td className="px-6 py-3 font-medium text-gray-900">
                    {u.fullName}
                    {isSelf && <span className="ml-2 text-xs text-gray-400">(Sie)</span>}
                  </td>
                  <td className="px-6 py-3 text-gray-600">{u.email}</td>
                  <td className="px-6 py-3">
                    <SetRolesForm userId={u.id} currentRoles={roleNames} disabled={isSelf} />
                  </td>
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex flex-wrap gap-1">
                        {skillsForDisplay.length === 0 ? (
                          <span className="text-xs text-gray-400">—</span>
                        ) : (
                          skillsForDisplay.map((s) => (
                            <SkillBadge key={s.id} label={s.label} color={s.color} />
                          ))
                        )}
                      </div>
                      <SetSkillsForm
                        userId={u.id}
                        currentSkillIds={skillIds}
                        allSkills={allSkills.map((s) => ({ id: s.id, label: s.label, color: s.color }))}
                      />
                    </div>
                  </td>
                  <td className="px-6 py-3">
                    {u.totpEnrolledAt ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 text-xs">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        aktiv
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">nicht eingerichtet</span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-xs text-gray-500">
                    {u.lastLoginAt
                      ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'short' }).format(u.lastLoginAt)
                      : '—'}
                  </td>
                  <td className="px-6 py-3">
                    {u.active ? (
                      <span className="badge-green">Aktiv</span>
                    ) : (
                      <span className="badge-gray">Deaktiviert</span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-right">
                    {!isSelf && (
                      <ToggleActiveForm userId={u.id} active={u.active} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-400 mt-4">
        Verfügbare Rollen: {Object.values(ROLE_LABELS).join(', ')}.
        Tätigkeitsbereiche werden in <Link href="/staff/admin/skills" className="text-brand-700 hover:underline">/admin/skills</Link> verwaltet.
      </p>
    </div>
  );
}
