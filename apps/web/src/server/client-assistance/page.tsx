import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { withTenantContext } from '@taxtronik/db';
import { staffActionGuard } from '@/server/actions/staff-action';
import { portalActionGuard } from '@/server/actions/portal-action';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import { readModules } from '@/server/settings/modules';
import { ClientAssistanceForm } from '@/components/client-assistance-form';
import { ExpansionForm } from '@/components/expansion-form';
import { CASE_DEFINITIONS, CASE_KINDS, caseModule, type CaseKind } from './definitions';
import { withAssistance, assistanceDocumentWhere, type Surface } from './service';
import { checkedAssistanceSnapshot, DOCX_MIME } from './snapshot';

type FormAction = (data: FormData) => Promise<{ ok: boolean; error?: string }>;

function selectedCaseKind(kinds: CaseKind[], requested: string | undefined): CaseKind {
  return kinds.includes(requested as CaseKind) ? (requested as CaseKind) : kinds[0]!;
}

function assistanceClientId(
  guard: { clientId: string } | { staffId: string },
  requested: string | undefined,
): string | undefined {
  return 'clientId' in guard ? guard.clientId : requested;
}

function selectedAssistanceCase<T extends { id: string }>(
  items: T[],
  requested: string | undefined,
): T | undefined {
  return requested ? items.find((item) => item.id === requested) : undefined;
}

