// =============================================================================
// /staff/admin/users — Benutzer-Verwaltung (Admin/Partner only)
//
// Übersicht aller Mitarbeiter, Anlegen, Rollen-Pflege und Kontozugang.
// TOTP wird beim ersten Login eingerichtet. Recovery folgt der Rollen-Hierarchie;
// ADMIN-Konten werden ausschließlich über die Operator-CLI zurückgesetzt.
// =============================================================================

import Link from 'next/link';
import { ArrowLeft, UserPlus, ShieldCheck } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';

import { withTenantContext } from '@taxtronik/db';
import { fmtDateNumeric } from '@/lib/fmt';
import { CreateUserForm } from './create-form';
import {
  AccountSecurityForm,
  ToggleActiveForm,
  SetRolesForm,
  SetPermissionsForm,
  SetSkillsForm,
  ProfessionalProfileForm,
} from './row-forms';
import { SkillBadge } from '@/components/skill-badge';

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin',
  PARTNER: 'Partner',
  EMPLOYEE: 'Mitarbeiter',
};

function managementPolicy(actorIsAdmin: boolean, targetRoles: readonly string[]) {
  const targetIsAdmin = targetRoles.includes('ADMIN');
  const targetIsPartner = targetRoles.includes('PARTNER');
  const partnerBlockedFromAdmin = !actorIsAdmin && targetIsAdmin;
  let accountRecoveryBlockedReason: string | undefined;
  if (targetIsAdmin) {
    accountRecoveryBlockedReason =
      'ADMIN-Zugang: Wiederherstellung ausschließlich per Administrations-CLI.';
  } else if (!actorIsAdmin && targetIsPartner) {
    accountRecoveryBlockedReason =
      'PARTNER-Zugänge können nur durch einen ADMIN wiederhergestellt werden.';
  }
  return {
    targetIsAdmin,
    targetIsPartner,
    partnerBlockedFromAdmin,
    accountRecoveryBlockedReason,
  };
}

function roleChangeDisabledReason(
  actorIsAdmin: boolean,
  targetIsAdmin: boolean,
  targetIsPartner: boolean,
): string | undefined {
  if (targetIsAdmin) return 'ADMIN-Rollen können im Web nicht entzogen werden';
  if (!actorIsAdmin && targetIsPartner) {
    return 'PARTNER-Rollen können nur durch einen ADMIN entzogen werden';
  }
  return undefined;
}

function UserPermissions({
  userId,
  roleNames,
  isSelf,
  currentPermissions,
}: {
  userId: string;
  roleNames: readonly string[];
  isSelf: boolean;
  currentPermissions: string[];
}) {
  if (roleNames.includes('ADMIN') || roleNames.includes('PARTNER')) {
    return (
      <span
        className="text-xs text-disabled"
        title="ADMIN/PARTNER haben implizit alle Berechtigungen"
      >
        alle (implizit)
      </span>
    );
  }
  if (isSelf) return <span className="text-xs text-disabled">—</span>;
  return <SetPermissionsForm userId={userId} currentPermissions={currentPermissions} />;
}

function UserLoginMode({
  hardwareOnly,
  hardwareInventoryVisible,
  hardwareKeyCount,
  totpEnrolled,
}: {
  hardwareOnly: boolean;
  hardwareInventoryVisible: boolean;
  hardwareKeyCount: number;
  totpEnrolled: boolean;
}) {
  if (hardwareOnly) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-secondary"
        title={
          hardwareInventoryVisible
            ? 'Anzahl sichtbarer aktiver Credential-Einträge; keine Prüfung getrennter Geräteinstanzen oder aktueller Funktionsfähigkeit.'
            : 'Der Credential-Bestand dieses geschützten Kontos ist für Ihre Rolle nicht einsehbar.'
        }
      >
        <ShieldCheck className="h-3.5 w-3.5" />
        {hardwareInventoryVisible
          ? `Nur Schlüssel · ${hardwareKeyCount} registriert`
          : 'Nur Schlüssel · Bestand nicht einsehbar'}
      </span>
    );
  }
  if (totpEnrolled) {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700 text-xs">
        <ShieldCheck className="h-3.5 w-3.5" />
        Passwort + 2FA
      </span>
    );
  }
  return <span className="text-xs text-amber-700">Einrichtung offen</span>;
}

