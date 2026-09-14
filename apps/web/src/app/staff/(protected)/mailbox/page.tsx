import Link from 'next/link';
import { ChevronDown, Download, FileText, Inbox, Mail, Paperclip, Plus } from 'lucide-react';
import { withTenantContext } from '@taxtronik/db';
import { staffActionGuard } from '@/server/actions/staff-action';
import { requireStaffPage } from '@/server/auth/staff-page';
import { accessibleClientsWhereFor, isStaffAdmin } from '@/server/auth/rbac';
import { connectMicrosoft, importAttachment, saveMailbox, setMailboxEnabled } from './actions';
import { suggestInboundClients } from '@/server/mailbox/suggestions';
import { loadMailboxDocumentTypesTx } from '@/server/mailbox/document-types';

export default async function MailboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireStaffPage();
  const g = await staffActionGuard({
    requirePermission: 'INBOUND_MAIL_MANAGE',
    module: 'smartMailbox',
  });
  if (!g.ok)
    return (
      <div className="p-6 sm:p-8">
        <p className="alert-error" role="alert">
          {g.error}
        </p>
      </div>
    );
  const query = await searchParams;
  const data = await withTenantContext(g.ctx, async (tx) => ({
    accounts: await tx.inboundMailbox.findMany({
      where: { tenantId: g.tenantId },
      select: {
        id: true,
        name: true,
        provider: true,
        username: true,
        enabled: true,
        lastSuccessAt: true,
        lastError: true,
      },
      orderBy: { name: 'asc' },
    }),
    messages: await tx.inboundMessage.findMany({
      where: { mailbox: { tenantId: g.tenantId } },
      include: { attachments: true, mailbox: { select: { name: true } } },
      orderBy: { receivedAt: 'desc' },
      take: 100,
    }),
    clients: await tx.client.findMany({
      where: {
        ...(await accessibleClientsWhereFor(tx, g.session)),
        tenantId: g.tenantId,
        allowActive: true,
        anonymizedAt: null,
        mandateEndedAt: null,
      },
      select: {
        id: true,
        name: true,
        contacts: { where: { active: true }, select: { email: true } },
      },
      orderBy: { name: 'asc' },
    }),
    types: await loadMailboxDocumentTypesTx(tx, g.tenantId),
  }));
  return (
    <div className="space-y-6 p-6 sm:p-8">
      <header>
        <h1 className="page-title">Interner Posteingang</h1>
        <p className="text-sm text-muted">
          Postfächer verwalten, Nachrichten prüfen und Anhänge zuordnen.
        </p>
      </header>
      <p className="alert-info leading-relaxed">
        Absender und Empfänger sind unbestätigte Nachrichtenangaben. Erst Ihre Zuordnung erzeugt ein
        Archivdokument. Es erfolgt keine automatische Portalfreigabe. Nachrichten bleiben im
        Ursprungs-Postfach unverändert.
      </p>
      {query.connectionError && (
        <p className="alert-error" role="alert">
          Microsoft-Verbindung fehlgeschlagen. Entra-Konfiguration, Einwilligung und IMAP-Freigabe
          prüfen. Sicherheitsrichtlinien nicht abschalten.
        </p>
      )}
      {query.connected && (
        <p className="alert-success" role="status">
          Microsoft verbunden. Sie können den Abruf jetzt aktivieren.
        </p>
      )}
      <section aria-labelledby="mailbox-accounts-heading" className="space-y-3">
        <h2 id="mailbox-accounts-heading" className="text-base font-semibold text-primary">
          Postfächer
        </h2>
        {data.accounts.length === 0 && (
          <div className="card flex items-start gap-3 p-6">
            <Mail className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-primary">Noch kein Postfach eingerichtet</p>
              <p className="mt-1 text-sm text-muted">
                {isStaffAdmin(g.session)
                  ? 'Fügen Sie unten ein Postfach hinzu, um Nachrichten abzurufen.'
                  : 'Ihre Kanzleiadministration kann ein Postfach hinzufügen.'}
              </p>
            </div>
          </div>
        )}
        <div className="grid gap-4 xl:grid-cols-2">
          {data.accounts.map((a) => (
            <section key={a.id} className="card min-w-0 space-y-4 p-5 sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-semibold text-primary break-words">{a.name}</h3>
                  <p className="mt-1 text-sm text-muted break-words">{a.username}</p>
                </div>
                <span className={a.enabled ? 'badge-green shrink-0' : 'badge-gray shrink-0'}>
                  {a.enabled ? 'Aktiv' : 'Pausiert'}
                </span>
              </div>
              <p className="text-xs text-muted">
                Letzter erfolgreicher Abruf:{' '}
                {a.lastSuccessAt?.toLocaleString('de-DE') ?? 'noch keiner'}
              </p>
              {a.lastError && (
                <p className="alert-error-sm break-words" role="alert">
                  {a.lastError}
                </p>
              )}
              {isStaffAdmin(g.session) && (
                <div className="flex flex-wrap gap-2">
                  <form action={setMailboxEnabled}>
                    <input type="hidden" name="id" value={a.id} />
                    <input type="hidden" name="enabled" value={String(!a.enabled)} />
                    <button type="submit" className="btn-secondary">
                      {a.enabled ? 'Pausieren' : 'Abruf aktivieren'}
                    </button>
                  </form>
                  {a.provider === 'MICROSOFT365' && (
                    <form action={connectMicrosoft}>
                      <input type="hidden" name="id" value={a.id} />
                      <button type="submit" className="btn-secondary">
                        Microsoft neu verbinden
                      </button>
                    </form>
                  )}
                </div>
              )}
            </section>
          ))}
        </div>
      </section>
      <section aria-labelledby="mailbox-messages-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="mailbox-messages-heading" className="text-base font-semibold text-primary">
            Nachrichten
          </h2>
          <span className="text-xs text-muted">Letzte 100 Nachrichten</span>
        </div>
        {data.messages.length === 0 && (
          <div className="card px-6 py-12 text-center">
            <Inbox className="mx-auto mb-3 h-10 w-10 text-disabled" aria-hidden="true" />
            <p className="text-sm font-medium text-primary">Noch keine Nachrichten</p>
            <p className="mt-1 text-sm text-muted">
              Abgerufene Nachrichten erscheinen hier zur Prüfung und Zuordnung.
            </p>
          </div>
        )}
        {data.messages.map((m) => (
          <details key={m.id} className="card group/message min-w-0 overflow-hidden">
            <summary className="flex cursor-pointer list-none items-start gap-3 p-5 sm:p-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
              <Mail className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-primary break-words">
                  {m.subject || '(ohne Betreff)'}
                </span>
                <span className="mt-1 block text-xs text-muted break-words">{m.mailbox.name}</span>
              </span>
              <span className="badge-gray shrink-0">{m.status}</span>
              <ChevronDown
                className="mt-0.5 h-4 w-4 shrink-0 text-muted transition-transform group-open/message:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <div className="space-y-4 border-t border-default p-5 sm:p-6">
              <p className="text-sm text-secondary break-words">
                Von: {m.sender} · An: {m.recipients}
              </p>
              <p className="alert-info-sm leading-relaxed">
                Unbestätigte Zuordnungsvorschläge aus Kontaktadressen:{' '}
                {suggestInboundClients(m.sender, m.recipients, data.clients)
                  .map((c) => c.name)
                  .join(', ') || 'keine eindeutigen Adressübereinstimmungen'}
                . Bitte den tatsächlichen Mandanten ausdrücklich auswählen.
              </p>
              <pre className="whitespace-pre-wrap break-words rounded-lg bg-surface-raised p-4 font-sans text-sm leading-relaxed text-secondary">
                {m.bodyText}
              </pre>
              {m.attachments.map((a) => (
                <div key={a.id} className="space-y-4 rounded-lg border border-default p-4">
                  <div className="flex items-start gap-3">
                    <Paperclip className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-primary break-words">{a.filename}</p>
                      <p className="mt-1 text-xs text-muted">
                        {a.sizeBytes} Bytes · {a.status}
                      </p>
                    </div>
                  </div>
                  {a.error && (
                    <p className="alert-error-sm break-words" role="alert">
                      {a.error}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {['CLEAN', 'IMPORTING', 'IMPORTED'].includes(a.status) && (
                      <a className="btn-secondary" href={'/api/staff/mailbox/attachments/' + a.id}>
                        <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                        Geprüften Anhang herunterladen
                      </a>
                    )}
                    {a.status === 'IMPORTED' && (
                      <Link
                        className="btn-secondary"
                        href={'/staff/clients/' + a.clientId + '/documents'}
                      >
                        <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
                        Archivdokument anzeigen
                      </Link>
                    )}
                  </div>
                  {a.status !== 'IMPORTED' && ['CLEAN', 'IMPORTING'].includes(a.status) && (
                    <form
                      action={importAttachment}
                      className="grid items-end gap-4 border-t border-default pt-4 md:grid-cols-2"
                    >
                      <input type="hidden" name="id" value={a.id} />
                      <div>
                        <label className="label" htmlFor={'mailbox-client-' + a.id}>
                          Mandant
                        </label>
                        <select
                          id={'mailbox-client-' + a.id}
                          className="input"
                          name="clientId"
                          required
                          defaultValue={a.clientId ?? ''}
                        >
                          <option value="">Auswählen</option>
                          {data.clients.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="label" htmlFor={'mailbox-type-' + a.id}>
                          Dokumenttyp
                        </label>
                        <select
                          id={'mailbox-type-' + a.id}
                          className="input"
                          name="documentTypeId"
                          required
                        >
                          <option value="">Auswählen</option>
                          {data.types.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="md:col-span-2">
                        <button type="submit" className="btn-primary">
                          Zuordnung bestätigen und ablegen
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              ))}
            </div>
          </details>
        ))}
      </section>
      {isStaffAdmin(g.session) && (
        <details className="card group/account overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center gap-3 p-5 sm:p-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
            <Plus className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
            <span className="flex-1 text-base font-semibold text-primary">Postfach hinzufügen</span>
            <ChevronDown
              className="h-4 w-4 shrink-0 text-muted transition-transform group-open/account:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="space-y-6 border-t border-default p-5 sm:p-6">
            <p className="alert-info leading-relaxed">
              Microsoft: eigene Entra-Web-App Ihrer Kanzlei, delegierter IMAP-Zugriff, Client-Secret
              und Redirect-URI /api/staff/mailbox/oauth. Für freigegebene Postfächer deren Adresse
              als Benutzername eintragen und sich mit einem berechtigten Benutzer anmelden. Startet
              pausiert; maximal 25 MB je Nachricht. Archive und verschlüsselte Dateien bleiben
              gesperrt.
            </p>
            <form action={saveMailbox} className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="label" htmlFor="mailbox-name">
                  Name
                </label>
                <input id="mailbox-name" className="input" name="name" required maxLength={100} />
              </div>
              <div>
                <label className="label" htmlFor="mailbox-provider">
                  Typ
                </label>
                <select id="mailbox-provider" className="input" name="provider">
                  <option value="IMAP">IMAP mit TLS</option>
                  <option value="MICROSOFT365">Microsoft 365</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="mailbox-host">
                  Server
                </label>
                <input
                  id="mailbox-host"
                  className="input"
                  name="host"
                  required
                  defaultValue="outlook.office365.com"
                />
              </div>
              <div>
                <label className="label" htmlFor="mailbox-port">
                  Port
                </label>
                <input
                  id="mailbox-port"
                  className="input"
                  type="number"
                  name="port"
                  defaultValue={993}
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="mailbox-username">
                  Postfachadresse
                </label>
                <input
                  id="mailbox-username"
                  className="input"
                  type="email"
                  name="username"
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="mailbox-folder">
                  Ordner
                </label>
                <input
                  id="mailbox-folder"
                  className="input"
                  name="folder"
                  defaultValue="INBOX"
                  required
                />
              </div>
              <div className="md:col-span-2">
                <label className="label" htmlFor="mailbox-secret">
                  Passwort / Entra Client-Secret
                </label>
                <input
                  id="mailbox-secret"
                  className="input"
                  type="password"
                  name="secret"
                  required
                  autoComplete="new-password"
                />
              </div>
              <div>
                <label className="label" htmlFor="mailbox-entra-tenant">
                  Entra Tenant-ID
                </label>
                <input id="mailbox-entra-tenant" className="input" name="entraTenantId" />
              </div>
              <div>
                <label className="label" htmlFor="mailbox-entra-app">
                  Entra App-ID
                </label>
                <input id="mailbox-entra-app" className="input" name="entraClientId" />
              </div>
              <div className="border-t border-default pt-4 md:col-span-2">
                <button type="submit" className="btn-primary">
                  Pausiert anlegen
                </button>
              </div>
            </form>
          </div>
        </details>
      )}
    </div>
  );
}
