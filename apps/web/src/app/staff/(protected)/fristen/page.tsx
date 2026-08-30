// =============================================================================
// /staff/fristen — Fristenkontrollbuch
//
// Vereinheitlichte Kontrollsicht über alle fristenführenden Quellen
// (Steuertermine, Bescheidprüffälle/Einspruchsfristen, Klagefristen, Anforderungen,
// Wiedervorlagen) mit Verantwortlichen und abgeleitetem Kontrollzustand.
// Haftungsrelevanz: offene Fristen verschwinden NIE durch Zeitablauf. Der
// auditierte CSV-Export ist ein Kontrollauszug, aber kein Nachweis der
// fristwahrenden Handlung. Erledigt wird im jeweiligen Quellmodul — dieses
// Buch hält bewusst keinen eigenen Zustand.
// =============================================================================

import Link from 'next/link';
import { AlarmClock, CheckCircle2, FileDown, ExternalLink, ShieldAlert } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { loadKontrollbuch } from '@/server/fristen/kontrollbuch';
import {
  loadDailyReviewSummary,
  loadOpenDueForDailyReview,
  prepareDailyReview,
  type DailyReviewSummary,
  type PreparedDailyReview,
} from '@/server/fristen/tagesabschluss';
import {
  bucketFor,
  BUCKET_LABELS,
  QUELLE_LABELS,
  type FristBucket,
  type FristEintrag,
} from '@/server/fristen/eintrag';
import { fmtDateShort, fmtDateTimeMedium, berlinTodayUtcMidnight } from '@/lib/fmt';
import { readModules } from '@/server/settings/modules';
import { isStaffAdmin } from '@/server/auth/rbac';
import { DailyReviewForm } from './daily-review-form';

const RANGES = [7, 30, 90] as const;

interface Search {
  tage?: string;
  filter?: string; // 'offen' (default) | 'alle'
  wer?: string; // 'alle' (default) | 'meine'
}

