import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, ClipboardList, CheckCircle2, Building2 } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { findPortalProfilesForContact } from '@/server/auth/portal-profiles';
import { switchPortalProfileAction } from '../../profile-actions';
import { withTenantContext } from '@taxtronik/db';
import { PortalResponseForm } from './response-form';
import { fmtDateShort, fmtDateTimeShort } from '@/lib/fmt';

const statusLabels: Record<string, string> = {
  OPEN: 'Offen',
  IN_PROGRESS: 'In Bearbeitung',
  RESPONDED: 'Beantwortet',
  CLOSED: 'Geschlossen',
  CANCELLED: 'Abgebrochen',
};

export default async function PortalRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');

  const { id } = await params;
  const { tenantId, contactId, clientId } = session.user;

  const reqRow = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    (tx) =>
      tx.request.findFirst({
        where: { id, clientId },
        include: {
          responses: {
            orderBy: { createdAt: 'asc' },
            include: { document: true },
          },
          formSubmission: {
            select: { id: true, name: true, status: true, submittedAt: true },
          },
        },
      }),
  );

  if (!reqRow) {
    // Häufigster 404-Grund bei Mehrfach-Mandaten: der E-Mail-Link gehört zu
    // einem anderen Mandantenprofil derselben Person. Statt hart 404 den
    // Profilwechsel mit Rücksprung auf diese Anforderung anbieten. Bewusst
    // ohne Cross-Client-Query (RLS bleibt unangetastet) — existiert die
    // Anforderung auch im anderen Profil nicht, greift dort der 404.
    const profiles = await findPortalProfilesForContact({ tenantId, contactId });
    const otherProfiles = profiles.filter((profile) => profile.clientId !== clientId);
    if (otherProfiles.length === 0) notFound();
    return (
      <div className="p-8 max-w-xl">
        <div className="card p-6 space-y-4">
          <h1 className="text-lg font-semibold text-primary">Anforderung nicht in diesem Profil</h1>
          <p className="text-sm text-secondary">
            Diese Anforderung gehört nicht zum aktuell geöffneten Mandantenprofil. Ihre
            E-Mail-Adresse ist mehreren Mandaten zugeordnet — bitte wechseln Sie das Profil, um die
            Anforderung zu öffnen.
          </p>
          <div className="space-y-2">
            {otherProfiles.map((profile) => (
              <form key={profile.contactId} action={switchPortalProfileAction}>
                <input type="hidden" name="contactId" value={profile.contactId} />
                <input type="hidden" name="returnTo" value={`/portal/requests/${id}`} />
                <button
                  type="submit"
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-default px-3 py-2 text-left text-sm transition-colors hover:bg-gray-100"
                >
                  <Building2 className="h-4 w-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-primary">
                      {profile.clientName}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      Als {profile.contactName} öffnen
                    </span>
                  </span>
                </button>
              </form>
            ))}
          </div>
          <Link href="/portal/dashboard" className="text-xs text-muted hover:underline">
            Zurück zum Dashboard
          </Link>
        </div>
      </div>
    );
  }

  const isOpen = reqRow.status !== 'CLOSED' && reqRow.status !== 'CANCELLED';

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/portal/requests" className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-primary">{reqRow.title}</h1>
            <span
              className={
                reqRow.status === 'CLOSED'
                  ? 'badge-gray'
                  : reqRow.status === 'RESPONDED'
                    ? 'badge-green'
                    : 'badge-yellow'
              }
            >
              {statusLabels[reqRow.status]}
            </span>
          </div>
          {reqRow.dueAt && (
            <p className="text-sm text-muted">fällig {fmtDateShort(reqRow.dueAt)}</p>
          )}
        </div>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wide mb-2">
          Was wird benötigt?
        </h2>
        <p className="text-sm text-primary whitespace-pre-wrap">{reqRow.description}</p>
      </div>

      {reqRow.formSubmission && (
        <div className="card p-6 mb-6 border-brand-200 bg-brand-50/30">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              {reqRow.formSubmission.submittedAt ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
              ) : (
                <ClipboardList className="h-5 w-5 text-brand-600 mt-0.5 shrink-0" />
              )}
              <div>
                <h2 className="text-sm font-medium text-primary">Formular zur Anforderung</h2>
                <p className="text-sm text-secondary mt-0.5">{reqRow.formSubmission.name}</p>
                {reqRow.formSubmission.submittedAt ? (
                  <p className="text-xs text-emerald-700 mt-1">
                    Abgesendet am {fmtDateTimeShort(reqRow.formSubmission.submittedAt)}
                  </p>
                ) : (
                  <p className="text-xs text-brand-700 mt-1">Bitte ausfüllen und absenden.</p>
                )}
              </div>
            </div>
            <Link
              href={`/portal/forms/${reqRow.formSubmission.id}`}
              className={
                reqRow.formSubmission.submittedAt ? 'btn-secondary text-sm' : 'btn-primary text-sm'
              }
            >
              {reqRow.formSubmission.submittedAt ? 'Ansehen' : 'Formular öffnen'}
            </Link>
          </div>
        </div>
      )}

      {reqRow.responses.length > 0 && (
        <div className="card overflow-hidden mb-6">
          <div className="px-6 py-4 border-b border-default">
            <h2 className="text-sm font-medium text-primary">Verlauf</h2>
          </div>
          <div className="divide-y divide-border-subtle">
            {reqRow.responses.map((r) => (
              <div key={r.id} className="px-6 py-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className={r.authorType === 'STAFF' ? 'badge-gray' : 'badge-green'}>
                    {r.authorType === 'STAFF' ? 'Kanzlei' : 'Sie'}
                  </span>
                  <span className="text-xs text-disabled">{fmtDateTimeShort(r.createdAt)}</span>
                </div>
                <p className="text-sm text-primary whitespace-pre-wrap">{r.message}</p>
                {r.document && (
                  <p className="mt-2 text-xs text-muted">
                    Beigefügtes Dokument: {r.document.title}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {isOpen ? (
        <div className="card p-6">
          <h2 className="text-sm font-medium text-primary mb-3">Antworten</h2>
          <PortalResponseForm requestId={reqRow.id} />
        </div>
      ) : (
        <div className="rounded-md bg-gray-50 p-4 text-sm text-secondary text-center">
          Diese Anforderung ist abgeschlossen.
        </div>
      )}
    </div>
  );
}
