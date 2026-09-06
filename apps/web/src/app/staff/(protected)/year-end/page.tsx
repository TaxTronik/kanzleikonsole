import Link from 'next/link';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { assertModuleEnabled } from '@/server/settings/modules';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import { ExpansionForm } from '@/components/expansion-form';
import {
  createCampaignAction,
  rolloutCampaignAction,
  returnCampaignSubmissionAction,
} from './actions';
import { campaignSubmissionPhase, formAnswerProgress } from '@/server/workflows/dashboard-policy';
import { fmtDateShort } from '@/lib/fmt';
export default async function YearEndPage() {
  const session = await requireStaffPage();
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  await assertModuleEnabled(ctx, 'yearEndCampaigns');
  await assertModuleEnabled(ctx, 'forms');
  const data = await withTenantContext(ctx, async (tx) => {
    const clients = await tx.client.findMany({
      where: {
        allowActive: true,
        mandateEndedAt: null,
        ...(await accessibleClientsWhereFor(tx, session)),
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const campaigns = await tx.yearEndCampaign.findMany({ orderBy: { createdAt: 'desc' } });
    const entries = await tx.yearEndCampaignEntry.findMany({
      where: { clientId: { in: clients.map((c) => c.id) } },
    });
    const submissions = await tx.formSubmission.findMany({
      where: { id: { in: entries.map((e) => e.submissionId) } },
      select: {
        id: true,
        status: true,
        submittedAt: true,
        reviewedAt: true,
        updatedAt: true,
        schemaSnapshot: true,
        answers: true,
      },
    });
    const requests = await tx.request.findMany({
      where: { id: { in: entries.map((e) => e.requestId) } },
      select: { id: true, status: true },
    });
    const templates = await tx.formTemplate.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return { clients, campaigns, entries, submissions, templates, requests };
  });
  return (
    <div className="p-8 max-w-6xl space-y-6">
      <h1 className="text-2xl font-bold">Jahreswechsel-Checklisten</h1>
      <p>
        Vorlage und Zieltermin werden je Kampagne eingefroren. Portaleinträge sind nach dem Rollout
        sofort verfügbar; es erfolgt kein gesonderter Massen-E-Mail-Versand. Die Übersicht enthält
        nur zugängliche Mandanten.
      </p>
      <section className="card p-5">
        <h2 className="text-lg font-semibold mb-3">Kampagne vorbereiten</h2>
        <ExpansionForm action={createCampaignAction} label="Vorlagenstand einfrieren">
          <label className="block">
            Name
            <input className="input" name="name" required maxLength={150} />
          </label>
          <label className="block">
            Jahr
            <input
              className="input"
              name="year"
              type="number"
              defaultValue={new Date().getFullYear()}
              required
            />
          </label>
          <label className="block">
            Formularvorlage
            <select className="input" name="templateId" required>
              <option value="">Bitte wählen</option>
              {data.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Interner Zieltermin
            <input className="input" name="due" type="date" required />
          </label>
        </ExpansionForm>
      </section>
      {data.campaigns.map((c) => (
        <section className="card p-5" key={c.id}>
          <h2 className="text-lg font-semibold">
            {c.name} {c.year}
          </h2>
          <p>Zieltermin: {fmtDateShort(c.dueAt)}</p>
          <details className="my-3">
            <summary>Empfängerauswahl prüfen und ausrollen</summary>
            <ExpansionForm
              action={rolloutCampaignAction}
              label="Ausgewählten Mandanten im Portal bereitstellen"
            >
              <input type="hidden" name="campaignId" value={c.id} />
              <p>
                Bereits zugeordnete Mandanten werden übersprungen. Bei einem Fehler wird der gesamte
                Lauf zurückgerollt.
              </p>
              <div className="max-h-60 overflow-auto">
                {data.clients.map((client) => (
                  <label className="flex gap-2 py-1" key={client.id}>
                    <input type="checkbox" name="clientId" value={client.id} />
                    {client.name}
                  </label>
                ))}
              </div>
            </ExpansionForm>
          </details>
          <ul className="divide-y">
            {data.entries
              .filter((e) => e.campaignId === c.id)
              .map((e) => {
                const submission = data.submissions.find((s) => s.id === e.submissionId);
                if (!submission) return null;
                const phase = campaignSubmissionPhase(
                  submission,
                  data.requests.find((r) => r.id === e.requestId)?.status,
                );
                const progress = formAnswerProgress(submission.schemaSnapshot, submission.answers);
                const label = {
                  PENDING: 'Noch nicht begonnen',
                  IN_PROGRESS: 'In Bearbeitung',
                  RETURNED: 'Rückfrage – erneute Abgabe offen',
                  SUBMITTED: 'Eingereicht – Kanzleiprüfung offen',
                  REVIEWED: 'Kanzleiprüfung abgeschlossen',
                  CLOSED: 'Anforderung geschlossen',
                  CANCELLED: 'Anforderung abgebrochen',
                }[phase];
                return (
                  <li key={e.id} className="py-3 space-y-2">
                    <div className="flex flex-wrap justify-between gap-3">
                      <Link
                        href={`/staff/forms/submissions/${e.submissionId}`}
                        className="underline"
                      >
                        {data.clients.find((client) => client.id === e.clientId)?.name}
                      </Link>
                      <span
                        className={
                          phase === 'REVIEWED'
                            ? 'text-emerald-700'
                            : phase === 'SUBMITTED'
                              ? 'text-blue-700'
                              : c.dueAt < new Date()
                                ? 'text-red-700'
                                : 'text-amber-700'
                        }
                      >
                        {label}
                      </span>
                    </div>
                    {progress ? (
                      <div className="text-sm space-y-1">
                        <p>
                          {progress.filled} / {progress.total} Eingabefelder beantwortet ·
                          Pflichtfelder {progress.requiredFilled} / {progress.requiredTotal}
                        </p>
                        {progress.percent !== null && (
                          <progress
                            aria-label="Technischer Bearbeitungsfortschritt"
                            max={100}
                            value={progress.percent}
                            className="w-full"
                          />
                        )}
                        <p className="text-muted">
                          Technische Eingabeprüfung; kein Nachweis inhaltlicher Vollständigkeit.
                        </p>
                      </div>
                    ) : (
                      <p className="text-sm text-muted">
                        Fortschritt mangels gültigem eingefrorenem Formularstand nicht berechenbar.
                      </p>
                    )}
                    {!['REVIEWED', 'SUBMITTED', 'CLOSED', 'CANCELLED'].includes(phase) &&
                      c.dueAt < new Date() && (
                        <p className="text-red-700 text-sm">Interner Zieltermin überschritten</p>
                      )}
                    {['SUBMITTED', 'REVIEWED'].includes(phase) && (
                      <details>
                        <summary>Mandant um Ergänzung bitten</summary>
                        <ExpansionForm
                          action={returnCampaignSubmissionAction}
                          label="Rückfrage veröffentlichen und Formular erneut freigeben"
                        >
                          <input type="hidden" name="entryId" value={e.id} />
                          <input
                            type="hidden"
                            name="updatedAt"
                            value={submission.updatedAt.toISOString()}
                          />
                          <label className="block">
                            Mandantensichtbare Rückfrage
                            <textarea
                              className="input block w-full"
                              name="note"
                              minLength={10}
                              maxLength={2000}
                              required
                            />
                          </label>
                          <p>
                            Die bestehende Anforderung wird ausdrücklich wieder geöffnet. Die
                            Fragenfassung bleibt unverändert; die Kanzleiprüfung wird zurückgesetzt.
                            Keine Änderung steuerlicher Fristen.
                          </p>
                        </ExpansionForm>
                      </details>
                    )}
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}
