// =============================================================================
// Liste der Feststellungen und offenen Maßnahmen (TCMS Stufe 3, Bereich C).
// Reine Anzeige von `feststellungenLesen`; maskierte (vertrauliche)
// Feststellungen zeigen nur Nummer, Status und Wiedervorlagen – nie geratene
// Felder. Filter per GET-Formular (ohne Client-Logik).
// =============================================================================

import Link from 'next/link';
import { CalendarClock, CheckCheck, FileCheck } from 'lucide-react';
import type { FeststellungListeSchema, KontextAntwort } from '@taxtronik/tcms-contract';
import {
  AUSWIRKUNG_BADGE,
  AUSWIRKUNG_LABEL,
  FESTSTELLUNG_KLASSE_LABEL,
  FESTSTELLUNG_STATUS_LABEL,
  p153Erforderlich,
  QUELLE_LABEL,
  relativTage,
  type FeststellungStatus,
} from '@taxtronik/tcms-domain';
import type { z } from 'zod';
import { KlasseBadge, VertraulichBadge } from '@/components/tcms/badges';
import { TcmsPflichthinweis } from '@/components/tcms/disclaimer';
import {
  FeststellungBezeichnung,
  FeststellungName,
  VERTRAULICH_HINWEIS,
} from '@/components/tcms/feststellung';
import { TcmsText } from '@/components/tcms/text';
import { ErfassenDialog } from '@/components/tcms/feststellungen/formulare';
import {
  FeststellungStatusBadge,
  kontrollCode,
  P153Badge,
} from '@/components/tcms/feststellungen/teile';
import { isoDatumText, isoTageZwischen } from '@/components/tcms/format';
import { TcmsKopf } from '@/components/tcms/kopf';
import { TcmsLeer } from '@/components/tcms/leer';
import { badgeKlasse } from '@/components/tcms/ton';
import type { TcmsNamen } from '@/server/tcms/namen';
import type { TcmsMandantSeite } from '@/server/tcms/seite';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import { feststellungErfassenAction } from './actions';

type Liste = z.output<typeof FeststellungListeSchema>;
type Eintrag = Liste['feststellungen'][number];

const STATUS: readonly FeststellungStatus[] = [
  'ERFASST',
  'IN_WUERDIGUNG',
  'MASSNAHMEN_OFFEN',
  'NACHKONTROLLE',
  'GESCHLOSSEN',
  'VERWORFEN',
];
const NUR_AKTUELL = 'Änderungen nur im aktuellen Stand möglich';

export interface FeststellungFilter {
  status: string;
  klasse: string;
  quelle: string;
  p153: boolean;
}

function eins(wert: string | string[] | undefined): string {
  return (Array.isArray(wert) ? wert[0] : wert) ?? '';
}

/** Filter aus der Query; nur bekannte Werte. */
export function filterAus(
  suche: Record<string, string | string[] | undefined>,
): FeststellungFilter {
  const status = eins(suche.status);
  const klasse = eins(suche.klasse);
  const quelle = eins(suche.quelle);
  return {
    status: status === 'offen' || (STATUS as readonly string[]).includes(status) ? status : '',
    klasse: klasse in FESTSTELLUNG_KLASSE_LABEL ? klasse : '',
    quelle: quelle in QUELLE_LABEL ? quelle : '',
    p153: eins(suche.p153) === '1',
  };
}

const geschlossen = (s: FeststellungStatus) => s === 'GESCHLOSSEN' || s === 'VERWORFEN';

/** Maskierte Einträge haben keine Klasse, Quelle oder §-153-Angaben und fallen bei diesen Filtern heraus. */
function passt(f: Eintrag, filter: FeststellungFilter): boolean {
  if (filter.status === 'offen' && geschlossen(f.status)) return false;
  if (filter.status && filter.status !== 'offen' && f.status !== filter.status) return false;
  if (filter.klasse && (f.maskiert || f.klasse !== filter.klasse)) return false;
  if (filter.quelle && (f.maskiert || f.quelle !== filter.quelle)) return false;
  if (filter.p153 && (f.maskiert || !f.p153Offen)) return false;
  return true;
}

function quelleAngabe(f: Extract<Eintrag, { maskiert: false }>): string {
  if (f.quelle === 'KONTROLLE') return kontrollCode(f.quelleText) ?? f.quelleText;
  if (f.quelle === 'EREIGNIS') return /\d{4}-T-\d{4}/.exec(f.quelleText)?.[0] ?? f.quelleText;
  return f.quelleText;
}

