// =============================================================================
// /portal/settings — Portal-Einstellungen für Mandanten-Kontakte
//
// Aktuell ein Setting: E-Mail-Benachrichtigungen ein/aus. Anforderungen
// erscheinen unabhängig davon weiterhin im Portal-Inbox — nur die
// Begleit-Mail entfällt.
// =============================================================================

import { redirect } from 'next/navigation';
import { Bell, BellOff } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { countGranted, countRevocableGranted, parseConsent } from '@/server/privacy/consent';
import { revokeOwnConsentAction, saveNotificationSettingAction } from './actions';

export default async function PortalSettingsPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  const { tenantId, contactId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) => {
      const contact = await tx.clientContact.findUnique({
        where: { id: contactId },
        select: { notificationsEnabled: true, fullName: true, email: true, clientId: true },
      });
      if (!contact) return null;
      const consent = await tx.clientConsent.findFirst({
        where: { clientId: contact.clientId },
        select: { consents: true, createdAt: true, isRevocation: true, signedByContact: true },
        orderBy: { createdAt: 'desc' },
      });
      return { contact, consent };
    },
  );
  if (!data) redirect('/portal/login');
  const { contact, consent } = data;
  const currentConsent = consent ? parseConsent(consent.consents) : null;
  const activeConsentCount = currentConsent ? countGranted(currentConsent) : 0;
  const revocableConsentCount = currentConsent ? countRevocableGranted(currentConsent) : 0;
  const canSelfRevoke = revocableConsentCount > 0 && consent?.signedByContact === contactId;

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold text-primary mb-1">Einstellungen</h1>
      <p className="text-muted text-sm mb-6">
        {contact.fullName} · {contact.email}
      </p>

      <div className="card p-6 mb-6">
        <h2 className="text-sm font-medium text-primary mb-1 flex items-center gap-2">
          {contact.notificationsEnabled ? (
            <Bell className="h-4 w-4 text-brand-600" />
          ) : (
            <BellOff className="h-4 w-4 text-disabled" />
          )}
          E-Mail-Benachrichtigungen
        </h2>
        <p className="text-xs text-muted mb-4">
          Wenn ausgeschaltet, erhalten Sie keine Mails mehr für neue Anforderungen, Erinnerungen
          oder Bescheid-Eingänge. Alle Inhalte bleiben weiterhin im Portal sichtbar.
        </p>
        <form action={saveNotificationSettingAction}>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={contact.notificationsEnabled}
                className="rounded border-strong text-brand-600"
              />
              <span className="text-primary">Benachrichtigungen per E-Mail erhalten</span>
            </label>
            <button type="submit" className="btn-primary">
              Speichern
            </button>
          </div>
        </form>
      </div>

      <div className="card p-6 border-red-200">
        <h2 className="text-sm font-medium text-primary mb-1">Datenschutz-Auswahl</h2>
        <p className="text-xs text-muted mb-4">
          {activeConsentCount > 0
            ? `Für ${activeConsentCount} Datenschutz-Option(en) ist derzeit eine aktive Auswahl dokumentiert.`
            : 'Derzeit ist keine aktive Datenschutz-Auswahl dokumentiert.'}{' '}
          Freiwillige Einwilligungen können mit Wirkung für die Zukunft widerrufen werden. Rechtlich
          notwendige Bestätigungen bleiben als Nachweis der damaligen Erklärung dokumentiert; die
          Mandatsbearbeitung auf anderen Rechtsgrundlagen bleibt unberührt.
        </p>
        {canSelfRevoke && (
          <form action={revokeOwnConsentAction}>
            <button
              type="submit"
              className="btn-secondary text-red-700 border-red-300 hover:bg-red-50"
            >
              Widerrufbare Auswahl zurückziehen
            </button>
          </form>
        )}
        {revocableConsentCount > 0 && !canSelfRevoke && (
          <p className="text-xs text-amber-700">
            Dieser Datenschutz-Auswahlstand ist einer anderen erklärenden Person zugeordnet.
            Widerrufbare Einwilligungen können jederzeit über die Kanzlei zurückgezogen werden.
          </p>
        )}
      </div>
    </div>
  );
}
