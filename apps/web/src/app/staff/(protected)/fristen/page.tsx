// =============================================================================
// /staff/fristen — Fristenkontrollbuch
//
// Vereinheitlichte Kontrollsicht über alle fristenführenden Quellen
// (Steuertermine, Einspruchsfristen, Anforderungen, Wiedervorlagen) mit
// Verantwortlichen und Erledigungsnachweis. Haftungsrelevanz: offene Fristen
// verschwinden NIE durch Zeitablauf; der CSV-Export ist der Nachweis fürs
// Fristenbuch (auditiert). Erledigt wird im jeweiligen Quellmodul — dieses
// Buch hält bewusst keinen eigenen Zustand.
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { AlarmClock, FileDown, ExternalLink } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { loadKontrollbuch } from '@/server/fristen/kontrollbuch';
import {
  bucketFor,
  BUCKET_LABELS,
  QUELLE_LABELS,
  type FristBucket,
  type FristEintrag,
} from '@/server/fristen/eintrag';
import { fmtDateShort, berlinTodayUtcMidnight } from '@/lib/fmt';

const RANGES = [7, 30, 90] as const;

interface Search {
  tage?: string;
  filter?: string; // 'offen' (default) | 'alle'
  wer?: string; // 'alle' (default) | 'meine'
}

export default async function FristenPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { tenantId, staffId } = session.user;

  const sp = await searchParams;
  const tage = (RANGES as readonly number[]).includes(Number(sp.tage)) ? Number(sp.tage) : 30;
  const nurOffene = sp.filter !== 'alle';
  const nurMeine = sp.wer === 'meine';

  const eintraege = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) => loadKontrollbuch(tx, session, { tage, nurStaffId: nurMeine ? staffId : null }),
  );

  const sichtbar = nurOffene ? eintraege.filter((e) => !e.erledigt) : eintraege;
  // bucketFor arbeitet in UTC-Tagesgrenzen (passend zu @db.Date = UTC-Mitternacht).
  // „Heute" muss daher der Berlin-Kalendertag als UTC-Mitternacht sein — sonst
  // landet eine Frist zwischen 00:00–02:00 Berlin im falschen Bucket.
  const heute = berlinTodayUtcMidnight();

  // Offene nach Dringlichkeit gruppieren; Erledigte (falls eingeblendet) separat.
  const gruppen = new Map<FristBucket, FristEintrag[]>();
  const erledigte: FristEintrag[] = [];
  for (const e of sichtbar) {
    if (e.erledigt) {
      erledigte.push(e);
      continue;
    }
    const b = bucketFor(e.faelligAm, heute);
    if (!gruppen.has(b)) gruppen.set(b, []);
    gruppen.get(b)!.push(e);
  }
  const offeneCount = sichtbar.length - erledigte.length;
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
            Steuertermine, Einspruchsfristen, Anforderungen und Wiedervorlagen — {offeneCount} offen
            {ueberfaellig > 0 && (
              <span className="text-red-700 font-medium">, davon {ueberfaellig} überfällig</span>
            )}
            . Erledigt wird im jeweiligen Modul.
          </p>
        </div>
        <a
          href={`/api/staff/fristen/export?tage=${tage}${nurMeine ? '&wer=meine' : ''}`}
          className="btn-secondary"
          title="Fristenbuch als CSV (Erledigungsnachweis, wird im Prüfprotokoll vermerkt)"
        >
          <FileDown className="h-3.5 w-3.5" />
          CSV-Nachweis
        </a>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="toggle-group">
          {RANGES.map((t) => (
            <Link
              key={t}
              href={qs({ tage: String(t) })}
              className={
                t === tage
                  ? 'px-3 py-1.5 bg-brand-600 text-white'
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
                ? 'px-3 py-1.5 bg-brand-600 text-white'
                : 'px-3 py-1.5 text-secondary hover:bg-gray-50'
            }
          >
            Offen
          </Link>
          <Link
            href={qs({ filter: 'alle' })}
            className={
              !nurOffene
                ? 'px-3 py-1.5 bg-brand-600 text-white'
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
                ? 'px-3 py-1.5 bg-brand-600 text-white'
                : 'px-3 py-1.5 text-secondary hover:bg-gray-50'
            }
          >
            Alle
          </Link>
          <Link
            href={qs({ wer: 'meine' })}
            className={
              nurMeine
                ? 'px-3 py-1.5 bg-brand-600 text-white'
                : 'px-3 py-1.5 text-secondary hover:bg-gray-50'
            }
          >
            Meine
          </Link>
        </div>
      </div>

      {sichtbar.length === 0 ? (
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
                <span className="badge-gray text-[10px]">{QUELLE_LABELS[e.quelle]}</span>
              </td>
              <td className="px-4 py-2.5 text-secondary max-w-[26rem] truncate" title={e.titel}>
                {e.titel}
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
                  ? `${e.erledigtAm ? fmtDateShort(e.erledigtAm) : 'ja'}${e.erledigtVon ? ` · ${e.erledigtVon}` : ''}`
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
