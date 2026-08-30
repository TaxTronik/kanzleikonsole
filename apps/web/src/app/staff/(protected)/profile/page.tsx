import { KeyRound, ShieldCheck, ShieldOff, UserRound } from 'lucide-react';
import { withTenantContext } from '@taxtronik/db';
import { requireStaffPage } from '@/server/auth/staff-page';
import { ChangePasswordForm } from './password-form';
import { AccessibleDisplaySettings } from '@/components/accessible-display';

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin',
  PARTNER: 'Partner',
  EMPLOYEE: 'Mitarbeiter',
};

export default async function StaffProfilePage() {
  const session = await requireStaffPage();
  const { tenantId, staffId } = session.user;
  const account = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.staffUser.findUnique({
        where: { id: staffId },
        select: { fullName: true, email: true, totpEnrolledAt: true },
      }),
  );

  return (
    <div className="max-w-5xl p-8">
      <div className="mb-6 flex items-start gap-3">
        <div className="shrink-0 rounded-lg bg-brand-100 p-2 text-brand-700">
          <UserRound className="h-5 w-5" />
        </div>
        <div className="min-w-0 break-words">
          <h1 className="text-2xl font-bold text-primary">Benutzerprofil</h1>
          <p className="mt-1 text-sm text-muted">Persönliche Konto- und Zugangseinstellungen.</p>
        </div>
      </div>

      <AccessibleDisplaySettings />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <section className="card p-6">
          <div className="mb-5 flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-brand-700" />
            <div>
              <h2 className="font-semibold text-primary">Passwort ändern</h2>
              <p className="text-xs text-muted">
                Das aktuelle Passwort wird zur Bestätigung benötigt.
              </p>
            </div>
          </div>
          <ChangePasswordForm />
        </section>

        <div className="space-y-6">
          <section className="card p-6">
            <h2 className="mb-3 font-semibold text-primary">Kontodaten</h2>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-muted">Name</dt>
                <dd className="font-medium text-primary">
                  {account?.fullName ?? session.user.fullName}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">E-Mail</dt>
                <dd className="break-all text-secondary">{account?.email ?? session.user.email}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Rollen</dt>
                <dd className="text-secondary">
                  {session.user.roles.map((role) => ROLE_LABELS[role] ?? role).join(', ')}
                </dd>
              </div>
            </dl>
          </section>

          <section className="card p-6">
            <div className="mb-2 flex items-center gap-2">
              {account?.totpEnrolledAt ? (
                <ShieldCheck className="h-5 w-5 text-emerald-600" />
              ) : (
                <ShieldOff className="h-5 w-5 text-amber-600" />
              )}
              <h2 className="font-semibold text-primary">Zwei-Faktor-Authentisierung</h2>
            </div>
            <p className="text-sm text-secondary">
              {account?.totpEnrolledAt
                ? '2FA ist für dieses Konto aktiv.'
                : '2FA wird bei der nächsten Anmeldung eingerichtet.'}
            </p>
            <p className="mt-3 text-xs text-muted">
              Falls Authenticator und Backup-Codes verloren gehen, kann ein Admin die 2FA-Zuordnung
              im Menü „Benutzer“ zurücksetzen.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
