import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { isUuid } from '@/lib/uuid';
import { visibleMandatesTx } from '@/server/mandate-expansion/service';
import {
  offboardingSourceTx,
  sensitiveHandoverDocument,
} from '@/server/mandate-expansion/offboarding';
import { handoverPreparationHash } from '@/server/mandate-expansion/artifacts';
import { expansionPage, ExpansionNavigation, ClientSelect } from '../common';
import { ActionForm } from '../action-form';
import {
  prepareOffboardingAction,
  finishOffboardingAction,
  archiveOffboardingAction,
} from '../actions';

export default async function OffboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string }>;
}) {
  await requireStaffPage({ admin: true });
  const { session, ctx } = await expansionPage('mandateOffboarding', true);
  const sp = await searchParams;
  const clientId = isUuid(sp.clientId ?? '') ? sp.clientId! : '';
  const clients = await withTenantContext(ctx, (tx) => visibleMandatesTx(tx, session));
  const client = clients.find((c) => c.id === clientId);
  const data = client
    ? await withTenantContext(ctx, async (tx) => ({
        source: await offboardingSourceTx(tx, session, clientId),
        runs: await tx.mandateOffboarding.findMany({
          where: { tenantId: session.user.tenantId, clientId },
          include: { documents: true, artifacts: { orderBy: { createdAt: 'desc' } } },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      }))
    : null;
  const draft = data?.runs.find((r) => !r.completedAt);
  return (
    <main className="p-6 space-y-6">
      <ExpansionNavigation />
      <h1 className="text-2xl font-semibold">Mandatsübergabe und Beendigung</h1>
      <p>
        Vorbereiten, abgelegte Ausgaben prüfen, dann gesondert beenden. Der Abschluss sperrt den
        Portalzugriff; offene Fristen bleiben bestehen. Kein automatischer Versand, keine Löschung
        und keine allgemeine Löschfreigabe.
      </p>
      <ClientSelect clients={clients} selected={clientId} />
      {data && (
        <>
          <section className="border rounded-lg p-5 space-y-3">
            <h2 className="font-semibold">Offene Vorgänge</h2>
            <ul className="list-disc pl-5">
              {data.source.snapshot.deadlines.map((d) => (
                <li key={d.id}>
                  Steuertermin {d.kind} {d.period}: {d.dueDate.slice(0, 10)} ({d.status})
                </li>
              ))}
              {data.source.snapshot.notices.map((n) => (
                <li key={n.id}>
                  Bescheid {n.kind} {n.period}: Einspruchskontrolle{' '}
                  {n.appealDeadline?.slice(0, 10) ?? 'Datum noch zu prüfen'} ({n.status})
                </li>
              ))}
              {data.source.snapshot.requests.map((r) => (
                <li key={r.id}>
                  Anforderung: {r.title} ({r.status})
                </li>
              ))}
            </ul>
            <p>
              {data.source.snapshot.gwgChecks.length} nicht vernichtete GwG-Prüfungen;{' '}
              {data.source.snapshot.contactIds.length} aktive Portal-Kontakte.
            </p>
            <p className="text-sm">
              Vorhandene Dokumentfristen bleiben erhalten. GwG-/DSGVO-Prüfungen verwenden das
              bestätigte Mandatsende. Individuelle Aufbewahrungsgründe bleiben zur fachlichen
              Prüfung offen.
            </p>
          </section>
          {!data.source.client.mandateEndedAt ? (
            <ActionForm
              key={draft?.sourceHash ?? data.source.hash}
              action={prepareOffboardingAction}
              className="border rounded-lg p-5 space-y-4"
            >
              <input type="hidden" name="clientId" value={clientId} />
              <input type="hidden" name="expectedHash" value={data.source.hash} />
              <h2 className="font-semibold">
                1. Empfänger und einzelne Dokumentfassungen freigeben
              </h2>
              <label className="label">
                Bestätigter Empfänger: Name und eindeutige Zustell-/Kontaktangabe
                <input
                  className="input"
                  name="recipient"
                  minLength={10}
                  maxLength={800}
                  defaultValue={draft?.recipient}
                  required
                />
              </label>
              <label className="label">
                Tatsächliches Mandatsende
                <input
                  className="input max-w-xs"
                  type="date"
                  name="endDate"
                  max={new Date().toISOString().slice(0, 10)}
                  defaultValue={
                    draft?.endDate.toISOString().slice(0, 10) ??
                    new Date().toISOString().slice(0, 10)
                  }
                  required
                />
              </label>
              <p className="text-sm">
                Die Auswahl ist eine eigene Herausgabefreigabe für den benannten Empfänger. Eine
                Portalfreigabe ersetzt diese Entscheidung nicht. Interne und geschützte Unterlagen
                erfordern je Fassung eine zusätzliche Bestätigung; Personalunterlagen außerdem
                PAYROLL_MANAGE. Nur saubere, verfügbare Fassungen sind auswählbar. Höchstens 200
                Dokumente, zusammen 100 MiB und je Fassung 24 MiB.
              </p>
              <div className="max-h-96 overflow-y-auto space-y-3">
                {data.source.snapshot.documents.length === 0 ? (
                  <p>Keine sauberen Dokumentfassungen mit den aktuellen Rechten verfügbar.</p>
                ) : (
                  data.source.snapshot.documents.map((d) => {
                    const approval = draft?.documents.find(
                      (v) => v.documentVersionId === d.versionId,
                    );
                    return (
                      <fieldset className="border rounded p-3 space-y-2" key={d.versionId}>
                        <legend className="px-1 text-sm font-medium">{d.title}</legend>
                        <p className="text-xs">
                          {d.classification}
                          {d.requiresPayrollAccess ? ' · Personalzugriff erforderlich' : ''} ·{' '}
                          {Math.ceil(Number(d.sizeBytes) / 1024)} KiB · bestehende Retention{' '}
                          {d.retentionUntil?.slice(0, 10) ?? 'keine Produktfrist'} · Fassung{' '}
                          {d.versionId}
                        </p>
                        <label className="flex gap-2">
                          <input
                            type="checkbox"
                            name="versionIds"
                            value={d.versionId}
                            defaultChecked={Boolean(approval)}
                          />
                          <span>Diese Fassung für den oben bestätigten Empfänger freigeben.</span>
                        </label>
                        {sensitiveHandoverDocument(d) && (
                          <label className="flex gap-2 text-sm">
                            <input
                              type="checkbox"
                              name="sensitiveVersionIds"
                              value={d.versionId}
                              defaultChecked={approval?.sensitiveApproved ?? false}
                            />
                            <span>
                              Zusätzliche Freigabe: Schutzbedarf und Herausgabe dieser
                              internen/sensiblen Fassung an diesen Empfänger ausdrücklich geprüft.
                            </span>
                          </label>
                        )}
                      </fieldset>
                    );
                  })
                )}
              </div>
              <label className="label">
                Übergabe offener Fristen / Nachfolgeberater / Verantwortlichkeit
                <textarea
                  className="input"
                  name="handoverNote"
                  minLength={10}
                  maxLength={6000}
                  required
                  defaultValue={draft?.handoverNote}
                />
              </label>
              <label className="label">
                Aufbewahrungsprüfung und offene individuelle Ausnahmen
                <textarea
                  className="input"
                  name="retentionNote"
                  minLength={10}
                  maxLength={6000}
                  required
                  defaultValue={draft?.retentionNote}
                />
              </label>
              <label className="flex gap-2">
                <input type="checkbox" name="confirmed" required />
                Empfänger, jede ausgewählte Fassung, offene Fristen und Aufbewahrungsgründe wurden
                geprüft; ungeklärte Ausnahmen sind im Vermerk festgehalten.
              </label>
              <button className="btn-primary">Freigaben und Prüfstand speichern</button>
            </ActionForm>
          ) : (
            <p className="border p-4">
              Mandat beendet seit {data.source.client.mandateEndedAt.toISOString().slice(0, 10)}.
              Eine Wiederaufnahme ist eine separate administrative Entscheidung.
            </p>
          )}
          <section className="space-y-4">
            <h2 className="font-semibold">2. Versionsgebundene Ausgaben archivieren und prüfen</h2>
            <p className="text-sm">
              Ein getrenntes PDF-Prüfprotokoll und ZIP-Teile je Schutzklasse werden über das
              Upload-Journal mit Generatorversion, Quellenhash und Ausgabefassung abgelegt.
              Personalteile bleiben zusätzlich geschützt; GwG-Kopien unterliegen dem bestehenden
              GwG-Vernichtungspfad. Downloads verändern keine Originale und beweisen keinen Versand.
            </p>
            {data.runs.length === 0 && <p>Noch kein freigegebener Prüfstand.</p>}
            {data.runs.map((run) => {
              const hash = handoverPreparationHash(run);
              const currentArtifacts = run.artifacts.filter((a) => a.sourceHash === hash);
              return (
                <article className="border rounded-lg p-5 space-y-3" key={run.id}>
                  <h3 className="font-semibold">
                    {run.createdAt.toISOString().slice(0, 10)} ·{' '}
                    {run.completedAt ? 'Abgeschlossen' : 'Vorbereitet'} · {run.documents.length}{' '}
                    freigegebene Fassungen
                  </h3>
                  <p>
                    Empfänger:{' '}
                    {run.recipient || 'Noch keine eigene Empfängerfreigabe – erneut vorbereiten.'}
                  </p>
                  <p className="text-xs break-all">Vorbereitungshash: {hash}</p>
                  <ActionForm action={archiveOffboardingAction}>
                    <input type="hidden" name="id" value={run.id} />
                    <input type="hidden" name="expectedHash" value={hash} />
                    <button className="btn-secondary">
                      {currentArtifacts.length
                        ? 'Archivierung prüfen / unvollständige Ablage fortsetzen'
                        : 'PDF-Protokoll und ZIP-Teile archivieren'}
                    </button>
                  </ActionForm>
                  <ul className="space-y-2">
                    {run.artifacts.map((artifact) => (
                      <li key={artifact.id} className="text-sm">
                        {artifact.groupKey} · {artifact.generatorVersion} ·{' '}
                        {artifact.sourceHash === hash
                          ? 'aktueller Freigabestand'
                          : 'früherer Freigabestand'}{' '}
                        ·{' '}
                        {artifact.status === 'READY' && artifact.documentVersionId ? (
                          <a
                            className="underline"
                            href={`/api/staff/mandate-expansion/export?artifactId=${artifact.id}`}
                          >
                            Abgelegte {artifact.groupKey === 'PROTOCOL' ? 'PDF' : 'ZIP'}-Fassung
                            herunterladen
                          </a>
                        ) : artifact.status === 'READY' ? (
                          'Frühere Datei nicht mehr verfügbar; keine Neuerzeugung'
                        ) : (
                          `${artifact.status} – Ablage noch unvollständig`
                        )}
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </section>
          {draft && !data.source.client.mandateEndedAt && (
            <section className="border rounded-lg p-5 space-y-4">
              <h2 className="font-semibold">3. Gesondert abschließen</h2>
              <ActionForm action={finishOffboardingAction}>
                <input type="hidden" name="id" value={draft.id} />
                <input type="hidden" name="expectedHash" value={handoverPreparationHash(draft)} />
                <label className="flex gap-2">
                  <input type="checkbox" name="confirmed" required />
                  Ich habe den gespeicherten Prüfstand und die abgelegten Übergabefassungen
                  abschließend geprüft und bestätige das Mandatsende sowie die sofortige Sperrung
                  aller Portalzugänge.
                </label>
                <button className="btn-primary">Mandat jetzt beenden und Portal sperren</button>
              </ActionForm>
            </section>
          )}
        </>
      )}
    </main>
  );
}
