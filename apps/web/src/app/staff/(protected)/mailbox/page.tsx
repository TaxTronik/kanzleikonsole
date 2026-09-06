import Link from 'next/link';
import { withTenantContext } from '@taxtronik/db';
import { staffActionGuard } from '@/server/actions/staff-action';
import { requireStaffPage } from '@/server/auth/staff-page';
import { accessibleClientsWhereFor, isStaffAdmin } from '@/server/auth/rbac';
import { connectMicrosoft, importAttachment, saveMailbox, setMailboxEnabled } from './actions';
import { suggestInboundClients } from '@/server/mailbox/suggestions';

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
  if (!g.ok) return <p>{g.error}</p>;
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
    types: await tx.documentType.findMany({
      where: {
        tenantId: g.tenantId,
        active: true,
        tier: { not: 'GWG' },
        NOT: { classificationKey: { in: ['STAFF_PRIVATE', 'PERSONNEL'] } },
      },
      select: { id: true, name: true },
      orderBy: { sortOrder: 'asc' },
    }),
  }));
  return (
    <main className="space-y-6">
      <h1 className="text-2xl font-semibold">Interner Posteingang</h1>
      <p>
        Absender und Empfänger sind unbestätigte Nachrichtenangaben. Erst Ihre Zuordnung erzeugt ein
        Archivdokument. Es erfolgt keine automatische Portalfreigabe. Nachrichten bleiben im
        Ursprungs-Postfach unverändert.
      </p>
      {query.connectionError && (
        <p role="alert">
          Microsoft-Verbindung fehlgeschlagen. Entra-Konfiguration, Einwilligung und IMAP-Freigabe
          prüfen. Sicherheitsrichtlinien nicht abschalten.
        </p>
      )}
      {query.connected && (
        <p role="status">Microsoft verbunden. Sie können den Abruf jetzt aktivieren.</p>
      )}
      {data.accounts.map((a) => (
        <section key={a.id} className="rounded border p-4">
          <h2>
            {a.name} · {a.username}
          </h2>
          <p>
            {a.enabled ? 'Aktiv' : 'Pausiert'} · Letzter erfolgreicher Abruf:{' '}
            {a.lastSuccessAt?.toLocaleString('de-DE') ?? 'noch keiner'}
          </p>
          {a.lastError && <p role="alert">{a.lastError}</p>}
          {isStaffAdmin(g.session) && (
            <div className="flex gap-4">
              <form action={setMailboxEnabled}>
                <input type="hidden" name="id" value={a.id} />
                <input type="hidden" name="enabled" value={String(!a.enabled)} />
                <button className="underline">
                  {a.enabled ? 'Pausieren' : 'Abruf aktivieren'}
                </button>
              </form>
              {a.provider === 'MICROSOFT365' && (
                <form action={connectMicrosoft}>
                  <input type="hidden" name="id" value={a.id} />
                  <button className="underline">Microsoft neu verbinden</button>
                </form>
              )}
            </div>
          )}
        </section>
      ))}
      <h2 className="text-xl">Nachrichten (letzte 100)</h2>
      {data.messages.map((m) => (
        <details key={m.id} className="rounded border p-4">
          <summary>
            {m.mailbox.name}: {m.subject || '(ohne Betreff)'} · {m.status}
          </summary>
          <p>
            Von: {m.sender} · An: {m.recipients}
          </p>
          <p className="text-sm">
            Unbestätigte Zuordnungsvorschläge aus Kontaktadressen:{' '}
            {suggestInboundClients(m.sender, m.recipients, data.clients)
              .map((c) => c.name)
              .join(', ') || 'keine eindeutigen Adressübereinstimmungen'}
            . Bitte den tatsächlichen Mandanten ausdrücklich auswählen.
          </p>
          <pre className="whitespace-pre-wrap break-words text-sm">{m.bodyText}</pre>
          {m.attachments.map((a) => (
            <div key={a.id} className="my-3 rounded border p-3">
              <p>
                {a.filename} · {a.sizeBytes} Bytes · {a.status}
              </p>
              {a.error && <p role="alert">{a.error}</p>}
              {['CLEAN', 'IMPORTING', 'IMPORTED'].includes(a.status) && (
                <a className="underline" href={'/api/staff/mailbox/attachments/' + a.id}>
                  Geprüften Anhang herunterladen
                </a>
              )}
              {a.status === 'IMPORTED' ? (
                <Link href={'/staff/clients/' + a.clientId + '/documents'}>
                  Archivdokument anzeigen
                </Link>
              ) : (
                ['CLEAN', 'IMPORTING'].includes(a.status) && (
                  <form action={importAttachment} className="flex flex-wrap gap-3">
                    <input type="hidden" name="id" value={a.id} />
                    <label>
                      Mandant{' '}
                      <select name="clientId" required defaultValue={a.clientId ?? ''}>
                        <option value="">Auswählen</option>
                        {data.clients.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Dokumenttyp{' '}
                      <select name="documentTypeId" required>
                        <option value="">Auswählen</option>
                        {data.types.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button className="rounded border px-3">
                      Zuordnung bestätigen und ablegen
                    </button>
                  </form>
                )
              )}
            </div>
          ))}
        </details>
      ))}
      {isStaffAdmin(g.session) && (
        <details className="rounded border p-4">
          <summary>Postfach hinzufügen</summary>
          <p>
            Microsoft: eigene Entra-Web-App Ihrer Kanzlei, delegierter IMAP-Zugriff, Client-Secret
            und Redirect-URI /api/staff/mailbox/oauth. Für freigegebene Postfächer deren Adresse als
            Benutzername eintragen und sich mit einem berechtigten Benutzer anmelden. Startet
            pausiert; maximal 25 MB je Nachricht. Archive und verschlüsselte Dateien bleiben
            gesperrt.
          </p>
          <form action={saveMailbox} className="grid gap-3 max-w-xl">
            <label>
              Name <input name="name" required maxLength={100} />
            </label>
            <label>
              Typ{' '}
              <select name="provider">
                <option value="IMAP">IMAP mit TLS</option>
                <option value="MICROSOFT365">Microsoft 365</option>
              </select>
            </label>
            <label>
              Server <input name="host" required defaultValue="outlook.office365.com" />
            </label>
            <label>
              Port <input type="number" name="port" defaultValue={993} required />
            </label>
            <label>
              Postfachadresse <input type="email" name="username" required />
            </label>
            <label>
              Ordner <input name="folder" defaultValue="INBOX" required />
            </label>
            <label>
              Passwort / Entra Client-Secret{' '}
              <input type="password" name="secret" required autoComplete="new-password" />
            </label>
            <label>
              Entra Tenant-ID <input name="entraTenantId" />
            </label>
            <label>
              Entra App-ID <input name="entraClientId" />
            </label>
            <button className="rounded border p-2">Pausiert anlegen</button>
          </form>
        </details>
      )}
    </main>
  );
}