function Filter({
  filter,
  basis,
  stand,
}: {
  filter: FeststellungFilter;
  basis: string;
  stand: string | null;
}) {
  return (
    <form
      method="get"
      action={`${basis}/feststellungen`}
      className="flex flex-wrap items-end gap-3"
      aria-label="Filter der Feststellungen"
    >
      {stand ? <input type="hidden" name="stand" value={stand} /> : null}
      <div>
        <label htmlFor="ff-status" className="label-sm">
          Status
        </label>
        <select
          id="ff-status"
          name="status"
          className="input py-1 text-xs w-auto"
          defaultValue={filter.status}
        >
          <option value="">alle</option>
          <option value="offen">offen (nicht geschlossen)</option>
          {STATUS.map((s) => (
            <option key={s} value={s}>
              {FESTSTELLUNG_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="ff-klasse" className="label-sm">
          Klasse
        </label>
        <select
          id="ff-klasse"
          name="klasse"
          className="input py-1 text-xs w-auto"
          defaultValue={filter.klasse}
        >
          <option value="">alle</option>
          {Object.entries(FESTSTELLUNG_KLASSE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="ff-quelle" className="label-sm">
          Quelle
        </label>
        <select
          id="ff-quelle"
          name="quelle"
          className="input py-1 text-xs w-auto"
          defaultValue={filter.quelle}
        >
          <option value="">alle</option>
          {Object.entries(QUELLE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <label className="inline-flex items-center gap-1.5 text-xs pb-1.5">
        <input type="checkbox" name="p153" value="1" defaultChecked={filter.p153} />
        §-153-Würdigung offen
      </label>
      <button type="submit" className="btn-secondary text-xs py-1">
        Filtern
      </button>
    </form>
  );
}

function Zeile({ f, href, heute }: { f: Eintrag; href: string; heute: string }) {
  if (f.maskiert) {
    return (
      <tr className="border-t border-default">
        <th scope="row" className="px-4 py-2.5 text-left font-normal">
          <Link href={href} className="text-sm text-primary hover:underline">
            <FeststellungBezeichnung f={f} />
          </Link>
        </th>
        <td colSpan={7} className="px-4 py-2.5">
          <span className="inline-flex items-center gap-2">
            <VertraulichBadge />
            <span className="text-sm text-muted">{VERTRAULICH_HINWEIS}.</span>
          </span>
        </td>
        <td className="px-4 py-2.5">
          <FeststellungStatusBadge status={f.status} />
        </td>
      </tr>
    );
  }
  const tage = isoTageZwischen(heute, f.aeltesteFrist);
  const ueberfaellig = tage !== null && tage < 0;
  return (
    <tr className="border-t border-default align-top">
      <th scope="row" className="px-4 py-2.5 text-left font-normal min-w-[14rem]">
        <Link href={href} className="text-sm font-medium text-primary hover:underline">
          <FeststellungBezeichnung f={f} />
        </Link>
        <span className="ml-1.5 inline-flex flex-wrap gap-1">
          {f.vertraulich ? <VertraulichBadge /> : null}
          {f.verwerfenOffen ? (
            <span className="badge-yellow" title="Antrag auf Verwerfen wartet auf zweite Person">
              Verwerfen beantragt
            </span>
          ) : null}
        </span>
      </th>
      <td className="px-4 py-2.5">
        <span className="badge-gray">{QUELLE_LABEL[f.quelle]}</span>
        <div className="text-xs text-muted mt-1">{quelleAngabe(f)}</div>
      </td>
      <td className="px-4 py-2.5">
        <span className="badge-gray whitespace-normal">{FESTSTELLUNG_KLASSE_LABEL[f.klasse]}</span>
      </td>
      <td className="px-4 py-2.5">
        <KlasseBadge klasse={f.schwere} />
      </td>
      <td className="px-4 py-2.5">
        <span className={badgeKlasse(AUSWIRKUNG_BADGE[f.auswirkung])}>
          {AUSWIRKUNG_LABEL[f.auswirkung]}
        </span>
      </td>
      <td className="px-4 py-2.5 max-w-[12rem]">
        <P153Badge
          erforderlich={p153Erforderlich(f.auswirkung) && f.status !== 'VERWORFEN'}
          entscheidung={f.p153?.entscheidung ?? null}
          am={f.p153?.am ?? null}
          frist={f.p153?.frist ?? null}
        />
      </td>
      <td className="td-num px-4 whitespace-nowrap">
        {f.massnahmenOffen > 0 ? (
          f.massnahmenOffen
        ) : f.massnahmenGesamt > 0 ? (
          <>
            {f.massnahmenGesamt}/{f.massnahmenGesamt}
            <div className="text-[11px] text-muted font-sans">
              {f.status === 'NACHKONTROLLE' ? 'Nachkontrolle offen' : 'umgesetzt'}
            </div>
          </>
        ) : (
          0
        )}
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap text-sm">
        {f.aeltesteFrist ? (
          <span
            className={ueberfaellig ? 'text-red-700' : ''}
            title={ueberfaellig ? 'Frist überschritten' : undefined}
          >
            {isoDatumText(f.aeltesteFrist)}
            {ueberfaellig ? <span className="sr-only"> (Frist überschritten)</span> : null}
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        <FeststellungStatusBadge status={f.status} />
      </td>
    </tr>
  );
}

function OffeneMassnahmen({
  liste,
  namen,
  heute,
  href,
}: {
  liste: Liste;
  namen: TcmsNamen;
  heute: string;
  href: (id: string) => string;
}) {
  const offen: Array<{
    id: string;
    feststellung: Eintrag;
    wiedervorlageNr: number;
    frist: string;
    beschreibung: string | null;
    verantwortlich: string | null;
  }> = [];
  let erledigt = 0;
  for (const f of liste.feststellungen) {
    if (f.status === 'VERWORFEN') continue;
    for (const m of f.massnahmen) {
      if (m.status !== 'OFFEN') {
        erledigt++;
        continue;
      }
      offen.push({
        id: m.id,
        feststellung: f,
        wiedervorlageNr: m.wiedervorlageNr,
        frist: m.frist,
        beschreibung: 'beschreibung' in m ? m.beschreibung : null,
        verantwortlich: 'verantwortlich' in m ? m.verantwortlich : null,
      });
    }
  }
  offen.sort((a, b) => a.frist.localeCompare(b.frist));
  return (
    <section className="card mt-4" aria-labelledby="tcms-massnahmen-offen">
      <div className="card-header">
        <h3 id="tcms-massnahmen-offen" className="text-sm font-semibold text-primary">
          Offene Maßnahmen
        </h3>
        <span className={offen.length ? 'badge-yellow' : 'badge-gray'}>{offen.length} offen</span>
      </div>
      {offen.length === 0 ? (
        <TcmsLeer icon={CheckCheck} text="Keine offenen Maßnahmen." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th scope="col" className="th">
                  Wiedervorlage
                </th>
                <th scope="col" className="th">
                  Maßnahme
                </th>
                <th scope="col" className="th">
                  Feststellung
                </th>
                <th scope="col" className="th">
                  Verantwortlich
                </th>
                <th scope="col" className="th">
                  Frist
                </th>
                <th scope="col" className="th">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {offen.map((m) => {
                const tage = isoTageZwischen(heute, m.frist);
                return (
                  <tr key={m.id} className="border-t border-default">
                    <td className="px-6 py-2.5">
                      <span className="badge-gray gap-1">
                        <CalendarClock className="h-3 w-3" aria-hidden="true" />
                        <span className="font-mono">#{m.wiedervorlageNr}</span>
                      </span>
                    </td>
                    <td className="px-6 py-2.5">
                      {m.beschreibung !== null ? (
                        <TcmsText>{m.beschreibung}</TcmsText>
                      ) : (
                        <span className="text-muted">vertraulich</span>
                      )}
                    </td>
                    <td className="px-6 py-2.5">
                      <Link
                        href={href(m.feststellung.id)}
                        className="text-xs text-primary hover:underline"
                      >
                        <FeststellungName f={m.feststellung} />
                      </Link>
                    </td>
                    <td className="px-6 py-2.5">
                      {m.verantwortlich ? namen.name(m.verantwortlich) : '—'}
                    </td>
                    <td className="px-6 py-2.5 whitespace-nowrap">
                      {isoDatumText(m.frist)}
                      {tage !== null ? (
                        <span className="text-[11px] text-muted"> · {relativTage(tage)}</span>
                      ) : null}
                    </td>
                    <td className="px-6 py-2.5">
                      {tage !== null && tage < 0 ? (
                        <span className="badge-red">überfällig</span>
                      ) : (
                        <span className="badge-yellow">offen</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-footer">
        <span>
          {erledigt} Maßnahme{erledigt === 1 ? '' : 'n'} erledigt · Wiedervorlage-Nummern
          kanzleiweit fortlaufend
        </span>
      </div>
    </section>
  );
}

export function FeststellungenListe({
  seite,
  ctx,
  liste,
  filter,
  namen,
}: {
  seite: TcmsMandantSeite;
  ctx: KontextAntwort;
  liste: Liste;
  filter: FeststellungFilter;
  namen: TcmsNamen;
}) {
  const basis = seite.basis;
  const stand = ctx.historisch ? ctx.stand : null;
  const href = (id: string) =>
    `${basis}/feststellungen/${encodeURIComponent(id)}${stand ? `?stand=${stand}` : ''}`;
  const gefiltert = liste.feststellungen.filter((f) => passt(f, filter));
  const offen = liste.feststellungen.filter((f) => !geschlossen(f.status)).length;
  const p153Offen = liste.feststellungen.filter((f) => !f.maskiert && f.p153Offen).length;
  const sperre = ctx.historisch
    ? NUR_AKTUELL
    : ctx.rechte.bearbeiten
      ? null
      : TCMS_KEIN_RECHT.BEARBEITEN;
  const durchfuehrungen = ctx.durchfuehrungen
    .filter((d) =>
      ['MIT_BEFUND', 'ZUR_GEGENZEICHNUNG', 'IN_DURCHFUEHRUNG', 'UEBERFAELLIG'].includes(d.anzeige),
    )
    .sort((a, b) => b.faelligAm.localeCompare(a.faelligAm))
    .slice(0, 40)
    .map((d) => [d.id, `${d.code} · ${d.periodeLabel}`] as const);
  return (
    <>
      <TcmsKopf
        daten={{
          teilbereich: ctx.teilbereich,
          aktivePhase: ctx.aktivePhase,
          historisch: ctx.historisch,
          stand: ctx.stand,
          heute: ctx.heute,
          ausgeblendet: ctx.ausgeblendet,
        }}
        titel={
          <h2 className="text-lg font-semibold text-primary mr-2">Feststellungen und Maßnahmen</h2>
        }
      />
      <TcmsPflichthinweis />
      <div className="mt-4 mb-4 flex flex-wrap items-end justify-between gap-3">
        <Filter filter={filter} basis={basis} stand={stand} />
        <ErfassenDialog
          action={feststellungErfassenAction.bind(null, seite.mandantId)}
          disabled={sperre !== null}
          disabledGrund={sperre}
          durchfuehrungen={durchfuehrungen}
          risiken={ctx.risiken.map((r) => [r.id, `${r.code} · ${r.titel}`] as const)}
        />
      </div>
      <section className="card" aria-labelledby="tcms-feststellungen">
        <div className="card-header">
          <h3 id="tcms-feststellungen" className="text-sm font-semibold text-primary">
            Feststellungen
          </h3>
        </div>
        {gefiltert.length === 0 ? (
          <TcmsLeer
            icon={FileCheck}
            text={
              liste.feststellungen.length === 0
                ? 'Noch keine Feststellungen erfasst.'
                : 'Keine Feststellung entspricht den Filtern.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th scope="col" className="th px-4">
                    Feststellung
                  </th>
                  <th scope="col" className="th px-4">
                    Quelle
                  </th>
                  <th scope="col" className="th px-4">
                    Klasse
                  </th>
                  <th scope="col" className="th px-4">
                    Schwere
                  </th>
                  <th scope="col" className="th px-4">
                    Steuerliche Auswirkung
                  </th>
                  <th scope="col" className="th px-4">
                    §-153-Status
                  </th>
                  <th scope="col" className="th th-right px-4">
                    Maßnahmen offen
                  </th>
                  <th scope="col" className="th px-4">
                    Älteste Frist
                  </th>
                  <th scope="col" className="th px-4">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {gefiltert.map((f) => (
                  <Zeile key={f.id} f={f} href={href(f.id)} heute={ctx.stand} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-footer">
          <span>
            {liste.feststellungen.length} Feststellungen gesamt · {offen} offen · {p153Offen}{' '}
            §-153-Würdigung{p153Offen === 1 ? '' : 'en'} offen
            {gefiltert.length !== liste.feststellungen.length
              ? ` · ${gefiltert.length} angezeigt`
              : ''}
          </span>
          {gefiltert.length !== liste.feststellungen.length ? (
            <Link
              href={`${basis}/feststellungen${stand ? `?stand=${stand}` : ''}`}
              className="underline"
            >
              Alle anzeigen
            </Link>
          ) : null}
        </div>
      </section>
      <OffeneMassnahmen liste={liste} namen={namen} heute={ctx.stand} href={href} />
    </>
  );
}