function UserStatus({
  userId,
  active,
  isSelf,
  recoveryBlocked,
}: {
  userId: string;
  active: boolean;
  isSelf: boolean;
  recoveryBlocked: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {active ? (
        <span className="badge-green">Aktiv</span>
      ) : (
        <span className="badge-gray">Deaktiviert</span>
      )}
      {!isSelf && !recoveryBlocked && <ToggleActiveForm userId={userId} active={active} />}
    </div>
  );
}

function hasTotpConfiguration(input: {
  secret: string | null;
  enrolledAt: Date | null;
  setupStartedAt: Date | null;
  backupCodes: unknown;
}): boolean {
  return Boolean(
    input.secret ||
    input.enrolledAt ||
    input.setupStartedAt ||
    (Array.isArray(input.backupCodes) && input.backupCodes.length > 0),
  );
}

export default async function UsersAdminPage() {
  const session = await requireStaffPage({ admin: true });
  const { tenantId, staffId } = session.user;
  const actorIsAdmin = session.user.roles.includes('ADMIN');

  const [users, allSkills, uncoveredClients] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.staffUser.findMany({
          orderBy: [{ active: 'desc' }, { fullName: 'asc' }],
          include: {
            roles: true,
            permissions: true,
            skillAssignments: { include: { skill: true } },
            hardwareCredentials: { where: { revokedAt: null }, select: { id: true } },
          },
        }),
        tx.staffSkill.findMany({
          orderBy: [{ isSystem: 'desc' }, { sortOrder: 'asc' }, { label: 'asc' }],
        }),
        tx.client.findMany({
          where: {
            responsibilities: {
              none: {
                role: 'BERUFSTRAEGER',
                staff: { active: true, isProfessional: true, roles: { some: {} } },
              },
            },
          },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
      ]),
  );
  const actorHardwareOnly = Boolean(
    users.find((user) => user.id === staffId)?.hardwareOnlyEnabledAt,
  );

  return (
    <div className="max-w-[112rem] p-8">
      <div className="flex items-start gap-4 mb-6">
        <Link
          href="/staff/admin"
          aria-label="Zurück"
          className="text-disabled hover:text-secondary mt-1"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Benutzer</h1>
          <p className="text-muted text-sm">
            Mitarbeiter, Rollen, Kontozugänge und Status. TOTP richtet jeder Benutzer beim ersten
            Login selbst ein.
          </p>
        </div>
      </div>

      <details className="card p-6 mb-6">
        <summary className="cursor-pointer text-sm font-medium text-primary flex items-center gap-2">
          <UserPlus className="h-4 w-4" />
          Neuen Benutzer anlegen
        </summary>
        <div className="mt-4">
          <CreateUserForm canAssignAdmin={actorIsAdmin} />
        </div>
      </details>

      <div className="card overflow-hidden">
        {uncoveredClients.length > 0 && (
          <div role="alert" className="border-b border-default p-4 text-sm text-amber-700">
            <p>
              {uncoveredClients.length} Mandat(e) ohne aktiven qualifizierten Berufsträger.
              Bestehende Nachweise bleiben erhalten; neue Freigaben sind gesperrt.
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer">Zuordnungen prüfen</summary>
              <ul>
                {uncoveredClients.map((client) => (
                  <li key={client.id}>
                    <Link className="underline" href={`/staff/clients/${client.id}/edit`}>
                      {client.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
        <table className="block w-full text-sm xl:table xl:table-fixed">
          <colgroup className="hidden xl:table-column-group">
            <col className="w-[15%]" />
            <col className="w-[13%]" />
            <col className="w-[16%]" />
            <col className="w-[13%]" />
            <col className="w-[7%]" />
            <col className="w-[7%]" />
            <col className="w-[9%]" />
            <col className="w-[20%]" />
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
              <th className="text-left px-3 py-3 text-xs font-medium text-muted uppercase">
                Anmeldung
              </th>
              <th className="text-left px-3 py-3 text-xs font-medium text-muted uppercase">
                Letzter Login
              </th>
              <th className="text-left px-3 py-3 text-xs font-medium text-muted uppercase">
                Status
              </th>
              <th className="text-left px-3 py-3 text-xs font-medium text-muted uppercase">
                Kontosicherheit
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
              const hardwareOnly = Boolean(u.hardwareOnlyEnabledAt);
              const hardwareKeyCount = u.hardwareCredentials.length;
              const {
                targetIsAdmin,
                targetIsPartner,
                partnerBlockedFromAdmin,
                accountRecoveryBlockedReason,
              } = managementPolicy(actorIsAdmin, roleNames);
              const roleChangeBlocked =
                isSelf || targetIsAdmin || (!actorIsAdmin && targetIsPartner);
              const hardwareInventoryVisible =
                isSelf || (!targetIsAdmin && (actorIsAdmin || !targetIsPartner));
              return (
                <tr
                  key={u.id}
                  className={`grid min-w-0 gap-x-6 gap-y-4 rounded-lg border border-default p-4 sm:grid-cols-2 xl:table-row xl:rounded-none xl:border-0 xl:border-b xl:p-0 xl:last:border-b-0 ${
                    u.active ? 'xl:hover:bg-gray-50' : 'bg-surface-page'
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
                    <SetRolesForm
                      userId={u.id}
                      currentRoles={roleNames}
                      disabled={roleChangeBlocked}
                      canAssignAdmin={actorIsAdmin}
                      disabledReason={roleChangeDisabledReason(
                        actorIsAdmin,
                        targetIsAdmin,
                        targetIsPartner,
                      )}
                    />
                    <ProfessionalProfileForm
                      userId={u.id}
                      isProfessional={u.isProfessional}
                      advisorNumber={u.datevAdvisorNumber}
                      source={u.professionalQualificationSource}
                      disabled={partnerBlockedFromAdmin}
                    />
                  </td>
                  <td className="min-w-0 align-top xl:px-3 xl:py-3">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted xl:hidden">
                      Berechtigungen
                    </span>
                    {/* iter87: ADMIN/PARTNER haben implizit alles — Chips nur
                        für EMPLOYEE-only-Benutzer (und nicht für sich selbst). */}
                    <UserPermissions
                      userId={u.id}
                      roleNames={roleNames}
                      isSelf={isSelf}
                      currentPermissions={u.permissions.map((p) => p.permission)}
                    />
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
                      Anmeldung
                    </span>
                    <UserLoginMode
                      hardwareOnly={hardwareOnly}
                      hardwareInventoryVisible={hardwareInventoryVisible}
                      hardwareKeyCount={hardwareKeyCount}
                      totpEnrolled={Boolean(u.totpEnrolledAt)}
                    />
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
                    <UserStatus
                      userId={u.id}
                      active={u.active}
                      isSelf={isSelf}
                      recoveryBlocked={partnerBlockedFromAdmin}
                    />
                  </td>
                  <td className="min-w-0 align-top sm:col-span-2 xl:table-cell xl:px-3 xl:py-3">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted xl:hidden">
                      Kontosicherheit
                    </span>
                    <AccountSecurityForm
                      userId={u.id}
                      isSelf={isSelf}
                      isAdminAccount={targetIsAdmin}
                      blockedReason={accountRecoveryBlockedReason}
                      hardwareOnly={hardwareOnly}
                      hardwareKeyCount={hardwareKeyCount}
                      actorHardwareOnly={actorHardwareOnly}
                      totpEnrolled={Boolean(u.totpEnrolledAt)}
                      totpConfigured={hasTotpConfiguration({
                        secret: u.totpSecretEnc,
                        enrolledAt: u.totpEnrolledAt,
                        setupStartedAt: u.totpSetupStartedAt,
                        backupCodes: u.totpBackupCodes,
                      })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-disabled mt-4">
        Verfügbare Rollen: {Object.values(ROLE_LABELS).join(', ')}. Tätigkeitsbereiche werden in{' '}
        <Link href="/staff/admin/skills" className="text-brand-700 underline underline-offset-2">
          /admin/skills
        </Link>{' '}
        verwaltet.
      </p>
    </div>
  );
}
