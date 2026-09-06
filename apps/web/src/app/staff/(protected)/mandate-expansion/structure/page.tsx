import { randomUUID } from 'node:crypto';
import { withTenantContext } from '@taxtronik/db';
import { requireStaffPage } from '@/server/auth/staff-page';
import { isUuid } from '@/lib/uuid';
import { loadStructureTx, visibleMandatesTx } from '@/server/mandate-expansion/service';
import { expansionPage, ExpansionNavigation, ClientSelect } from '../common';
import { ActionForm } from '../action-form';
import { archiveStructureAction } from '../actions';
import StructureEditor from './editor';
import { GwgStructurePanel } from '@/server/mandate-expansion/gwg-structure-panel';
export default async function StructurePage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string }>;
}) {
  await requireStaffPage();
  const { session, ctx } = await expansionPage('mandateStructure');
  const sp = await searchParams;
  const clientId = isUuid(sp.clientId ?? '') ? sp.clientId! : '';
  const clients = await withTenantContext(ctx, (tx) => visibleMandatesTx(tx, session));
  const client = clients.find((c) => c.id === clientId);
  let saved: Awaited<ReturnType<typeof loadStructureTx>> = null;
  let unavailable = false;
  if (client)
    try {
      saved = await withTenantContext(ctx, (tx) => loadStructureTx(tx, session, clientId));
    } catch {
      unavailable = true;
    }
  const artifacts = client
    ? await withTenantContext(ctx, (tx) =>
        tx.mandateArtifact.findMany({
          where: { clientId, kind: 'STRUCTURE' },
          include: { structureVersion: { select: { revision: true } } },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      )
    : [];
  return (
    <main className="p-6 space-y-5">
      <ExpansionNavigation />
      <h1 className="text-2xl font-semibold">Mandanten- und Beteiligungsstruktur</h1>
      <ClientSelect clients={clients} selected={clientId} />
      {unavailable ? (
        <p>
          Die vollständige Struktur ist mit Ihren aktuellen Zugriffsrechten nicht verfügbar.
          Verbindungen werden nicht teilweise offengelegt.
        </p>
      ) : (
        client && (
          <>
            {saved && (
              <section className="border rounded-lg p-4">
                <h2 className="font-semibold">Version {saved.revision}</h2>
                <p>
                  PDF mit Grafik, vollständiger Tabelle, Generator- und Quellenbindung ausdrücklich
                  ablegen. Derselbe Aufruf setzt eine unvollständige Ablage fort.
                </p>
                <ActionForm action={archiveStructureAction}>
                  <input type="hidden" name="clientId" value={clientId} />
                  <input type="hidden" name="versionId" value={saved.id} />
                  <button className="btn-secondary">PDF dieser Version ablegen / fortsetzen</button>
                </ActionForm>
              </section>
            )}
            <StructureEditor
              key={`${clientId}:${saved?.revision ?? 0}`}
              clients={clients}
              initial={
                saved?.input ?? {
                  clientId,
                  expectedRevision: 0,
                  note: '',
                  nodes: [
                    {
                      key: randomUUID(),
                      kind: 'CLIENT',
                      label: client.name,
                      linkedClientId: clientId,
                      x: 400,
                      y: 250,
                    },
                  ],
                  edges: [],
                }
              }
            />
          </>
        )
      )}
      {artifacts.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Abgelegte Fassungen mit aktuellem Zugriff</h2>
          {artifacts.map((a) => (
            <p key={a.id}>
              Version {a.structureVersion?.revision} · {a.generatorVersion} ·{' '}
              {a.status === 'READY' && a.documentVersionId ? (
                <a
                  className="underline"
                  href={`/api/staff/mandate-expansion/export?artifactId=${a.id}`}
                >
                  Gespeichertes PDF herunterladen
                </a>
              ) : a.status === 'READY' ? (
                'Datei nicht mehr verfügbar'
              ) : (
                a.status
              )}{' '}
              ·{' '}
              <span className="text-xs break-all">
                SHA-256 {a.outputHash ?? 'noch nicht abgelegt'}
              </span>
            </p>
          ))}
        </section>
      )}
      {client && !unavailable && <GwgStructurePanel session={session} clientId={clientId} />}
    </main>
  );
}
