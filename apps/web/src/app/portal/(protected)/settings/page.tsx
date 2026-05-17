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
import { saveNotificationSettingAction } from './actions';

export default async function PortalSettingsPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  const { tenantId, contactId } = session.user;

  const contact = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    (tx) =>
      tx.clientContact.findUnique({
        where: { id: contactId },
        select: { notificationsEnabled: true, fullName: true, email: true },
      }),
  );
  if (!contact) redirect('/portal/login');

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Einstellungen</h1>
      <p className="text-gray-500 text-sm mb-6">
        {contact.fullName} · {contact.email}
      </p>

      <div className="card p-6">
        <h2 className="text-sm font-medium text-gray-900 mb-1 flex items-center gap-2">
          {contact.notificationsEnabled ? (
            <Bell className="h-4 w-4 text-brand-600" />
          ) : (
            <BellOff className="h-4 w-4 text-gray-400" />
          )}
          E-Mail-Benachrichtigungen
        </h2>
        <p className="text-xs text-gray-500 mb-4">
          Wenn ausgeschaltet, erhalten Sie keine Mails mehr für neue Anforderungen,
          Erinnerungen oder Bescheid-Eingänge. Alle Inhalte bleiben weiterhin
          im Portal sichtbar.
        </p>
        <form action={saveNotificationSettingAction}>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={contact.notificationsEnabled}
                className="rounded border-gray-300 text-brand-600"
              />
              <span className="text-gray-900">Benachrichtigungen per E-Mail erhalten</span>
            </label>
            <button type="submit" className="btn-primary">Speichern</button>
          </div>
        </form>
      </div>
    </div>
  );
}
