import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Download, FileCheck2 } from 'lucide-react';
import { withTenantContext } from '@taxtronik/db';
import { staffActionGuard } from '@/server/actions/staff-action';
import { requireStaffPage } from '@/server/auth/staff-page';
import { getStaffInboxThreadTx } from '@/server/inbox/queries';
import { eligibleInboxStaffIdsTx } from '@/server/inbox/access';
import { INBOX_TOPIC_LABELS } from '@/server/inbox/constants';
import { fmtBytes, fmtDateTimeShort } from '@/lib/fmt';
import { InboxStaffControls } from '../controls';
import { InboxAttachmentReview } from '../attachment-review';

export default async function StaffInboxThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireStaffPage();
  const guard = await staffActionGuard({ requirePermission: 'PORTAL_INBOX_MANAGE' });
  if (!guard.ok)
    return (
      <p role="alert" className="alert-error-sm">
        {guard.error}
      </p>
    );
  const { id } = await params;
  const data = await withTenantContext(guard.ctx, async (tx) => {
    const thread = await getStaffInboxThreadTx(tx, guard.session, id);
    if (!thread) return null;
    const candidates = await tx.staffUser.findMany({
      where: {
        tenantId: guard.tenantId,
        active: true,
        OR: [
          { permissions: { some: { permission: 'PORTAL_INBOX_MANAGE' } } },
          { roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } } },
        ],
      },
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
    });
    const eligible = await eligibleInboxStaffIdsTx(
      tx,
      guard.tenantId,
      thread.clientId,
      candidates.map((entry) => entry.id),
    );
    const documentTypes = await tx.documentType.findMany({
      where: { tenantId: guard.tenantId, active: true },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return {
      thread,
      staff: candidates
        .filter((entry) => eligible.has(entry.id))
        .map((entry) => ({ id: entry.id, name: entry.fullName })),
      documentTypes,
    };
  });
  if (!data) notFound();
  const { thread } = data;

  return (
    <main className="space-y-6">
      <Link
        href="/staff/inbox"
        className="inline-flex items-center gap-2 text-sm text-brand-700 hover:underline"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Zurück zur Mandantenpost
      </Link>
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="break-words text-2xl font-semibold text-primary">{thread.subject}</h1>
          {thread.status === 'RESOLVED' ? (
            <span className="badge-gray">Erledigt</span>
          ) : (
            <span className="badge-green">Offen</span>
          )}
          {thread.attention === 'STAFF' && thread.status === 'OPEN' ? (
            <span className="badge-yellow">Kanzlei am Zug</span>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-muted">
          {thread.clientName} · {INBOX_TOPIC_LABELS[thread.topic]} · Erstellt von{' '}
          {thread.createdByContactName}
        </p>
      </header>

      <section className="card p-5">
        <InboxStaffControls
          threadId={thread.id}
          status={thread.status}
          assignedStaffId={thread.assignedStaffId}
          currentStaffId={guard.staffId}
          staff={data.staff}
        />
      </section>

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
              <ul className="mt-4 space-y-3" aria-label="Anlagen">
                {message.attachments.map((attachment) => (
                  <li key={attachment.id} className="rounded-md border border-default p-3 text-sm">
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
                      ) : null}
                    </div>
                    {attachment.decision === 'PENDING_REVIEW' ? (
                      <InboxAttachmentReview
                        attachmentId={attachment.id}
                        defaultTitle={attachment.originalName}
                        documentTypes={data.documentTypes}
                      />
                    ) : attachment.decision === 'ACCEPTED' && attachment.acceptedDocumentId ? (
                      <p className="mt-2 inline-flex items-center gap-2 text-success">
                        <FileCheck2 className="h-4 w-4" aria-hidden="true" /> Übernommen als{' '}
                        <Link
                          className="underline"
                          href={`/staff/documents/${attachment.acceptedDocumentId}`}
                        >
                          Kanzleidokument
                        </Link>
                      </p>
                    ) : (
                      <p className="mt-2 text-muted">
                        Abgelehnt: {attachment.rejectionReason ?? 'neutraler Grund'}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </article>
        ))}
      </section>
    </main>
  );
}
