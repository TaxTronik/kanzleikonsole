import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, ClipboardList, CheckCircle2 } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { findPortalProfilesForContact } from '@/server/auth/portal-profiles';
import { AutoProfileSwitch } from './auto-profile-switch';
import { withTenantContext } from '@taxtronik/db';
import { PortalResponseForm } from './response-form';
import { fmtDateShort, fmtDateTimeShort } from '@/lib/fmt';
import { isUuid } from '@/lib/uuid';

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
  if (!isUuid(id)) notFound();
  const { tenantId, contactId, clientId } = session.user;
  const managedInteraction = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) => {
      const [result] = await tx.$queryRaw<
        Array<{ managed: boolean }>
      >`SELECT app.interaction_request(${id}::uuid) AS managed`;
      return result?.managed ?? false;
    },
  );
  if (managedInteraction) redirect('/portal/interactions');

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
    // einem anderen Mandantenprofil derselben Person. Das besitzende Profil
    // wird über dessen EIGENEN Tenant-Kontext ermittelt (kein RLS-Bypass —
    // die Person ist ohnehin berechtigt, in dieses Profil zu wechseln) und
    // der Wechsel mit sichtbarem Warnhinweis automatisch angestoßen.
    const profiles = await findPortalProfilesForContact({
      tenantId,
      contactId,
      email: session.user.email,
    });
    const otherProfiles = profiles.filter((profile) => profile.clientId !== clientId);

    let owningProfile: (typeof otherProfiles)[number] | null = null;
    for (const profile of otherProfiles) {
      const owned = await withTenantContext(
        { tenantId, actorId: profile.contactId, actorType: 'CLIENT_CONTACT' },
        (tx) =>
          tx.request.findFirst({
            where: { id, clientId: profile.clientId },
            select: { id: true },
          }),
      );
      if (owned) {
        owningProfile = profile;
        break;
      }
    }
    if (!owningProfile) notFound();

    return (
      <div className="p-8">
        {/* Hinweis + Auto-Wechsel als Vollbild-Overlay (mobil lesbarer als
            eine Inline-Karte); darunter nur ein neutraler Platzhalter. */}
        <p className="text-sm text-muted">Anforderung wird geöffnet …</p>
        <AutoProfileSwitch
          contactId={owningProfile.contactId}
          clientName={owningProfile.clientName}
          contactName={owningProfile.contactName}
          returnTo={`/portal/requests/${id}`}
        />
      </div>
    );
  }

  const isOpen = reqRow.status === 'OPEN' || reqRow.status === 'IN_PROGRESS';

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
