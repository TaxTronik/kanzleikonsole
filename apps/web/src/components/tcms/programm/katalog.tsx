// =============================================================================
// Katalog des Branchenpakets E-Commerce (TCMS Stufe 3, Bereich A; aus der Demo
// staff/admin/katalog/page.tsx): Risiken, Kontrollvorlagen, Ereignistypen,
// Häufigkeitsmatrix und Profilfragen – nur Lesen, ausschließlich aus
// @taxtronik/tcms-domain (kein Dienstaufruf). Katalogwerte, Normanker und die
// Startwerte der Matrix sind ungeprüfte Entwürfe des TCMS-Repos.
// =============================================================================

import { KeyRound } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  AUSFUEHRUNG_LABEL,
  BEWERTUNGSMODELL_VERSION,
  brutto,
  EREIGNISTYPEN,
  fmtEur,
  FOLGE_LABEL,
  GOVERNANCE_LABEL,
  GRUPPE_LABEL,
  KATALOG_KONTROLLEN,
  KATALOG_RISIKEN,
  KERN_RISIKEN,
  klasseAusScore,
  kontrollenFuerRisiko,
  KONTROLLART_LABEL,
  MATRIX_ZEILEN,
  NORMSTUFE_LABEL,
  PAKET,
  PARTEI_LABEL,
  PROFIL_FRAGEN,
  REICHWEITE_LABEL,
  SCHADEN_LABEL,
  SCHAEDEN,
  score,
  WAHRSCHEINLICHKEIT_LABEL,
  WAHRSCHEINLICHKEITEN,
  type NormStufe,
  type RisikoGruppe,
} from '@taxtronik/tcms-domain';
import { GtBadge, KlasseBadge } from '../badges';
import { KatalogIcon } from '../icon';
import { tonChip } from '../ton';
import { TcmsText } from '@/components/tcms/text';

export const KATALOG_TABS = [
  { key: 'risiken', label: 'Risiken', anzahl: KATALOG_RISIKEN.length },
  { key: 'kontrollen', label: 'Kontrollen', anzahl: KATALOG_KONTROLLEN.length },
  { key: 'ereignisse', label: 'Ereignistypen', anzahl: EREIGNISTYPEN.length },
  { key: 'matrix', label: 'Häufigkeitsmatrix & Bewertung', anzahl: null },
  { key: 'profil', label: 'Profilfragen', anzahl: PROFIL_FRAGEN.length },
] as const;

export type KatalogTab = (typeof KATALOG_TABS)[number]['key'];

export function katalogTab(roh: string | undefined): KatalogTab {
  return KATALOG_TABS.find((t) => t.key === roh)?.key ?? 'risiken';
}

const NORMSTUFE_TON: Readonly<Record<NormStufe, string>> = {
  GEPRUEFT: 'badge-green',
  UNGEPRUEFT: 'badge-yellow',
  KI_VERMUTUNG: 'badge-purple',
};

const W_KURZ: Readonly<Record<string, string>> = {
  SELTEN: 'selten',
  MOEGLICH: 'möglich',
  WAHRSCHEINLICH: 'wahrsch.',
  HAEUFIG: 'häufig',
};

const TD = 'px-3 py-2 align-top border-t border-default';

