// =============================================================================
// CMS-Beschreibung: Status, Abschnitte und lebende bzw. eingefrorene Bausteine
// (TCMS Stufe 3, Bereich A; aus der Demo components/beschreibung/*). Reine
// Anzeige, auch für die Freigabe im Portal nutzbar.
//
// Personen in Bausteinen:
//   - live (Entwurf, Review, Vorschau): Der Dienst liefert Personen als ID
//     (`…Id`, `personId`) und ohne Namen („—“, Personenverzeichnis im Dienst
//     leer). Namen kommen aus der kanzleikonsole (`namen`, aufgelöst mit
//     tcmsNamenLesen); unbekannte IDs erscheinen als „Unbekannte Person“.
//   - eingefroren (Snapshot): Der Inhalt ist unveränderlich und durch den
//     SHA-256 gebunden; angezeigt werden genau die eingefrorenen Namen, nie neu
//     aufgelöste.
// =============================================================================

import type { ReactNode } from 'react';
import { KeyRound, Lock, TriangleAlert } from 'lucide-react';
import type {
  BausteinSatzDaten,
  BeschreibungAbschnitt,
  BeschreibungVersionView,
} from '@taxtronik/tcms-contract';
import {
  abschnittHatText,
  BAUSTEIN_LABEL,
  BAUSTEIN_QUELLE,
  fmtEurGanz,
  fmtMonatJahr,
  KLASSE_LABEL,
  KONTROLLART_LABEL,
  PARTEI_LABEL,
  type AbschnittVorlage,
  type BausteinArt,
} from '@taxtronik/tcms-domain';
import { GtBadge, KlasseBadge } from '../badges';
import { isoDatumText } from '../format';

export type BeschreibungStatus = BeschreibungVersionView['status'];

export const BESCHREIBUNG_STATUS_LABEL: Readonly<Record<BeschreibungStatus, string>> = {
  ENTWURF: 'Entwurf',
  KANZLEI_REVIEW: 'Kanzlei-Review',
  BEIM_MANDANTEN: 'Zur Mandantenfreigabe',
  FREIGEGEBEN: 'Freigegeben',
  ABGELOEST: 'abgelöst',
};

const STATUS_BADGE: Readonly<Record<BeschreibungStatus, string>> = {
  ENTWURF: 'badge-gray',
  KANZLEI_REVIEW: 'badge-purple',
  BEIM_MANDANTEN: 'badge-yellow',
  FREIGEGEBEN: 'badge-green',
  ABGELOEST: 'badge-gray',
};

export function BeschreibungStatusBadge({ status }: { status: BeschreibungStatus }) {
  return <span className={STATUS_BADGE[status]}>{BESCHREIBUNG_STATUS_LABEL[status]}</span>;
}

/** Herkunft der Bausteindaten einer Ansicht. */
export type BausteinQuelle =
  | {
      modus: 'live';
      /** Datenstand (`YYYY-MM-DD`) der lebenden Bausteine. */
      stand: string;
      satz: BausteinSatzDaten | null;
      /** Personen-ID (klein) → Name aus der kanzleikonsole. */
      namen: Readonly<Record<string, string>>;
    }
  | { modus: 'snapshot'; stand: string | null; satz: Partial<BausteinSatzDaten> | null };

export const UNBEKANNT = 'Unbekannte Person';

