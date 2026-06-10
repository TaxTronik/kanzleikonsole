import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileText, Lock, Shield } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { DocumentPreviewButton } from '@/components/document-preview';
import { AcknowledgeButton } from '../acknowledge-button';
import { NewVersionForm } from './new-version-form';
import { fmtDateShort, fmtDateTimeShort } from '@/lib/fmt';

const classificationLabels: Record<string, string> = {
  GOBD_INVOICE: 'GoBD Rechnung',
  GOBD_CONTRACT: 'GoBD Vertrag',
  GOBD_TAX: 'GoBD Steuer',
  GWG_EVIDENCE: 'GwG Nachweis',
  PERSONNEL: 'Personal',
  STAFF_PRIVATE: 'Intern',
  GENERAL: 'Allgemein',
};

export default async function DocumentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const doc = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.document.findUnique({
        where: { id },
        include: {
          versions: { orderBy: { versionNo: 'desc' } },
          client: { select: { id: true, name: true } },
        },
      }),
  );

  if (!doc) notFound();

  // iter85 (Inventur-Befund): Download/Preview prüfen die RESTRICTED-
  // Zuständigkeit — die Detailseite zeigte Metadaten (Titel, Versionen, SHA)
  // gesperrter Mandanten trotzdem. Gleiche 404-Semantik wie die Download-
  // Route (kein Existenz-Leak).
  if (doc.client) {
    const allowed = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      (tx) => canAccessClientTx(tx, session, doc.client!.id),
    );
    if (!allowed) notFound();
  }

  // Name des Bestätigers nachladen (optional; vermeidet zusätzlichen Join)
  let acknowledgedByName: string | null = null;
  if (doc.acknowledgedByStaff) {
    const ack = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      (tx) =>
        tx.staffUser.findUnique({
          where: { id: doc.acknowledgedByStaff! },
          select: { fullName: true },
        }),
    );
    acknowledgedByName = ack?.fullName ?? null;
  }

  const isGobd = doc.classification.startsWith('GOBD_') || doc.classification === 'GWG_EVIDENCE';

  const fmtBytes = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/staff/documents" className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1 flex-wrap">
            <h1 className="text-2xl font-bold text-primary truncate">{doc.title}</h1>
            {isGobd && (
              <span className="badge-yellow flex items-center gap-1">
                <Lock className="h-3 w-3" />
                GoBD-immutable
              </span>
            )}
            <AcknowledgeButton
              documentId={doc.id}
              acknowledgedAt={doc.acknowledgedAt ? doc.acknowledgedAt.toISOString() : null}
              acknowledgedByName={acknowledgedByName}
              size="md"
            />
          </div>
          <p className="text-muted text-sm">
            {classificationLabels[doc.classification] ?? doc.classification}
            {doc.client && (
              <>
                {' · '}
                <Link href={`/staff/clients/${doc.client.id}`} className="hover:underline">
                  {doc.client.name}
                </Link>
              </>
            )}
            {' · '}
            {doc.versions.length} Version{doc.versions.length === 1 ? '' : 'en'}
            {doc.retentionUntil && (
              <>
                {' · '}
                Aufbewahrung bis {fmtDateShort(doc.retentionUntil)}
              </>
            )}
          </p>
        </div>
      </div>

      {/* Versions-Historie */}
      <div className="card overflow-hidden mb-6">
        <div className="px-6 py-4 border-b border-default">
          <h2 className="text-sm font-medium text-primary">Versionen</h2>
        </div>
        <ul className="divide-y divide-border-subtle">
          {doc.versions.map((v, idx) => {
            const isLatest = idx === 0;
            return (
              <li key={v.id} className="px-6 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="h-4 w-4 text-disabled shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-primary">
                      v{v.versionNo}
                      {isLatest && <span className="ml-2 badge-green text-[10px]">aktuell</span>}
                      {v.scanStatus === 'INFECTED' && (
                        <span className="ml-2 badge-red text-[10px]">infiziert</span>
                      )}
                      {v.scanStatus === 'PENDING' && (
                        <span className="ml-2 badge-yellow text-[10px]">scannt…</span>
                      )}
                    </p>
                    <p className="text-xs text-muted">
                      {fmtDateTimeShort(v.createdAt)}
                      {' · '}
                      {fmtBytes(Number(v.sizeBytes))}
                      {' · '}
                      <span className="font-mono">
                        SHA-256: {Buffer.from(v.sha256).toString('hex').slice(0, 12)}…
                      </span>
                    </p>
                  </div>
                </div>
                {isLatest && (
                  <div className="flex items-center gap-1">
                    <DocumentPreviewButton documentId={doc.id} documentTitle={doc.title} />
                    <a
                      href={`/api/staff/documents/${doc.id}/download`}
                      className="text-xs text-brand-700 hover:underline px-2"
                    >
                      Download
                    </a>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Neue Version */}
      <div className="card p-6">
        <h2 className="text-sm font-medium text-primary mb-3">Neue Version hochladen</h2>
        <p className="text-xs text-muted mb-4">
          {isGobd ? (
            <>
              <Shield className="h-3 w-3 inline mr-1" />
              Bestehende Versionen bleiben unverändert (Object-Lock COMPLIANCE).
              Die neue Version wird zusätzlich als v{(doc.versions[0]?.versionNo ?? 0) + 1} gespeichert.
            </>
          ) : (
            <>
              Die neue Version wird als v{(doc.versions[0]?.versionNo ?? 0) + 1} gespeichert. Vorgängerversionen bleiben erhalten.
            </>
          )}
        </p>
        <NewVersionForm documentId={doc.id} />
      </div>
    </div>
  );
}
