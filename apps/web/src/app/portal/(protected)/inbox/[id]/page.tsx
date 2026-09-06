import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Download, FileWarning } from 'lucide-react';
import { withTenantContext } from '@taxtronik/db';
import { portalAuth } from '@/server/auth/portal';
import { readPortalFeatures } from '@/server/settings/portal-features';
import { getPortalInboxThreadTx } from '@/server/inbox/queries';
import { INBOX_TOPIC_LABELS } from '@/server/inbox/constants';
import { fmtBytes, fmtDateTimeShort } from '@/lib/fmt';
import { InboxComposer } from '../composer';
import { MarkInboxThreadRead } from '../mark-read';

const REJECTION_LABELS: Readonly<Record<string, string>> = {
  NOT_REQUIRED: 'Nicht zur Übernahme vorgesehen',
  DUPLICATE: 'Bereits vorhanden',
  UNSUPPORTED: 'Nicht als Kanzleidokument übernehmbar',
  OTHER: 'Nicht übernommen',
};

export default async function PortalInboxThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  const { tenantId, clientId, contactId } = session.user;
  const ctx = { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' as const };
  const features = await readPortalFeatures(ctx);
  if (!features.clientInbox) notFound();
  const { id } = await params;
  const thread = await withTenantContext(ctx, (tx) =>
    getPortalInboxThreadTx(tx, { tenantId, clientId, contactId }, id),
  );
  if (!thread) notFound();

  return (
    <main className="p-4 sm:p-8">
      <MarkInboxThreadRead threadId={thread.id} />
      <Link
        href="/portal/inbox"
        className="mb-5 inline-flex items-center gap-2 text-sm text-brand-700 hover:underline"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Zurück zu Nachrichten
      </Link>
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="break-words text-2xl font-bold text-primary">{thread.subject}</h1>
            {thread.status === 'RESOLVED' ? (
              <span className="badge-gray">Erledigt</span>
            ) : (
              <span className="badge-green">Offen</span>
            )}
            {thread.attention === 'CLIENT' && thread.status === 'OPEN' ? (
              <span className="badge-yellow">Antwort von Ihnen benötigt</span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted">{INBOX_TOPIC_LABELS[thread.topic]}</p>
        </header>

        <section aria-label="Nachrichten" className="space-y-4">
          {thread.messages.map((message) => (
            <article
              key={message.id}
              className={
                message.authorType === 'STAFF'
                  ? 'card border-l-4 border-l-brand-500 p-4 sm:p-5'
                  : 'card p-4 sm:p-5'
              }
            >
              <header className="mb-3 flex flex-wrap justify-between gap-2 text-xs text-muted">
                <strong className="text-secondary">{message.authorName}</strong>
                <time dateTime={message.createdAt.toISOString()}>
                  {fmtDateTimeShort(message.createdAt)}
                </time>
              </header>
              <p className="whitespace-pre-wrap break-words text-sm text-primary">{message.body}</p>
              {message.attachments.length ? (
                <ul className="mt-4 space-y-2" aria-label="Anlagen">
                  {message.attachments.map((attachment) => (
                    <li
                      key={attachment.id}
                      className="rounded-md border border-default p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 break-all">
                          {attachment.originalName} · {fmtBytes(Number(attachment.sizeBytes))}
                        </span>
                        {attachment.downloadHref ? (
                          <a
                            href={attachment.downloadHref}
                            className="inline-flex items-center gap-1 text-brand-700 hover:underline"
                          >
                            <Download className="h-4 w-4" aria-hidden="true" /> Herunterladen
                          </a>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-muted">
                            <FileWarning className="h-4 w-4" aria-hidden="true" />
                            {attachment.decision === 'REJECTED'
                              ? (REJECTION_LABELS[attachment.rejectionReason ?? ''] ??
                                'Nicht übernommen')
                              : 'Nicht herunterladbar'}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </section>

        {thread.status === 'OPEN' ? (
          <section className="card p-5 sm:p-6">
            <h2 className="mb-4 text-lg font-semibold text-primary">Antworten</h2>
            <InboxComposer
              mode={{ kind: 'reply', threadId: thread.id }}
              allowAttachments={features.documentUpload}
            />
          </section>
        ) : (
          <section className="card p-5 text-sm text-muted">
            Dieser Verlauf ist erledigt und schreibgeschützt. Für ein weiteres Anliegen beginnen Sie
            bitte eine neue Nachricht.{' '}
            <Link href="/portal/inbox/new" className="text-brand-700 hover:underline">
              Neuen Verlauf beginnen
            </Link>
          </section>
        )}
      </div>
    </main>
  );
}