export async function AssistancePage({
  surface,
  search,
  saveAction,
  reviewAction,
  archiveAction,
  reimportAction,
}: {
  surface: Surface;
  search: Record<string, string | undefined>;
  saveAction: (
    state: { ok: boolean; error?: string; id?: string } | null,
    data: FormData,
  ) => Promise<{ ok: boolean; error?: string; id?: string }>;
  reviewAction?: FormAction;
  archiveAction: FormAction;
  reimportAction: FormAction;
}) {
  const guard = surface === 'staff' ? await staffActionGuard() : await portalActionGuard();
  if (!guard.ok) redirect('/' + surface + '/login');
  const modules = await readModules(guard.ctx);
  const kinds = CASE_KINDS.filter((kind) => modules[caseModule(kind)]);
  if (!kinds.length) notFound();
  const kind = selectedCaseKind(kinds, search.kind);
  const clientId = assistanceClientId(guard, search.clientId);
  const prefix = '/' + surface + '/client-assistance';
  if (!clientId) {
    if (!('staffId' in guard)) notFound();
    const clients = await withTenantContext(guard.ctx, async (tx) =>
      tx.client.findMany({
        where: {
          ...(await accessibleClientsWhereFor(tx, guard.session)),
          tenantId: guard.tenantId,
          allowActive: true,
          anonymizedAt: null,
          mandateEndedAt: null,
        },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 500,
      }),
    );
    return (
      <main className="p-8 space-y-4">
        <h1 className="text-2xl font-bold">Mandanten-Assistenten</h1>
        <p>Mandant für Belegassistenten und Verfahrensdokumentation wählen.</p>
        <ul>
          {clients.map((c) => (
            <li key={c.id}>
              <Link className="text-accent underline" href={prefix + '?clientId=' + c.id}>
                {c.name}
              </Link>
            </li>
          ))}
        </ul>
      </main>
    );
  }
  const items = await withAssistance(surface, kind, clientId, (tx) =>
    tx.clientAssistanceCase.findMany({
      where: { clientId, kind },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    }),
  );
  const selected = selectedAssistanceCase(items, search.id);
  if (search.id && !selected) notFound();
  const versions = await withAssistance(surface, kind, clientId, (tx) =>
    tx.documentVersion.findMany({
      where: {
        scanStatus: 'CLEAN',
        scanCompletedAt: { not: null },
        document: assistanceDocumentWhere(surface, guard.ctx.tenantId, clientId),
      },
      select: { id: true, versionNo: true, document: { select: { title: true, mimeType: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  );
  const history = selected
    ? await withAssistance(surface, kind, clientId, (tx) =>
        tx.clientAssistanceRevision.findMany({
          where: { caseId: selected.id },
          include: {
            outputs: {
              include: {
                documentVersion: {
                  include: { document: { select: { sharedWithClientAt: true } } },
                },
              },
            },
          },
          orderBy: { revision: 'desc' },
          take: 100,
        }),
      )
    : [];
  const sourceOptions = versions.map((v) => ({
    id: v.id,
    title: v.document.title + ' · Version ' + v.versionNo,
  }));
  const wordOptions = versions.filter((v) => v.document.mimeType === DOCX_MIME);
  const href = (revision: number, format: string, outputId?: string) =>
    '/api/' +
    surface +
    '/client-assistance/' +
    selected!.id +
    '?clientId=' +
    clientId +
    '&kind=' +
    kind +
    '&revision=' +
    revision +
    '&format=' +
    format +
    (outputId ? '&outputId=' + outputId : '');
  const identity = (revision: number) => (
    <>
      <input type="hidden" name="id" value={selected!.id} />
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="revision" value={revision} />
    </>
  );
  return (
    <main className="p-6 max-w-6xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Mandanten-Assistenten</h1>
      <nav className="flex flex-wrap gap-3">
        {kinds.map((k) => (
          <Link
            key={k}
            href={prefix + '?clientId=' + clientId + '&kind=' + k}
            className="btn-secondary"
          >
            {CASE_DEFINITIONS[k].title}
          </Link>
        ))}
      </nav>
      <div className="grid gap-8 md:grid-cols-[1fr_2fr]">
        <aside>
          <h2 className="font-semibold">Vorgänge (neueste 100)</h2>
          <Link href={prefix + '?clientId=' + clientId + '&kind=' + kind}>Neuer Vorgang</Link>
          <ul className="space-y-3 mt-3">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  className="underline"
                  href={prefix + '?clientId=' + clientId + '&kind=' + kind + '&id=' + item.id}
                >
                  {item.title} · {item.status} · V{item.revision}
                </Link>
              </li>
            ))}
          </ul>
        </aside>
        <section className="space-y-6">
          {selected?.externalDocumentVersionId ? (
            <section className="rounded-lg border p-4 space-y-3">
              <h2 className="text-lg font-semibold">
                Externe Word-Fassung · V{selected.revision} · {selected.status}
              </h2>
              <p>
                Die vollständige Word-Datei ist diese Fassung. Frühere Strukturantworten werden
                nicht als aktualisierte Word-Inhalte dargestellt. Änderungen erfolgen durch erneuten
                Word-Reimport.
              </p>
              <a className="btn-secondary" href={href(selected.revision, 'external')}>
                Gebundene Word-Datei zur Prüfung herunterladen
              </a>
            </section>
          ) : (
            <ClientAssistanceForm
              key={selected ? selected.id + ':' + selected.revision : kind}
              clientId={clientId}
              kind={kind}
              action={saveAction}
              sourceOptions={sourceOptions}
              item={
                selected
                  ? {
                      ...selected,
                      answers: selected.answers as Record<string, string>,
                      schemaSnapshot: selected.schemaSnapshot as {
                        fields: Array<{
                          key: string;
                          label: string;
                          type?: string;
                          required?: boolean;
                        }>;
                      },
                    }
                  : undefined
              }
            />
          )}
          {selected && (
            <>
              {selected.reviewNote && (
                <p className="border-l-4 pl-4 whitespace-pre-wrap">
                  Prüfvermerk: {selected.reviewNote}
                </p>
              )}
              {reviewAction && ['SUBMITTED', 'REVIEWED'].includes(selected.status) && (
                <section className="border rounded-lg p-4">
                  <h2 className="font-semibold mb-3">Prüfung dieser Fassung</h2>
                  <ExpansionForm action={reviewAction} label="Prüfentscheidung protokollieren">
                    {identity(selected.revision)}
                    <label className="block">
                      Entscheidung
                      <select className="input w-full" name="decision">
                        {selected.status === 'SUBMITTED' && (
                          <option value="REVIEWED">Fassung geprüft</option>
                        )}
                        <option value="RETURNED">Korrektur anfordern</option>
                      </select>
                    </label>
                    <label className="block">
                      Prüfvermerk
                      <textarea
                        className="input w-full"
                        name="note"
                        minLength={1}
                        maxLength={5000}
                        required
                      />
                    </label>
                    <label className="flex gap-2">
                      <input type="checkbox" name="confirmed" required />
                      Ich habe die konkrete Fassung einschließlich gebundener Unterlagen geprüft;
                      offene Punkte sind im Vermerk benannt.
                    </label>
                  </ExpansionForm>
                </section>
              )}
              {kind === 'PROCEDURE' && (
                <section className="border rounded-lg p-4 space-y-3">
                  <h2 className="font-semibold">Extern bearbeitete Word-Datei als neue Fassung</h2>
                  <p className="text-sm">
                    Bearbeitete DOCX zuerst im Bereich Dokumente hochladen. Die unveränderte
                    Originaldatei bleibt erhalten. Der Reimport fordert erneut eine menschliche
                    Prüfung an.
                  </p>
                  <ExpansionForm action={reimportAction} label="Neue Word-Fassung einreichen">
                    {identity(selected.revision)}
                    <label className="block">
                      Geprüfte Word-Datei
                      <select
                        name="documentVersionId"
                        required
                        className="input w-full"
                        defaultValue=""
                      >
                        <option value="">Dateifassung auswählen</option>
                        {wordOptions.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.document.title} · Version {v.versionNo}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex gap-2">
                      <input type="checkbox" name="confirmed" required />
                      Diese Datei enthält die neue Fassung; frühere Prüfentscheidungen werden nicht
                      übernommen.
                    </label>
                  </ExpansionForm>
                </section>
              )}
              <h2 className="text-lg font-semibold">
                Fassungen, Prüfverlauf und abgelegte Ausgaben (neueste 100)
              </h2>
              <p className="text-sm">
                Ausgaben werden aus einem festen Snapshot geschützt abgelegt. Technische
                Produktklasse:{' '}
                {kind === 'PROCEDURE' ? 'Steuerunterlage / 10 Jahre' : 'Buchungsbeleg / 8 Jahre'} ab
                dem Jahr der Fassung. Fachliche Einordnung, Fristbeginn und längere
                Aufbewahrungsgründe bleiben gesondert zu prüfen. Ein Entwurf oder Prüfvermerk ist
                keine automatische steuerliche Anerkennung.
              </p>
              {history.map((row) => {
                let snapshot;
                try {
                  snapshot = checkedAssistanceSnapshot(row.snapshot, row.snapshotHash);
                } catch {
                  return (
                    <p key={row.id}>
                      Fassung {row.revision}: kein vollständiger Ausgabesnapshot vorhanden.
                    </p>
                  );
                }
                return (
                  <details
                    key={row.id}
                    open={row.revision === selected.revision}
                    className="border rounded-lg p-4 space-y-3"
                  >
                    <summary className="font-semibold">
                      V{row.revision} · {row.status} · {row.occurredAt.toISOString().slice(0, 10)} ·{' '}
                      {row.actorType === 'STAFF' ? 'Kanzlei' : 'Portal'}
                    </summary>
                    <p className="text-xs break-all">Snapshot SHA-256: {row.snapshotHash}</p>
                    {snapshot.reviewNote && (
                      <p className="whitespace-pre-wrap">Prüfvermerk: {snapshot.reviewNote}</p>
                    )}
                    <div className="flex flex-wrap gap-3">
                      {snapshot.sourceVersionId && (
                        <a className="underline" href={href(row.revision, 'original')}>
                          Originalbeleg dieser Fassung
                        </a>
                      )}
                      {snapshot.externalVersionId && (
                        <a className="underline" href={href(row.revision, 'external')}>
                          Word-Original dieser Fassung
                        </a>
                      )}
                    </div>
                    {!snapshot.externalVersionId && (
                      <dl className="text-sm space-y-2">
                        {snapshot.schema.fields.map((f) => (
                          <div key={f.key}>
                            <dt className="font-medium">{f.label}</dt>
                            <dd className="whitespace-pre-wrap">
                              {snapshot.answers[f.key] || 'Offen / nicht angegeben'}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    <ul className="space-y-2">
                      {row.outputs
                        .filter(
                          (o) =>
                            surface === 'staff' ||
                            o.createdBy === guard.ctx.actorId ||
                            o.documentVersion?.document.sharedWithClientAt,
                        )
                        .map((o) => (
                          <li key={o.id}>
                            {o.format === 'merged'
                              ? 'Kombinierte PDF-Ansicht'
                              : o.format === 'pdf' && snapshot.externalVersionId
                                ? 'Prüfprotokoll PDF'
                                : o.format.toUpperCase()}{' '}
                            · {o.status} · {o.generatorVersion}
                            {o.status === 'READY' ? (
                              <>
                                {' '}
                                ·{' '}
                                <a className="underline" href={href(row.revision, o.format, o.id)}>
                                  Datei herunterladen
                                </a>{' '}
                                ·{' '}
                                <a
                                  className="underline"
                                  href={href(row.revision, 'manifest', o.id)}
                                >
                                  Manifest / Hashes
                                </a>
                                {surface === 'staff' &&
                                  !o.documentVersion?.document.sharedWithClientAt && (
                                    <span> · noch nicht im Portal freigegeben</span>
                                  )}
                              </>
                            ) : (
                              <span> · mit derselben Formatwahl unten fortsetzen</span>
                            )}
                          </li>
                        ))}
                    </ul>
                    <ExpansionForm action={archiveAction} label="Ausgabe ablegen / fortsetzen">
                      {identity(row.revision)}
                      <label className="block">
                        Format
                        <select className="input w-full" name="format">
                          <option value="pdf">
                            {snapshot.externalVersionId
                              ? 'Prüfprotokoll PDF (keine Word-Konvertierung)'
                              : 'PDF'}
                          </option>
                          {kind === 'PROCEDURE' && (
                            <option value="docx">
                              {snapshot.externalVersionId
                                ? 'Exakte externe Word-Fassung archivieren'
                                : 'Bearbeitbares Word-Dokument'}
                            </option>
                          )}
                          {kind === 'BEWIRTUNG' && snapshot.sourceVersionId && (
                            <option value="merged">
                              Original und Ergänzung als kombinierte PDF-Ansicht
                            </option>
                          )}
                        </select>
                      </label>
                      {surface === 'staff' && (
                        <label className="flex gap-2">
                          <input type="checkbox" name="shareWithClient" />
                          Diese Ausgabe ausdrücklich für den Mandanten im Portal freigeben
                        </label>
                      )}
                    </ExpansionForm>
                  </details>
                );
              })}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