function Tabelle({
  beschriftung,
  kopf,
  children,
  fuss,
}: {
  beschriftung: string;
  kopf: readonly string[];
  children: ReactNode;
  fuss?: ReactNode;
}) {
  return (
    <section className="card overflow-hidden" aria-label={beschriftung}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{beschriftung}</caption>
          <thead>
            <tr>
              {kopf.map((k) => (
                <th key={k} scope="col" className="th">
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
      {fuss ? <div className="card-footer flex flex-wrap justify-between gap-2">{fuss}</div> : null}
    </section>
  );
}

export function KatalogKennzahlen() {
  return (
    <ul className="mini-kpis mb-4">
      <li className="mini-kpi">
        <div className="v">
          <TcmsText>{PAKET.name}</TcmsText> v{PAKET.version}
        </div>
        <div className="l">Paket · Status Entwurf</div>
      </li>
      <li className="mini-kpi">
        <div className="v">{KATALOG_RISIKEN.length}</div>
        <div className="l">Risiken, davon {KERN_RISIKEN.length} Kernrisiken</div>
      </li>
      <li className="mini-kpi">
        <div className="v">{KATALOG_KONTROLLEN.length}</div>
        <div className="l">
          Kontrollvorlagen, davon {KATALOG_KONTROLLEN.filter((k) => k.schluessel).length} Schlüssel
        </div>
      </li>
      <li className="mini-kpi">
        <div className="v">{EREIGNISTYPEN.length}</div>
        <div className="l">Ereignistypen</div>
      </li>
      <li className="mini-kpi">
        <div className="v font-mono">{BEWERTUNGSMODELL_VERSION}</div>
        <div className="l">Bewertungsmodell</div>
      </li>
    </ul>
  );
}

export function RisikenTab() {
  const gruppen: RisikoGruppe[] = ['UST', 'GOB', 'ERT', 'VER'];
  return (
    <Tabelle
      beschriftung="Risikokatalog"
      kopf={[
        'ID',
        'Fehlerquelle → Folge',
        'Normanker (ungeprüft)',
        'Anwendbar wenn',
        'GT',
        'S / W / R',
        'Brutto',
        'Kontrollen',
      ]}
      fuss={
        <>
          <span>
            S = Schadensintensität (N/M/H), W = Wahrscheinlichkeit, R = Reichweite; GT =
            Governance-Typ. Brutto-Startwert nach Modell {BEWERTUNGSMODELL_VERSION}.
          </span>
          <span>Kontrollen als Nummer K-EC-nn</span>
        </>
      }
    >
      {gruppen.flatMap((g) => {
        const liste = KATALOG_RISIKEN.filter((r) => r.gruppe === g);
        return [
          <tr key={`g-${g}`}>
            <th
              scope="colgroup"
              colSpan={8}
              className="px-3 py-2 text-left text-xs font-semibold text-secondary bg-surface-raised"
            >
              {GRUPPE_LABEL[g]} · {liste.length}
            </th>
          </tr>,
          ...liste.map((r) => {
            const b = brutto(r.s, r.w, r.r);
            return (
              <tr key={r.code}>
                <th scope="row" className={`${TD} text-left font-normal whitespace-nowrap`}>
                  <span className="font-mono text-xs font-semibold">{r.code}</span>
                  {r.kern ? <span className="badge-brand block mt-1 w-fit">Kern</span> : null}
                </th>
                <td className={`${TD} min-w-[16rem]`}>
                  <span className="block font-medium">
                    <TcmsText>{r.titel}</TcmsText>
                  </span>
                  <span className="block text-xs text-muted mt-1">
                    <TcmsText>{r.fehlerquelle}</TcmsText> → <TcmsText>{r.folge}</TcmsText>
                  </span>
                  {r.wirktAuf.length ? (
                    <span className="block text-xs text-muted mt-1">
                      wirkt auf {r.wirktAuf.join(', ')}
                    </span>
                  ) : null}
                </td>
                <td className={`${TD} min-w-[13rem]`}>
                  {r.normanker.length ? (
                    <ul className="space-y-1">
                      {r.normanker.map((n) => (
                        <li key={n.text} className="flex items-start gap-1.5 text-xs">
                          <span className={`${NORMSTUFE_TON[n.stufe]} shrink-0`}>
                            {NORMSTUFE_LABEL[n.stufe]}
                          </span>
                          <span>
                            <TcmsText>{n.text}</TcmsText>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-muted">–</span>
                  )}
                </td>
                <td className={`${TD} text-xs text-secondary min-w-[8rem]`}>
                  <TcmsText>{r.anwendbarWenn}</TcmsText>
                </td>
                <td className={TD}>
                  <GtBadge gt={r.gt} />
                </td>
                <td
                  className={`${TD} text-xs whitespace-nowrap`}
                  title={`S ${SCHADEN_LABEL[r.s]} · W ${WAHRSCHEINLICHKEIT_LABEL[r.w]} · R ${REICHWEITE_LABEL[r.r]}`}
                >
                  {r.s} / {W_KURZ[r.w]} / {r.r}
                  <span className="sr-only">
                    {' '}
                    (Schaden {SCHADEN_LABEL[r.s]}, Wahrscheinlichkeit{' '}
                    {WAHRSCHEINLICHKEIT_LABEL[r.w]}, Reichweite {REICHWEITE_LABEL[r.r]})
                  </span>
                </td>
                <td className={TD}>
                  <KlasseBadge klasse={b.klasse} title={b.erklaerung} />
                </td>
                <td className={`${TD} text-xs font-mono`}>
                  {kontrollenFuerRisiko(r.code)
                    .map((k) => k.code.replace('K-EC-', ''))
                    .join(', ') || '–'}
                </td>
              </tr>
            );
          }),
        ];
      })}
    </Tabelle>
  );
}

export function KontrollenTab() {
  return (
    <Tabelle
      beschriftung="Kontrollvorlagen"
      kopf={[
        'ID',
        'Kontrolle',
        'Art',
        'Ausf.',
        'Frequenz (Vorlage)',
        'Partei',
        'Nachweis',
        'Toleranz',
        'Risiken',
      ]}
      fuss={
        <>
          <span>
            Art: P präventiv, D detektiv, K korrigierend · Ausführung: M manuell, IT IT-gestützt, A
            automatisiert.
          </span>
          <span>Maßgeblich ist die strengere Frequenz aus Vorlage und Häufigkeitsmatrix.</span>
        </>
      }
    >
      {KATALOG_KONTROLLEN.map((k) => (
        <tr key={k.code}>
          <th scope="row" className={`${TD} text-left font-normal whitespace-nowrap`}>
            <span className="font-mono text-xs font-semibold">{k.code}</span>
            {k.schluessel ? (
              <span className="badge-brand gap-1 mt-1 w-fit flex">
                <KeyRound className="h-3 w-3" aria-hidden="true" /> Schlüssel
              </span>
            ) : null}
          </th>
          <td className={`${TD} min-w-[16rem]`}>
            <span className="block font-medium">
              <TcmsText>{k.titel}</TcmsText>
            </span>
            <span className="block text-xs text-muted mt-1">
              <TcmsText>{k.ziel}</TcmsText>
            </span>
            <span className="block text-xs text-muted mt-1">
              {k.schritte.length} Schritte
              {k.kennzahlen.length ? ` · ${k.kennzahlen.length} Kennzahlen` : ''} · fällig{' '}
              {k.faelligNachTagen} Tage nach Periodenende
            </span>
          </td>
          <td className={TD}>
            <abbr className="badge-gray font-mono no-underline" title={KONTROLLART_LABEL[k.art]}>
              {k.art}
            </abbr>
          </td>
          <td className={`${TD} text-xs`}>
            <abbr className="no-underline" title={AUSFUEHRUNG_LABEL[k.ausfuehrung]}>
              {k.ausfuehrung}
            </abbr>
          </td>
          <td className={`${TD} text-xs min-w-[7rem]`}>
            <TcmsText>{k.frequenzText}</TcmsText>
          </td>
          <td className={`${TD} text-xs min-w-[6rem]`}>
            {PARTEI_LABEL[k.partei]}
            {k.review ? <span className="block text-muted">{k.review}</span> : null}
          </td>
          <td className={`${TD} text-xs text-secondary min-w-[10rem]`}>
            <TcmsText>{k.nachweis}</TcmsText>
            <span className="block text-muted">mind. {k.mindestNachweise} Datei(en)</span>
          </td>
          <td className={`${TD} text-xs font-mono whitespace-nowrap`}>
            {k.toleranzEur != null ? fmtEur(k.toleranzEur) : '–'}
          </td>
          <td className={`${TD} text-xs font-mono min-w-[7rem]`}>{k.risiken.join(', ') || '–'}</td>
        </tr>
      ))}
    </Tabelle>
  );
}

export function EreignisseTab() {
  return (
    <Tabelle
      beschriftung="Ereignistypen"
      kopf={[
        'ID',
        'Ereignis',
        'Quelle Stufe 1',
        'Folge im Modul',
        'Vorgeschlagene Folgen (Triage)',
        'Portal',
      ]}
      fuss={
        <span>
          Jedes Ereignis wird triagiert; erledigt ist es erst, wenn jede Folge erledigt oder
          begründet verworfen ist.
        </span>
      }
    >
      {EREIGNISTYPEN.map((e) => (
        <tr key={e.code}>
          <th scope="row" className={`${TD} text-left font-normal whitespace-nowrap`}>
            <span className="flex items-center gap-2">
              <span className={`kpi-chip ${tonChip(e.ton)}`} aria-hidden="true">
                <KatalogIcon name={e.icon} />
              </span>
              <span className="font-mono text-xs font-semibold">{e.code}</span>
            </span>
          </th>
          <td className={`${TD} font-medium min-w-[12rem]`}>
            <TcmsText>{e.titel}</TcmsText>
          </td>
          <td className={`${TD} text-xs text-secondary min-w-[9rem]`}>
            <TcmsText>{e.quelleStufe1}</TcmsText>
          </td>
          <td className={`${TD} text-xs text-secondary min-w-[11rem]`}>
            <TcmsText>{e.folgeText}</TcmsText>
          </td>
          <td className={`${TD} min-w-[16rem]`}>
            <ul className="space-y-1">
              {e.folgen.map((f, i) => (
                <li key={i} className="text-xs">
                  <span className="font-medium">{FOLGE_LABEL[f.art]}</span>
                  {f.ziel ? (
                    <span className="font-mono text-muted">
                      {' '}
                      · <TcmsText>{f.ziel}</TcmsText>
                    </span>
                  ) : null}
                  <span className="text-muted">
                    {' '}
                    – <TcmsText>{f.text}</TcmsText>
                  </span>
                </li>
              ))}
            </ul>
          </td>
          <td className={`${TD} text-xs`}>
            {e.portal ? (
              <span className="badge-green">{e.portalLabel ?? 'ja'}</span>
            ) : (
              <span className="text-muted">–</span>
            )}
          </td>
        </tr>
      ))}
    </Tabelle>
  );
}

export function MatrixTab() {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
      <div className="xl:col-span-12">
        <Tabelle
          beschriftung="Häufigkeitsmatrix Governance-Typ × Bruttoklasse (Startwerte, zu kalibrieren)"
          kopf={['GT', 'Kontrollzyklus', 'kritisch / hoch', 'mittel', 'gering']}
          fuss={
            <span>
              Maßgeblich ist die Bruttoklasse. Hängt eine Kontrolle an mehreren Risiken, gilt die
              strengste Frequenz; eine Kontrolle unter der Matrixfrequenz braucht Begründung und
              zweite Person.
            </span>
          }
        >
          {MATRIX_ZEILEN.map((z) => (
            <tr key={z.gt}>
              <th scope="row" className={`${TD} text-left font-normal whitespace-nowrap`}>
                <GtBadge gt={z.gt} />{' '}
                <span className="text-xs text-muted">{GOVERNANCE_LABEL[z.gt].split(' · ')[1]}</span>
              </th>
              <td className={`${TD} text-xs text-secondary min-w-[16rem]`}>{z.zyklus}</td>
              <td className={TD}>{z.hoch}</td>
              <td className={TD}>{z.mittel}</td>
              <td className={TD}>{z.gering}</td>
            </tr>
          ))}
        </Tabelle>
      </div>
      <div className="xl:col-span-7">
        <Tabelle
          beschriftung={`Bewertungsmodell ${BEWERTUNGSMODELL_VERSION}: Bruttoklasse aus Schaden und Wahrscheinlichkeit`}
          kopf={['S \\ W', ...WAHRSCHEINLICHKEITEN.map((w) => WAHRSCHEINLICHKEIT_LABEL[w])]}
          fuss={
            <span>
              Reichweite 3 hebt um eine Klasse, höchstens bis kritisch. Der Governance-Typ verändert
              die Klasse nicht.
            </span>
          }
        >
          {SCHAEDEN.map((s) => (
            <tr key={s}>
              <th scope="row" className={`${TD} text-left font-medium`}>
                {s} · {SCHADEN_LABEL[s]}
              </th>
              {WAHRSCHEINLICHKEITEN.map((w) => (
                <td key={w} className={TD}>
                  <span className="flex items-center gap-1.5">
                    <KlasseBadge klasse={klasseAusScore(score(s, w))} />
                    <span className="text-xs text-muted font-mono">({score(s, w)})</span>
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </Tabelle>
      </div>
      <section className="card xl:col-span-5" aria-labelledby="katalog-netto">
        <div className="card-header">
          <h3 id="katalog-netto" className="text-sm font-semibold text-primary">
            Nettoklassen
          </h3>
        </div>
        <dl className="p-4 space-y-3 text-sm">
          <div>
            <dt className="font-medium">Netto (Design)</dt>
            <dd className="text-xs text-secondary mt-1">
              −1 Klasse bei mindestens einer zugeordneten Kontrolle mit Designbeurteilung
              „angemessen“; −2, wenn zusätzlich eine präventive und eine detektive Kontrolle
              angemessen sind oder eine präventive Schlüsselkontrolle besteht. Untergrenze gering.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Netto (Betrieb)</dt>
            <dd className="text-xs text-secondary mt-1">
              Wie Design, der Abschlag zählt aber nur, wenn die letzte fällige Durchführung ohne
              Befund abgeschlossen und gegengezeichnet ist. Überfällig oder mit Befund → Abschlag
              entfällt.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Übersteuerung</dt>
            <dd className="text-xs text-secondary mt-1">
              Begründung (mind. 30 Zeichen) und Freigabe durch eine zweite Person; der berechnete
              Wert bleibt sichtbar.
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

export function ProfilTab() {
  const gruppen = [...new Set(PROFIL_FRAGEN.map((f) => f.gruppe))];
  const bezug = (nr: string) =>
    KATALOG_RISIKEN.filter((r) => {
      const treffer: string[] = r.anwendbarWenn.match(/P\d+/g) ?? [];
      return treffer.includes(nr);
    }).map((r) => r.code);
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
      {gruppen.map((g) => (
        <section key={g} className="card overflow-hidden" aria-label={g}>
          <div className="card-header">
            <h3 className="text-sm font-semibold text-primary">{g}</h3>
          </div>
          <ul>
            {PROFIL_FRAGEN.filter((f) => f.gruppe === g).map((f) => {
              const risiken = bezug(f.nr);
              return (
                <li key={f.nr} className="flex items-start gap-3 border-t border-default px-4 py-2">
                  <span className="badge-gray font-mono shrink-0">{f.nr}</span>
                  <span className="grow">
                    <span className="block text-sm font-medium">
                      <TcmsText>{f.titel}</TcmsText>
                    </span>
                    <span className="block text-xs text-muted mt-1">
                      {risiken.length
                        ? `Anwendbarkeit im Risikokatalog: ${risiken.join(', ')}`
                        : 'Kein direkter Bezug in der Anwendbarkeit der Katalogrisiken'}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <section className="card p-4 xl:col-span-2" aria-labelledby="katalog-regeln">
        <h3 id="katalog-regeln" className="text-sm font-semibold text-primary">
          Regeln für den Risikovorschlag
        </h3>
        <ul className="list-disc pl-5 mt-2 text-xs text-secondary space-y-1">
          <li>Kernrisiken sind immer aktiv: {KERN_RISIKEN.join(', ')}.</li>
          <li>
            Jeder Vorschlag ist deterministisch aus dem Geschäftsprofil abgeleitet und nennt seinen
            Grund; keine KI-Vorschläge.
          </li>
          <li>
            Übernehmen ist ein Klick; Ablehnen verlangt eine Begründung und wird protokolliert.
          </li>
          <li>Jede Profiländerung erzeugt einen neuen Profilstand.</li>
        </ul>
      </section>
    </div>
  );
}