export default async function FristenPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireStaffPage();
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const modules = await readModules(ctx);
  const canCompleteDailyReview = isStaffAdmin(session);

  const sp = await searchParams;
  const tage = (RANGES as readonly number[]).includes(Number(sp.tage)) ? Number(sp.tage) : 30;
  const nurOffene = sp.filter !== 'alle';
  const nurMeine = sp.wer === 'meine';

  const { eintraege, dailyReview, dailyPreview } = await withTenantContext(
    ctx,
    async (tx) => {
      const entries = await loadKontrollbuch(tx, session, {
        tage,
        nurOffene,
        nurStaffId: nurMeine ? staffId : null,
        sources: { taxNotices: modules.taxNotices, reminders: modules.reminders },
      });
      const review = await loadDailyReviewSummary(tx, tenantId);
      const preview =
        !review && canCompleteDailyReview
          ? prepareDailyReview(await loadOpenDueForDailyReview(tx, session))
          : null;
      return { eintraege: entries, dailyReview: review, dailyPreview: preview };
    },
    // TAX-CONTROL-STATUS-001: Late-ID-Vorabqueries und Hauptabfragen müssen
    // denselben Datenstand sehen. Ein paralleler Commit darf eine verspätete
    // Einlegung nicht zwischen beiden Reads scheinbar fristgerecht machen.
    { isolationLevel: 'RepeatableRead' },
  );
  const sourceLabels = [
    ...(modules.taxNotices
      ? ['Steuertermine', 'Bescheidprüffälle / Einspruchsfristen', 'Klagefristen']
      : []),
    'Anforderungen',
    ...(modules.reminders ? ['Wiedervorlagen'] : []),
  ];

  // bucketFor arbeitet in UTC-Tagesgrenzen (passend zu @db.Date = UTC-Mitternacht).
  // „Heute" muss daher der Berlin-Kalendertag als UTC-Mitternacht sein — sonst
  // landet eine Frist zwischen 00:00–02:00 Berlin im falschen Bucket.
  const heute = berlinTodayUtcMidnight();

  // Offene nach Dringlichkeit gruppieren; Erledigte (falls eingeblendet) separat.
  const gruppen = new Map<FristBucket, FristEintrag[]>();
  const erledigte: FristEintrag[] = [];
  for (const e of eintraege) {
    if (e.erledigt) {
      erledigte.push(e);
      continue;
    }
    const b = bucketFor(e.faelligAm, heute);
    if (!gruppen.has(b)) gruppen.set(b, []);
    gruppen.get(b)!.push(e);
  }
  const offeneCount = eintraege.length - erledigte.length;
  const ueberfaellig = gruppen.get('UEBERFAELLIG')?.length ?? 0;

  const qs = (over: Partial<Record<string, string>>) => {
    const p = new URLSearchParams();
    p.set('tage', String(tage));
    p.set('filter', nurOffene ? 'offen' : 'alle');
    p.set('wer', nurMeine ? 'meine' : 'alle');
    for (const [k, v] of Object.entries(over)) if (v !== undefined) p.set(k, v);
    return `/staff/fristen?${p.toString()}`;
  };

  const bucketOrder: FristBucket[] = ['UEBERFAELLIG', 'HEUTE', 'DIESE_WOCHE', 'SPAETER'];

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="page-title">
            <AlarmClock className="h-6 w-6 text-brand-600" />
            Fristenkontrollbuch
          </h1>
          <p className="text-muted text-sm">
            {sourceLabels.join(', ')} — {offeneCount} offen
            {ueberfaellig > 0 && (
              <span className="text-red-700 font-medium">, davon {ueberfaellig} überfällig</span>
            )}
            . Erledigt wird im jeweiligen Modul.
          </p>
        </div>
        <a
          href={`/api/staff/fristen/export?tage=${tage}${nurMeine ? '&wer=meine' : ''}`}
          className="btn-secondary"
          title="Fristenbuch als CSV-Kontrollauszug (wird im Prüfprotokoll vermerkt; kein Erledigungsnachweis)"
        >
          <FileDown className="h-3.5 w-3.5" />
          CSV-Auszug
        </a>
      </div>

      <DailyReviewCard
        review={dailyReview}
        preview={dailyPreview}
        canComplete={canCompleteDailyReview}
      />

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="toggle-group">
          {RANGES.map((t) => (
            <Link
              key={t}
              href={qs({ tage: String(t) })}
              className={
                t === tage
                  ? 'px-3 py-1.5 bg-brand-600 text-on-brand'
                  : 'px-3 py-1.5 text-secondary hover:bg-gray-50'
              }
            >
              {t} Tage
            </Link>
          ))}
        </div>
        <div className="toggle-group">
          <Link
            href={qs({ filter: 'offen' })}
            className={
              nurOffene
                ? 'px-3 py-1.5 bg-brand-600 text-on-brand'
                : 'px-3 py-1.5 text-secondary hover:bg-gray-50'
            }
          >
            Offen
          </Link>
          <Link
            href={qs({ filter: 'alle' })}
            className={
              !nurOffene
                ? 'px-3 py-1.5 bg-brand-600 text-on-brand'
                : 'px-3 py-1.5 text-secondary hover:bg-gray-50'
            }
          >
            Mit Erledigten
          </Link>
        </div>
        <div className="toggle-group">
          <Link
            href={qs({ wer: 'alle' })}
            className={
              !nurMeine
                ? 'px-3 py-1.5 bg-brand-600 text-on-brand'
                : 'px-3 py-1.5 text-secondary hover:bg-gray-50'
            }
          >
            Alle
          </Link>
          <Link
            href={qs({ wer: 'meine' })}
            className={
              nurMeine
                ? 'px-3 py-1.5 bg-brand-600 text-on-brand'
                : 'px-3 py-1.5 text-secondary hover:bg-gray-50'
            }
          >
            Meine
          </Link>
        </div>
      </div>

      {eintraege.length === 0 ? (
        <div className="card p-10 text-center text-sm text-muted">
          Keine Fristen im gewählten Zeitraum.
        </div>
      ) : (
        <>
          {bucketOrder.map((bucket) => {
            const rows = gruppen.get(bucket);
            if (!rows?.length) return null;
            return (
              <FristenTabelle
                key={bucket}
                titel={`${BUCKET_LABELS[bucket]} (${rows.length})`}
                rows={rows}
                akzent={bucket === 'UEBERFAELLIG' ? 'rot' : bucket === 'HEUTE' ? 'gelb' : null}
              />
            );
          })}
          {erledigte.length > 0 && (
            <FristenTabelle
              titel={`Erledigt — letzte ${tage} Tage (${erledigte.length})`}
              rows={erledigte}
              akzent={null}
            />
          )}
        </>
      )}
    </div>
  );
}