/** Alle Personen-IDs der lebenden Bausteine (für eine Namensabfrage je Seite). */
export function bausteinPersonIds(satz: Partial<BausteinSatzDaten> | null): string[] {
  if (!satz) return [];
  const ids: Array<string | null | undefined> = [];
  for (const z of satz.ZIELE?.ziele ?? []) ids.push(z.freigegebenVonId);
  for (const k of satz.KONTROLLMATRIX?.kontrollen ?? []) ids.push(k.designVonId);
  for (const r of satz.VERANTWORTUNG?.rollen ?? []) ids.push(r.personId);
  for (const k of satz.VERANTWORTUNG?.kontrollen ?? []) {
    ids.push(k.durchfuehrendId, k.vertretungId, k.gegenzeichnungId);
  }
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

/** Anzeigename einer Person im Baustein: live aus der kanzleikonsole, eingefroren aus dem Snapshot. */
function person(
  quelle: BausteinQuelle,
  id: string | null | undefined,
  text: string | null,
): string {
  if (quelle.modus === 'snapshot') return text ?? '—';
  if (id === undefined) return text ?? '—'; // ältere Daten ohne ID: Text des Dienstes
  if (id === null || id === '') return '—';
  return quelle.namen[id.toLowerCase()] ?? UNBEKANNT;
}

function Tabelle({
  kopf,
  beschriftung,
  children,
}: {
  kopf: readonly string[];
  beschriftung: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{beschriftung}</caption>
        <thead>
          <tr>
            {kopf.map((k, i) => (
              <th key={`${k}-${i}`} scope="col" className="th text-xs">
                {k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const ZELLE = 'px-2 py-1.5 align-top border-t border-default';

const REG: Readonly<Record<'VOLLSTAENDIG' | 'FEHLT' | 'PRUEFEN', [string, string]>> = {
  VOLLSTAENDIG: ['badge-green', 'vollständig'],
  FEHLT: ['badge-red', 'Registrierung fehlt'],
  PRUEFEN: ['badge-yellow', 'Steuersätze prüfen'],
};

interface InhaltProps {
  satz: Partial<BausteinSatzDaten> | null;
  quelle: BausteinQuelle;
  label: string;
}

function TeilbereichInhalt({ satz }: InhaltProps) {
  const t = satz?.TEILBEREICH;
  if (!t) return <p className="text-sm text-muted">Noch kein Teilbereich abgegrenzt.</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold">{t.name}</p>
      <p className="text-sm text-secondary whitespace-pre-line">{t.abgrenzung}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted w-24">Eingeschlossen</span>
        {t.einschluesse.map((e) => (
          <span key={e} className="badge-green">
            {e}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted w-24">Ausgeschlossen</span>
        {t.ausschluesse.map((e) => (
          <span key={e} className="badge-gray">
            {e}
          </span>
        ))}
      </div>
      {t.zielLaender.length || t.kanaele.length ? (
        <p className="text-xs text-muted">
          {t.zielLaender.length ? (
            <>
              Zielländer: <span className="font-mono">{t.zielLaender.join(' · ')}</span>
            </>
          ) : null}
          {t.zielLaender.length && t.kanaele.length ? ' · ' : ''}
          {t.kanaele.length ? <>Kanäle: {t.kanaele.join(', ')}</> : null}
        </p>
      ) : null}
    </div>
  );
}

function ZieleInhalt({ satz, quelle, label }: InhaltProps) {
  const z = satz?.ZIELE;
  if (!z?.ziele.length)
    return <p className="text-sm text-muted">Noch keine Compliance-Ziele erfasst.</p>;
  return (
    <Tabelle kopf={['Ziel', 'Wesentlichkeit', 'Appetit', 'Freigabe']} beschriftung={label}>
      {z.ziele.map((x, i) => (
        <tr key={i}>
          <td className={ZELLE}>{x.text}</td>
          <td className={`${ZELLE} td-num font-mono text-xs`}>{fmtEurGanz(x.wesentlichkeitEur)}</td>
          <td className={ZELLE}>
            <KlasseBadge klasse={x.risikoappetit} />
          </td>
          <td className={`${ZELLE} text-xs`}>
            {x.freigabe === 'FREIGEGEBEN' ? (
              <>
                <span className="badge-green">freigegeben</span>
                <span className="block text-muted mt-1">
                  {person(quelle, x.freigegebenVonId, x.freigegebenVon)} ·{' '}
                  {isoDatumText(x.freigegebenAm)}
                </span>
              </>
            ) : (
              <span className="badge-yellow">
                {x.freigabe === 'AUSSTEHEND' ? 'Freigabe ausstehend' : 'Entwurf'}
              </span>
            )}
          </td>
        </tr>
      ))}
    </Tabelle>
  );
}

function RisikoinventarInhalt({ satz, label }: InhaltProps) {
  const r = satz?.RISIKOINVENTAR;
  if (!r?.risiken.length) return <p className="text-sm text-muted">Noch keine aktiven Risiken.</p>;
  const ueber = r.risiken.filter((x) => x.ueberAppetit).length;
  return (
    <>
      <Tabelle
        kopf={[
          'ID',
          'Risiko',
          'GT',
          'Brutto',
          r.sicht === 'BETRIEB' ? 'Netto (Betrieb)' : 'Netto (Design)',
        ]}
        beschriftung={label}
      >
        {r.risiken.map((x) => (
          <tr key={x.code}>
            <td className={`${ZELLE} font-mono text-xs whitespace-nowrap`}>{x.code}</td>
            <td className={ZELLE}>{x.titel}</td>
            <td className={ZELLE}>
              <GtBadge gt={x.gt} />
            </td>
            <td className={ZELLE}>
              <KlasseBadge klasse={x.brutto} />
            </td>
            <td className={`${ZELLE} whitespace-nowrap`}>
              <KlasseBadge klasse={x.netto} />
              {x.ueberAppetit ? (
                <span className="ml-1.5 inline-flex items-center gap-1 text-xs text-red-700 dark:text-red-400">
                  <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
                  über Appetit
                </span>
              ) : null}
            </td>
          </tr>
        ))}
      </Tabelle>
      <p className="text-xs text-muted mt-2">
        {r.risiken.length} aktive Risiken · Risikoappetit {KLASSE_LABEL[r.appetit]} · {ueber} über
        Appetit
      </p>
    </>
  );
}

function KontrollmatrixInhalt({ satz, quelle, label }: InhaltProps) {
  const k = satz?.KONTROLLMATRIX;
  if (!k?.kontrollen.length)
    return <p className="text-sm text-muted">Noch keine aktiven Kontrollen.</p>;
  return (
    <>
      <Tabelle
        kopf={['ID', 'Kontrolle', 'Art', 'Frequenz', 'Partei', 'Designbeurteilung']}
        beschriftung={label}
      >
        {k.kontrollen.map((x) => (
          <tr key={x.code}>
            <td className={`${ZELLE} font-mono text-xs whitespace-nowrap`}>
              {x.code}
              {x.schluessel ? (
                <span className="ml-1 inline-flex align-middle" title="Schlüsselkontrolle">
                  <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">Schlüsselkontrolle</span>
                </span>
              ) : null}
            </td>
            <td className={ZELLE}>
              {x.titel}
              {x.risikoCodes.length ? (
                <span className="block text-xs text-muted font-mono">
                  {x.risikoCodes.join(' · ')}
                </span>
              ) : null}
            </td>
            <td className={`${ZELLE} text-xs`}>
              <abbr title={KONTROLLART_LABEL[x.art]} className="no-underline">
                {x.art}
              </abbr>
            </td>
            <td className={`${ZELLE} text-xs`}>{x.frequenz}</td>
            <td className={`${ZELLE} text-xs`}>{PARTEI_LABEL[x.partei]}</td>
            <td className={`${ZELLE} text-xs`}>
              {x.design === 'ANGEMESSEN' ? (
                <>
                  <span className="badge-green">Designbeurteilung: angemessen</span>
                  <span className="block text-muted mt-1">
                    {person(quelle, x.designVonId, x.designVon)} · {isoDatumText(x.designAm)}
                  </span>
                </>
              ) : x.design === 'MANGEL' ? (
                <span className="badge-red">
                  Mangel · {person(quelle, x.designVonId, x.designVon)}
                </span>
              ) : (
                <span className="badge-gray">nicht beurteilt</span>
              )}
            </td>
          </tr>
        ))}
      </Tabelle>
      <p className="text-xs text-muted mt-2">
        {k.kontrollen.length} aktive Kontrollen · davon{' '}
        {k.kontrollen.filter((x) => x.schluessel).length} Schlüsselkontrollen
      </p>
    </>
  );
}

function VerantwortungInhalt({ satz, quelle, label }: InhaltProps) {
  const v = satz?.VERANTWORTUNG;
  if (!v) return <p className="text-sm text-muted">Für diesen Baustein liegen keine Daten vor.</p>;
  return (
    <>
      <ul className="flex flex-wrap gap-1.5 mb-2">
        {v.rollen.map((r, i) => (
          <li key={`${r.rolle}-${i}`} className="badge-gray">
            {r.rolle}:{' '}
            <strong className="font-semibold">{person(quelle, r.personId, r.name)}</strong>
          </li>
        ))}
      </ul>
      {v.kontrollen.length ? (
        <Tabelle
          kopf={['Kontrolle', 'Partei', 'Durchführung', 'Vertretung', 'Gegenzeichnung']}
          beschriftung={label}
        >
          {v.kontrollen.map((x) => {
            // Der Dienst kennzeichnet eine Gegenzeichnung durch den Mandanten im Text.
            const mandant = x.gegenzeichnung.endsWith(' (Mandant)');
            const gegen = person(quelle, x.gegenzeichnungId, x.gegenzeichnung);
            return (
              <tr key={x.code}>
                <td className={ZELLE}>
                  <span className="font-mono text-xs">{x.code}</span> {x.titel}
                </td>
                <td className={`${ZELLE} text-xs`}>{PARTEI_LABEL[x.partei]}</td>
                <td className={`${ZELLE} text-xs`}>
                  {person(quelle, x.durchfuehrendId, x.durchfuehrend)}
                </td>
                <td className={`${ZELLE} text-xs`}>
                  {person(quelle, x.vertretungId, x.vertretung)}
                </td>
                <td className={`${ZELLE} text-xs`}>
                  {quelle.modus === 'live' && mandant && x.gegenzeichnungId
                    ? `${gegen} (Mandant)`
                    : gegen}
                </td>
              </tr>
            );
          })}
        </Tabelle>
      ) : null}
    </>
  );
}

function LaenderInhalt({ satz, label }: InhaltProps) {
  const l = satz?.LAENDER;
  if (!l?.laender.length)
    return <p className="text-sm text-muted">Im Länder-Monitor sind noch keine Länder erfasst.</p>;
  return (
    <>
      <Tabelle
        kopf={['Land', 'Fernverkäufe lfd. Jahr', 'Lager seit', 'Registrierung']}
        beschriftung={label}
      >
        {l.laender.map((x) => (
          <tr key={x.land}>
            <td className={ZELLE}>
              <span className="font-medium">{x.land}</span>{' '}
              <span className="text-xs text-muted">{x.name}</span>
            </td>
            <td className={`${ZELLE} td-num font-mono text-xs`}>
              {fmtEurGanz(x.fernverkaeufeLfdEur)}
            </td>
            <td className={`${ZELLE} text-xs`}>{x.lagerSeit ? fmtMonatJahr(x.lagerSeit) : '–'}</td>
            <td className={ZELLE}>
              <span className="flex flex-wrap gap-1">
                {x.oss ? <span className="badge-green">OSS</span> : null}
                {x.lokaleUstNr ? <span className="badge-green">lokale USt-Nr.</span> : null}
                <span className={REG[x.registrierung][0]}>{REG[x.registrierung][1]}</span>
              </span>
            </td>
          </tr>
        ))}
      </Tabelle>
      <p className="text-xs text-muted mt-2">
        EU-Fernverkäufe lfd. Jahr <span className="font-mono">{fmtEurGanz(l.summeLfd)}</span> ·
        Vorjahr <span className="font-mono">{fmtEurGanz(l.summeVorjahr)}</span> · {l.schwelle}
        {l.stand ? ` · Datenstand ${isoDatumText(l.stand)}` : ''}
      </p>
    </>
  );
}

function FeststellungenInhalt({ satz, label }: InhaltProps) {
  const f = satz?.FESTSTELLUNGEN;
  if (!f?.feststellungen.length)
    return <p className="text-sm text-muted">Keine offenen Feststellungen.</p>;
  return (
    <Tabelle
      kopf={['Nr.', 'Feststellung', 'Schwere', 'Status', 'Maßnahmen offen']}
      beschriftung={label}
    >
      {f.feststellungen.map((x) => (
        <tr key={x.nummer}>
          <td className={`${ZELLE} font-mono text-xs whitespace-nowrap`}>{x.nummer}</td>
          <td className={ZELLE}>{x.titel}</td>
          <td className={ZELLE}>
            <KlasseBadge klasse={x.schwere} />
          </td>
          <td className={`${ZELLE} text-xs`}>{x.status}</td>
          <td className={`${ZELLE} td-num text-xs`}>{x.massnahmenOffen}</td>
        </tr>
      ))}
    </Tabelle>
  );
}

function Inhalt({ art, quelle }: { art: BausteinArt; quelle: BausteinQuelle }) {
  const props: InhaltProps = {
    satz: quelle.satz as Partial<BausteinSatzDaten> | null,
    quelle,
    label: BAUSTEIN_LABEL[art],
  };
  switch (art) {
    case 'TEILBEREICH':
      return <TeilbereichInhalt {...props} />;
    case 'ZIELE':
      return <ZieleInhalt {...props} />;
    case 'RISIKOINVENTAR':
      return <RisikoinventarInhalt {...props} />;
    case 'KONTROLLMATRIX':
      return <KontrollmatrixInhalt {...props} />;
    case 'VERANTWORTUNG':
      return <VerantwortungInhalt {...props} />;
    case 'LAENDER':
      return <LaenderInhalt {...props} />;
    case 'FESTSTELLUNGEN':
      return <FeststellungenInhalt {...props} />;
  }
}

/** Lebender bzw. eingefrorener Baustein: nicht editierbar, mit Datenstand. */
export function BausteinBlock({
  art,
  quelle,
  aktion,
}: {
  art: BausteinArt;
  quelle: BausteinQuelle;
  aktion?: ReactNode;
}) {
  const vorhanden = quelle.satz
    ? (quelle.satz as Partial<BausteinSatzDaten>)[art] !== undefined
    : false;
  const marke =
    quelle.modus === 'live'
      ? `automatisch · Stand ${isoDatumText(quelle.stand)}`
      : `eingefroren${quelle.stand ? ` · Stand ${isoDatumText(quelle.stand)}` : ''}`;
  return (
    <div className="mt-4 rounded-md border border-dashed border-default bg-surface-raised p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <p className="text-sm font-semibold text-primary">{BAUSTEIN_LABEL[art]}</p>
        <span className="flex items-center gap-2">
          <span className={quelle.modus === 'live' ? 'badge-brand' : 'badge-gray'}>
            {quelle.modus === 'snapshot' ? <Lock className="h-3 w-3" aria-hidden="true" /> : null}
            {marke}
          </span>
          {aktion}
        </span>
      </div>
      {vorhanden ? (
        <Inhalt art={art} quelle={quelle} />
      ) : quelle.modus === 'snapshot' ? (
        <p className="text-sm text-muted">
          Dieser Snapshot enthält nur die Gliederung; die Bausteindaten wurden bei der Freigabe
          nicht mit eingefroren.
        </p>
      ) : (
        <p className="text-sm text-muted">Für diesen Baustein liegen noch keine Daten vor.</p>
      )}
      <p className="text-xs text-muted mt-2">
        {quelle.modus === 'live'
          ? `Baustein nicht editierbar – Inhalt aus ${BAUSTEIN_QUELLE[art]}.`
          : 'Eingefrorener Inhalt der Version – unveränderlich, durch den Snapshot-Hash gebunden.'}
      </p>
    </div>
  );
}

/** Freitext mit Absätzen (Leerzeile) und Zeilenumbrüchen; reiner Text, kein HTML. */
export function Freitext({ text }: { text: string }) {
  const absaetze = text
    .split(/\n\s*\n/)
    .map((a) => a.trim())
    .filter(Boolean);
  return (
    <>
      {absaetze.map((a, i) => (
        <p key={i} className="text-sm mb-2.5 whitespace-pre-line">
          {a}
        </p>
      ))}
    </>
  );
}

/** Abschnitt im Lesemodus: Freitextblöcke und lebende bzw. eingefrorene Bausteine. */
export function AbschnittAnsicht({
  abschnitt,
  vorlage,
  quelle,
  mitTitel = false,
  lueckenHinweis = true,
}: {
  abschnitt: BeschreibungAbschnitt;
  vorlage: AbschnittVorlage;
  quelle: BausteinQuelle;
  mitTitel?: boolean;
  lueckenHinweis?: boolean;
}) {
  const hatText = abschnittHatText(abschnitt);
  const titelId = `abschnitt-${abschnitt.key}-titel`;
  return (
    <section
      id={`abschnitt-${abschnitt.key}`}
      aria-labelledby={mitTitel ? titelId : undefined}
      className="flex flex-col gap-1"
    >
      {mitTitel ? (
        <h4 id={titelId} className="text-base font-semibold text-primary mt-2 mb-2">
          {vorlage.nr === 'A' ? 'Anhang' : `${vorlage.nr} ${vorlage.titel}`}
        </h4>
      ) : null}
      {!hatText && lueckenHinweis ? (
        <p className="alert-warning text-sm mb-2 flex items-start gap-2" role="note">
          <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            Kein Freitext – Lücke in diesem Abschnitt. Die Beschreibung ist Aufgabe der gesetzlichen
            Vertreter; die Kanzlei bereitet den Text vor.
          </span>
        </p>
      ) : null}
      {abschnitt.bloecke.map((b, i) =>
        b.typ === 'text' ? (
          b.text.trim() ? (
            <Freitext key={i} text={b.text} />
          ) : null
        ) : (
          <BausteinBlock key={i} art={b.art} quelle={quelle} />
        ),
      )}
    </section>
  );
}
