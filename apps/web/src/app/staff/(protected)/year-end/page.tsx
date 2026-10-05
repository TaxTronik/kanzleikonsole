import Link from 'next/link';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { assertModuleEnabled } from '@/server/settings/modules';
import { ExpansionForm } from '@/components/expansion-form';
import { ClientMultiPicker } from '@/components/ui/client-multi-picker';
import { OffsetPagination } from '@/components/offset-pagination';
import {
  createCampaignAction,
  rolloutCampaignAction,
  returnCampaignSubmissionAction,
} from './actions';
import { campaignSubmissionPhase, formAnswerProgress } from '@/server/workflows/dashboard-policy';
import {
  CAMPAIGNS_PER_PAGE,
  ENTRIES_PER_PAGE,
  loadYearEndOverviewTx,
  type CampaignPhase,
} from '@/server/workflows/year-end-overview';
import { YEAR_END_ROLLOUT_MAX_CLIENTS } from '@/server/workflows/year-end-rollout';
import { fmtDateShort } from '@/lib/fmt';

const PHASE_LABELS: Record<CampaignPhase, string> = {
  PENDING: 'Noch nicht begonnen',
  IN_PROGRESS: 'In Bearbeitung',
  RETURNED: 'Rückfrage – erneute Abgabe offen',
  SUBMITTED: 'Eingereicht – Kanzleiprüfung offen',
  REVIEWED: 'Kanzleiprüfung abgeschlossen',
  CLOSED: 'Anforderung geschlossen',
  CANCELLED: 'Anforderung abgebrochen',
};

function pageNumber(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

interface SearchParams {
  page?: string;
  campaign?: string;
  entries?: string;
}

export default async function YearEndPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireStaffPage();
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  await assertModuleEnabled(ctx, 'yearEndCampaigns');
  await assertModuleEnabled(ctx, 'forms');
  const sp = await searchParams;
  // P-19: Kampagnen und Einträge seitenweise, Status per groupBy (Server-Modul).
  const data = await withTenantContext(ctx, (tx) =>
    loadYearEndOverviewTx(tx, session, {
      page: pageNumber(sp.page),
      campaignId: sp.campaign,
      entryPage: pageNumber(sp.entries),
    }),
  );
  const now = new Date();
  const pageQs = new URLSearchParams();
  if (data.page > 1) pageQs.set('page', String(data.page));
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
      {data.campaigns.map((c) => {
        const counts = data.phaseCounts.get(c.id)!;
        const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
        const entryQs = new URLSearchParams(pageQs);
        entryQs.set('campaign', c.id);
        return (
          <section className="card p-5" key={c.id}>
            <h2 className="text-lg font-semibold">
              {c.name} {c.year}
            </h2>
            <p>Zieltermin: {fmtDateShort(c.dueAt)}</p>
            <p className="text-sm">
              {total} zugängliche Mandanten
              {(Object.keys(PHASE_LABELS) as CampaignPhase[])
                .filter((phase) => counts[phase] > 0)
                .map((phase) => ` · ${PHASE_LABELS[phase]}: ${counts[phase]}`)
                .join('')}
            </p>
            <details className="my-3">
              <summary>Empfängerauswahl prüfen und ausrollen</summary>
              <ExpansionForm
                action={rolloutCampaignAction}
                label="Ausgewählten Mandanten im Portal bereitstellen"
              >
                <input type="hidden" name="campaignId" value={c.id} />
                <p>
                  Bereits zugeordnete Mandanten werden übersprungen. Bei einem Fehler wird der
                  gesamte Lauf zurückgerollt.
                </p>
                <label className="label" htmlFor={`year-end-rollout-${c.id}`}>
                  Empfänger
                </label>
                <ClientMultiPicker
                  id={`year-end-rollout-${c.id}`}
                  name="clientId"
                  filters={['active', 'notEnded']}
                  max={YEAR_END_ROLLOUT_MAX_CLIENTS}
                />
              </ExpansionForm>
            </details>
            <ul className="divide-y">
              {(data.entriesByCampaign.get(c.id) ?? []).map((e) => {
                const submission = data.submissions.get(e.submissionId);
                if (!submission) return null;
                const phase = campaignSubmissionPhase(
                  submission,
                  data.requestStatus.get(e.requestId),
                );
                const progress = formAnswerProgress(submission.schemaSnapshot, submission.answers);
                const label = PHASE_LABELS[phase];
                return (
                  <li key={e.id} className="py-3 space-y-2">
                    <div className="flex flex-wrap justify-between gap-3">
                      <Link
                        href={`/staff/forms/submissions/${e.submissionId}`}
                        className="underline"
                      >
                        {e.client.name}
                      </Link>
                      <span
                        className={
                          phase === 'REVIEWED'
                            ? 'text-emerald-700'
                            : phase === 'SUBMITTED'
                              ? 'text-blue-700'
                              : c.dueAt < now
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
                      c.dueAt < now && (
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
            {total > ENTRIES_PER_PAGE && (
              <OffsetPagination
                basePath="/staff/year-end"
                baseQs={entryQs}
                page={data.entryPages.get(c.id) ?? 1}
                pageSize={ENTRIES_PER_PAGE}
                totalCount={total}
                pageParam="entries"
              />
            )}
          </section>
        );
      })}
      {data.campaignCount > CAMPAIGNS_PER_PAGE && (
        <OffsetPagination
          basePath="/staff/year-end"
          baseQs={new URLSearchParams()}
          page={data.page}
          pageSize={CAMPAIGNS_PER_PAGE}
          totalCount={data.campaignCount}
        />
      )}
    </div>
  );
}