function DailyReviewCard({
  review,
  preview,
  canComplete,
}: {
  review: DailyReviewSummary | null;
  preview: PreparedDailyReview | null;
  canComplete: boolean;
}) {
  return (
    <section
      className={`card p-5 mb-5 ${
        review
          ? 'border-l-4 border-l-green-500'
          : canComplete
            ? 'border-l-4 border-l-amber-500'
            : 'border-l-4 border-l-gray-300'
      }`}
      aria-labelledby="daily-review-title"
    >
      <div className="flex items-start gap-3">
        {review ? (
          <CheckCircle2 className="h-5 w-5 mt-0.5 text-green-700 dark:text-green-300" />
        ) : canComplete ? (
          <ShieldAlert className="h-5 w-5 mt-0.5 text-amber-700 dark:text-amber-300" />
        ) : (
          <AlarmClock className="h-5 w-5 mt-0.5 text-muted" />
        )}
        <div className="min-w-0 flex-1">
          <h2 id="daily-review-title" className="text-sm font-semibold text-primary">
            Tägliche Abschlusskontrolle
          </h2>
          {review ? (
            <div className="mt-1 space-y-2 text-sm text-secondary">
              <p>
                Heute abgeschlossen durch {review.reviewerName ?? 'unbekannte Person'} am{' '}
                {fmtDateTimeMedium(review.reviewedAt)}. Konsistenter Datenstand ab{' '}
                {fmtDateTimeMedium(review.snapshotAt)}. Der Snapshot enthält {review.openCount}{' '}
                offene Fälligkeit{review.openCount === 1 ? '' : 'en'}, davon {review.overdueCount}{' '}
                überfällig und {review.dueTodayCount} heute fällig.
              </p>
              {canComplete && review.escalationNote && (
                <div className="rounded-md bg-gray-50 px-3 py-2 text-xs whitespace-pre-wrap">
                  <span className="font-medium">Eskalation:</span> {review.escalationNote}
                </div>
              )}
              <p className="text-xs text-muted">
                Der Tagesabschluss ist unveränderbar. Er schließt keine Frist im Quellvorgang.
              </p>
            </div>
          ) : (
            <div className="mt-1">
              <p className="text-sm text-secondary mb-3">
                {canComplete
                  ? 'Für heute ist noch kein tenantweiter Abschluss dokumentiert.'
                  : 'Der Status des tenantweiten Tagesabschlusses ist nur für ADMIN/PARTNER sichtbar.'}
                {canComplete && preview && (
                  <>
                    {' '}
                    Aktuell umfasst die Kontrolle {preview.openCount} offene Fälligkeit
                    {preview.openCount === 1 ? '' : 'en'}, davon {preview.overdueCount} überfällig
                    und {preview.dueTodayCount} heute fällig.
                  </>
                )}
              </p>
              {canComplete && preview ? (
                <DailyReviewForm openCount={preview.openCount} />
              ) : canComplete ? (
                <p className="text-xs text-muted">
                  ADMIN/PARTNER dokumentieren den tenantweiten Tagesabschluss, weil nur diese Rollen
                  sämtliche Mandanten unabhängig vom Zugriffsmodus einsehen können.
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function FristenTabelle({
  titel,
  rows,
  akzent,
}: {
  titel: string;
  rows: FristEintrag[];
  akzent: 'rot' | 'gelb' | null;
}) {
  return (
    <div
      className={`card overflow-hidden mb-6 ${akzent === 'rot' ? 'border-l-4 border-l-red-500' : akzent === 'gelb' ? 'border-l-4 border-l-yellow-500' : ''}`}
    >
      <div className="px-6 py-3 border-b border-default">
        <h2
          className={`text-sm font-semibold ${akzent === 'rot' ? 'text-red-800 dark:text-red-300' : 'text-primary'}`}
        >
          {titel}
        </h2>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 border-b border-default text-xs text-muted uppercase">
            <th className="text-left px-6 py-2 font-medium">Fällig</th>
            <th className="text-left px-4 py-2 font-medium">Art</th>
            <th className="text-left px-4 py-2 font-medium">Frist</th>
            <th className="text-left px-4 py-2 font-medium">Mandant</th>
            <th className="text-left px-4 py-2 font-medium">Verantwortlich</th>
            <th className="text-left px-4 py-2 font-medium">Erledigt</th>
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {rows.map((e) => (
            <tr key={`${e.quelle}-${e.id}`} className="hover:bg-gray-50">
              <td className="px-6 py-2.5 whitespace-nowrap font-medium text-primary">
                {fmtDateShort(e.faelligAm)}
              </td>
              <td className="px-4 py-2.5">
                <span className="badge-gray text-[10px]">
                  {e.artLabel ?? QUELLE_LABELS[e.quelle]}
                </span>
              </td>
              <td className="px-4 py-2.5 text-secondary max-w-[26rem]">
                <span className="block truncate" title={e.titel}>
                  {e.titel}
                </span>
                {e.kontrollhinweis && (
                  <span className="block text-xs text-amber-700 mt-0.5">{e.kontrollhinweis}</span>
                )}
              </td>
              <td className="px-4 py-2.5 text-secondary whitespace-nowrap">
                <Link href={`/staff/clients/${e.clientId}`} className="hover:underline">
                  {e.clientName}
                </Link>
              </td>
              <td className="px-4 py-2.5 text-muted whitespace-nowrap">
                {e.verantwortlich ?? '—'}
              </td>
              <td className="px-4 py-2.5 text-muted whitespace-nowrap">
                {e.erledigt
                  ? `${e.kontrollzustand === 'CLOSED_DISPOSITION' ? 'Disposition' : 'Erfüllt'} · ${e.erledigtAm ? fmtDateShort(e.erledigtAm) : 'Datum fehlt'}${e.erledigtVon ? ` · ${e.erledigtVon}` : ''}`
                  : '—'}
              </td>
              <td className="px-4 py-2.5 text-right">
                <Link
                  href={e.href}
                  className="text-disabled hover:text-brand-700"
                  title="Zum Vorgang"
                >
                  <ExternalLink className="h-4 w-4 inline" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
