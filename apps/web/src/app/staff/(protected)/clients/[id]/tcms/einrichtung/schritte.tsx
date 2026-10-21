'use client';

// =============================================================================
// Formulare der fünf Schritte des Einrichtungsassistenten (TCMS Stufe 3,
// Bereich A; aus der Demo components/setup/schritte.tsx und setup-form.tsx).
//
// Jeder Schritt hält seinen Zustand im Browser und sendet ihn als JSON
// (`daten`) an `einrichtungSpeichernAction`; Mandant, Personen der Kanzlei und
// Prüfungen setzt der Server. Startwerte, Vorbelegungen (Kernrisiken,
// Zuständigkeiten) und Frequenzen stammen aus der Antwort des Dienstes; die
// Oberfläche rechnet nichts nach. „Weiter“ prüft den Schritt im Dienst.
// =============================================================================

import { useActionState, useId, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  CheckCheck,
  ChevronRight,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  Save,
  X,
} from 'lucide-react';
import type {
  EntwurfKontrolle,
  EntwurfRisiko,
  EntwurfZiel,
  PlanView,
  SetupEntwurf,
} from '@taxtronik/tcms-contract';
import {
  AUSFUEHRUNG_LABEL,
  frequenzLabel,
  katalogKontrolle,
  katalogRisiko,
  KLASSE_LABEL,
  KONTROLLART_LABEL,
  MIN_BEGRUENDUNG,
  type Geschaeftsprofil,
  type Klasse,
} from '@taxtronik/tcms-domain';
import { fieldErrorProps, FormErrorSummary, FieldError } from '@/components/form-errors';
import { GtBadge, KlasseBadge } from '@/components/tcms/badges';
import type { TcmsAktionsErgebnis } from '@/components/tcms/programm/dialog';
import { dauerText } from '@/components/tcms/programm/einrichtung';
import {
  ProfilFormular,
  TextChips,
  type ProfilPerson,
} from '@/components/tcms/programm/profil-formular';
import { profilFeldBezeichnung } from '@/components/tcms/programm/profil-fehler';
import { confirmFormSubmission } from '@/components/ui/modal';
import { einrichtungSpeichernAction } from './actions';
import { TCMS_TEXT_ISOLIERT, TcmsText } from '@/components/tcms/text';
import {
  empfaengerLabel,
  KEIN_EMPFAENGER_MIT_PORTALZUGANG,
  type Empfaenger,
} from '@/components/tcms/empfaenger';

export interface Person {
  id: string;
  name: string;
}

interface Basis {
  mandantId: string;
  /** Bearbeitungsrecht laut Dienst (`darfBearbeiten`). */
  darf: boolean;
  gesperrtGrund: string;
}

/** Feldfehler mit Bezeichnung (Pfade relativ zu `daten`, bzw. Felder der Personenprüfung). */
export function beschriftet(
  fieldErrors: Record<string, string[]> | undefined,
  labels: ReadonlyArray<Beschriftung>,
): Record<string, string[]> | undefined {
  if (!fieldErrors) return undefined;
  const aus: Record<string, string[]> = {};
  for (const [pfad, meldungen] of Object.entries(fieldErrors)) {
    const eintrag = labels.find(([muster]) => muster.test(pfad))?.[1];
    const label = typeof eintrag === 'function' ? eintrag(pfad) : eintrag;
    aus[pfad] = meldungen.map((m) => (label ? `${label}: ${m}` : m));
  }
  return aus;
}

/** Bezeichnung je Pfadmuster: fester Text oder aus dem Pfad (Geschäftsprofil). */
type Beschriftung = readonly [RegExp, string | ((pfad: string) => string)];

/** Schritt 2: Frage und Feld des Profils (Altbestand, TCMS s8), sonst „Geschäftsprofil“. */
export const PROFIL_LABELS: ReadonlyArray<Beschriftung> = [
  [/^profil\.(p\d+)/, (pfad) => profilFeldBezeichnung(pfad) ?? 'Geschäftsprofil'],
];

const PERSONEN_LABELS = [
  [/^kontrollen/, 'Zuständigkeiten'],
  [/^freigabe/, 'Freigabe der Ziele'],
] as const;

// ---------------------------------------------------------------------------
// Formularrahmen eines Schritts
// ---------------------------------------------------------------------------

function SchrittKnoepfe({
  schritt,
  darf,
  sperre,
  laeuft,
  hinweis,
}: {
  schritt: 1 | 2 | 3 | 4 | 5;
  darf: boolean;
  sperre: string | undefined;
  laeuft: boolean;
  hinweis: ReactNode;
}) {
  const aus = !darf || laeuft;
  return (
    <div className="form-actions border-t border-default px-6 py-3 mt-4 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted mr-auto max-w-prose">{hinweis}</span>
      <button
        type="submit"
        name="ziel"
        value="zurueck"
        className="btn-secondary"
        disabled={aus || schritt === 1}
        title={
          sperre ??
          (schritt === 1 ? 'Erster Schritt' : 'Speichert den Entwurf und geht einen Schritt zurück')
        }
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Zurück
      </button>
      <button
        type="submit"
        name="ziel"
        value="speichern"
        className="btn-secondary"
        disabled={aus}
        title={sperre}
      >
        <Save className="h-4 w-4" aria-hidden="true" /> Entwurf speichern
      </button>
      {schritt === 5 ? (
        <button
          type="submit"
          name="ziel"
          value="anlegen"
          className="btn-primary"
          disabled={aus}
          title={sperre}
        >
          <CheckCheck className="h-4 w-4" aria-hidden="true" /> Tax-CMS Version 1 anlegen
        </button>
      ) : (
        <button
          type="submit"
          name="ziel"
          value="weiter"
          className="btn-primary"
          disabled={aus}
          title={sperre}
        >
          Weiter <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      {laeuft ? (
        <span className="sr-only" role="status">
          Wird gespeichert …
        </span>
      ) : null}
    </div>
  );
}

function SchrittMeldung({
  ergebnis,
  labels,
  fieldIds,
}: {
  ergebnis: TcmsAktionsErgebnis | null;
  labels: ReadonlyArray<Beschriftung>;
  fieldIds: Record<string, string> | undefined;
}) {
  if (!ergebnis) return null;
  if (ergebnis.ok) {
    return (
      <p className="alert-success-sm mx-6 mt-4" role="status">
        {ergebnis.meldung ?? 'Entwurf gespeichert.'}
      </p>
    );
  }
  const fieldErrors = beschriftet(ergebnis.fieldErrors, [...labels, ...PERSONEN_LABELS]);
  return (
    <div className="px-6 pt-4">
      <FormErrorSummary
        title="Der Schritt wurde nicht gespeichert."
        {...(ergebnis.error ? { error: ergebnis.error } : {})}
        {...(fieldErrors ? { fieldErrors } : {})}
        {...(fieldIds ? { fieldIds } : {})}
      />
    </div>
  );
}

const ANLEGEN_TEXT =
  'Version 1 wird mit Risiken, Kontrollen und geplanten Durchführungen angelegt. Danach ist der Assistent geschlossen; Änderungen erfolgen in Profil, Risiken und Kontrollen.';

function SchrittFormular({
  mandantId,
  darf,
  gesperrtGrund,
  schritt,
  daten,
  hinweis,
  labels = [],
  fieldIds,
  children,
}: Basis & {
  schritt: 1 | 2 | 3 | 4 | 5;
  daten: unknown;
  hinweis: ReactNode;
  labels?: ReadonlyArray<Beschriftung>;
  fieldIds?: Record<string, string>;
  children: (fieldErrors: Record<string, string[]> | undefined) => ReactNode;
}) {
  const [ergebnis, aktion, laeuft] = useActionState<TcmsAktionsErgebnis | null, FormData>(
    einrichtungSpeichernAction.bind(null, mandantId),
    null,
  );
  const fieldErrors = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;

  function bestaetigen(event: FormEvent<HTMLFormElement>) {
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (submitter instanceof HTMLButtonElement && submitter.value === 'anlegen') {
      confirmFormSubmission(event, ANLEGEN_TEXT, {
        title: 'Tax-CMS Version 1 anlegen?',
        confirmLabel: 'Version 1 anlegen',
      });
    }
  }

  return (
    <form action={aktion} onSubmit={bestaetigen} aria-busy={laeuft || undefined}>
      <input type="hidden" name="schritt" value={schritt} />
      <input type="hidden" name="daten" value={JSON.stringify(daten)} />
      <SchrittMeldung ergebnis={ergebnis} labels={labels} fieldIds={fieldIds} />
      <fieldset disabled={!darf} className="min-w-0 border-0 p-0 m-0">
        <legend className="sr-only">Angaben zu Schritt {schritt}</legend>
        {children(fieldErrors)}
      </fieldset>
      <SchrittKnoepfe
        schritt={schritt}
        darf={darf}
        sperre={darf ? undefined : gesperrtGrund}
        laeuft={laeuft}
        hinweis={hinweis}
      />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Schritt 1: Teilbereich und Zeiträume
// ---------------------------------------------------------------------------

export function SchrittTeilbereich({
  start,
  paket,
  ...b
}: Basis & {
  start: Pick<SetupEntwurf, 'teilbereich' | 'zeitraum'>;
  paket: { name: string; version: string; risiken: number; kontrollen: number; fragen: number };
}) {
  const id = useId();
  const [tb, setTb] = useState(start.teilbereich);
  const [zr, setZr] = useState(start.zeitraum);
  const dauer = dauerText(zr.wirksamAb, zr.wirksamBis);
  const ids = {
    'teilbereich.name': `${id}-name`,
    'teilbereich.abgrenzung': `${id}-abgrenzung`,
    'zeitraum.angemessenheitStichtag': `${id}-stichtag`,
    'zeitraum.wirksamAb': `${id}-ab`,
    'zeitraum.wirksamBis': `${id}-bis`,
    'zeitraum.erklaerungsTurnus': `${id}-turnus`,
  };
  return (
    <SchrittFormular
      {...b}
      schritt={1}
      daten={{ teilbereich: tb, zeitraum: zr }}
      hinweis="Entwurf jederzeit speicherbar; noch keine Version angelegt. „Weiter“ prüft den Schritt im Tax-CMS."
      fieldIds={ids}
      labels={[
        [/^teilbereich\.name/, 'Teilbereich'],
        [/^teilbereich\.abgrenzung/, 'Abgrenzungstext'],
        [/^teilbereich\.(ein|aus)schluesse/, 'Ein-/Ausschlüsse'],
        [/^zeitraum/, 'Zeiträume'],
      ]}
    >
      {(fe) => (
        <div className="px-6 py-4 space-y-4">
          <fieldset className="space-y-2">
            <legend className="label">Paketvorlage</legend>
            <div className="card flex items-start gap-3 px-4 py-3 border-brand-300">
              <input
                id={`${id}-paket`}
                type="radio"
                name="paket"
                checked
                readOnly
                className="mt-1"
              />
              <label htmlFor={`${id}-paket`}>
                <span className="block text-sm font-semibold text-primary">
                  <TcmsText>{tb.name}</TcmsText>
                </span>
                <span className="block text-xs text-muted">
                  Paket „<TcmsText>{paket.name}</TcmsText> v{paket.version}“ · {paket.risiken}{' '}
                  Risiken · {paket.kontrollen} Kontrollvorlagen · {paket.fragen} Profilfragen
                </span>
              </label>
            </div>
            {['Organschaft', 'Lohnsteuer'].map((n) => (
              <div key={n} className="card flex items-start gap-3 px-4 py-3 opacity-70">
                <input
                  id={`${id}-paket-${n}`}
                  type="radio"
                  name="paket"
                  disabled
                  className="mt-1"
                />
                <label htmlFor={`${id}-paket-${n}`}>
                  <span className="block text-sm font-semibold text-muted">{n} (geplant)</span>
                  <span className="block text-xs text-muted">
                    Paket in Vorbereitung – noch nicht verfügbar.
                  </span>
                </label>
              </div>
            ))}
          </fieldset>

          <div>
            <label className="label" htmlFor={ids['teilbereich.name']}>
              Bezeichnung des Teilbereichs
            </label>
            <input
              id={ids['teilbereich.name']}
              className="input"
              maxLength={200}
              value={tb.name}
              onChange={(e) => setTb({ ...tb, name: e.target.value })}
              {...fieldErrorProps('teilbereich.name', fe, { prefix: id })}
            />
            <FieldError name="teilbereich.name" errors={fe?.['teilbereich.name']} prefix={id} />
          </div>

          <div>
            <label className="label" htmlFor={ids['teilbereich.abgrenzung']}>
              Abgrenzungstext
            </label>
            <textarea
              {...TCMS_TEXT_ISOLIERT}
              id={ids['teilbereich.abgrenzung']}
              className="input"
              rows={4}
              maxLength={4000}
              value={tb.abgrenzung}
              onChange={(e) => setTb({ ...tb, abgrenzung: e.target.value })}
              {...fieldErrorProps('teilbereich.abgrenzung', fe, {
                prefix: id,
                describedBy: `${id}-abgrenzung-hint`,
              })}
            />
            <p id={`${id}-abgrenzung-hint`} className="hint">
              Erscheint in der CMS-Beschreibung, Abschnitt 0 „Teilbereich und Abgrenzung“. Die
              Abgrenzung verantworten die gesetzlichen Vertreter.
            </p>
            <FieldError
              name="teilbereich.abgrenzung"
              errors={fe?.['teilbereich.abgrenzung']}
              prefix={id}
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="label">Ein- und Ausschlüsse</legend>
            <div className="flex flex-wrap items-start gap-2">
              <span className="badge-green shrink-0 mt-1">Einschluss</span>
              <TextChips
                label="Einschluss hinzufügen"
                werte={tb.einschluesse}
                onChange={(w) => setTb({ ...tb, einschluesse: w })}
              />
            </div>
            <div className="flex flex-wrap items-start gap-2">
              <span className="badge-gray shrink-0 mt-1">Ausschluss</span>
              <TextChips
                label="Ausschluss hinzufügen"
                werte={tb.ausschluesse}
                onChange={(w) => setTb({ ...tb, ausschluesse: w })}
              />
            </div>
          </fieldset>

          <fieldset>
            <legend className="label">Zeiträume und Erklärungsturnus</legend>
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="label-sm" htmlFor={ids['zeitraum.angemessenheitStichtag']}>
                  Angemessenheit zum Stichtag
                </label>
                <input
                  id={ids['zeitraum.angemessenheitStichtag']}
                  type="date"
                  className="input w-auto"
                  value={zr.angemessenheitStichtag}
                  onChange={(e) => setZr({ ...zr, angemessenheitStichtag: e.target.value })}
                  {...fieldErrorProps('zeitraum.angemessenheitStichtag', fe, { prefix: id })}
                />
              </div>
              <div>
                <label className="label-sm" htmlFor={ids['zeitraum.wirksamAb']}>
                  Wirksamkeitszeitraum von
                </label>
                <input
                  id={ids['zeitraum.wirksamAb']}
                  type="date"
                  className="input w-auto"
                  value={zr.wirksamAb}
                  onChange={(e) => setZr({ ...zr, wirksamAb: e.target.value })}
                  {...fieldErrorProps('zeitraum.wirksamAb', fe, { prefix: id })}
                />
              </div>
              <div>
                <label className="label-sm" htmlFor={ids['zeitraum.wirksamBis']}>
                  bis
                </label>
                <input
                  id={ids['zeitraum.wirksamBis']}
                  type="date"
                  className="input w-auto"
                  value={zr.wirksamBis}
                  onChange={(e) => setZr({ ...zr, wirksamBis: e.target.value })}
                  {...fieldErrorProps('zeitraum.wirksamBis', fe, { prefix: id })}
                />
              </div>
              <div>
                <label className="label-sm" htmlFor={ids['zeitraum.erklaerungsTurnus']}>
                  Erklärungsturnus (UStVA)
                </label>
                <select
                  id={ids['zeitraum.erklaerungsTurnus']}
                  className="input w-auto"
                  value={zr.erklaerungsTurnus}
                  onChange={(e) =>
                    setZr({
                      ...zr,
                      erklaerungsTurnus: e.target
                        .value as SetupEntwurf['zeitraum']['erklaerungsTurnus'],
                    })
                  }
                >
                  <option value="MONATLICH">monatlich</option>
                  <option value="QUARTALSWEISE">quartalsweise</option>
                  <option value="JAEHRLICH">jährlich</option>
                </select>
              </div>
            </div>
            <p className="hint" aria-live="polite">
              {dauer ? `Wirksamkeitszeitraum: ${dauer}. ` : ''}Regelmäßig mindestens ein halbes
              Geschäftsjahr (vgl. Tz. 61); Beginn nach dem Angemessenheits-Stichtag. Der
              Erklärungsturnus bestimmt „jede Periode“ der Häufigkeitsmatrix (FP).
            </p>
          </fieldset>
        </div>
      )}
    </SchrittFormular>
  );
}

// ---------------------------------------------------------------------------
// Schritt 2: Geschäftsprofil
// ---------------------------------------------------------------------------

export function SchrittProfil({
  start,
  personen,
  heuteIso,
  ...b
}: Basis & { start: Geschaeftsprofil; personen: readonly ProfilPerson[]; heuteIso: string }) {
  const [profil, setProfil] = useState(start);
  return (
    <SchrittFormular
      {...b}
      schritt={2}
      daten={{ profil }}
      hinweis="Änderungen am Profil setzen Risiko- und Kontrollvorschlag neu auf."
      labels={PROFIL_LABELS}
    >
      {() => (
        <div className="px-6 py-4">
          <ProfilFormular
            wert={profil}
            onChange={setProfil}
            personen={personen}
            heuteIso={heuteIso}
          />
        </div>
      )}
    </SchrittFormular>
  );
}

// ---------------------------------------------------------------------------
// Schritt 3: Compliance-Ziele
// ---------------------------------------------------------------------------

const APPETITE = ['MITTEL', 'HOCH', 'GERING'] as const;

export function SchrittZiele({
  start,
  gv,
  ...b
}: Basis & {
  start: Pick<SetupEntwurf, 'ziele' | 'freigabe'>;
  /**
   * Gesetzliche Vertretungen (Kontakte dieses Mandanten mit Rolle im Tax-CMS)
   * mit Kennzeichen für den aktiven Portalzugang (kk-tcms-s11).
   */
  gv: readonly Empfaenger[];
}) {
  const id = useId();
  const mitZugang = gv.filter((p) => p.portal);
  const [ziele, setZiele] = useState<EntwurfZiel[]>(start.ziele);
  const [freigabe, setFreigabe] = useState(start.freigabe);
  const [bearbeiten, setBearbeiten] = useState<string | null>(null);
  const aendere = (key: string, teil: Partial<EntwurfZiel>) =>
    setZiele(ziele.map((z) => (z.key === key ? { ...z, ...teil } : z)));
  return (
    <SchrittFormular
      {...b}
      schritt={3}
      daten={{ ziele, freigabe }}
      hinweis="Ziele und Risikoappetit entscheidet der Mandant; die Kanzlei bereitet vor."
      labels={[
        [/^ziele/, 'Compliance-Ziele'],
        [/^freigabe/, 'Freigabe der Ziele'],
      ]}
      fieldIds={{ freigabe: `${id}-empfaenger` }}
    >
      {() => (
        <div className="px-6 py-4">
          <ul className="space-y-3">
            {ziele.map((z, i) => {
              const nr = i + 1;
              return (
                <li key={z.key} className={`card p-3 ${z.aktiv ? '' : 'opacity-70'}`}>
                  <div className="flex items-start gap-2 mb-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={z.aktiv}
                      aria-label={`Ziel ${nr} übernehmen`}
                      onChange={(e) => aendere(z.key, { aktiv: e.target.checked })}
                    />
                    {z.eigen || bearbeiten === z.key ? (
                      <textarea
                        {...TCMS_TEXT_ISOLIERT}
                        className="input grow"
                        rows={2}
                        maxLength={1000}
                        placeholder="Ziel formulieren …"
                        aria-label={`Ziel ${nr}: Text`}
                        value={z.text}
                        onChange={(e) => aendere(z.key, { text: e.target.value })}
                      />
                    ) : (
                      <p className="text-sm font-semibold grow">
                        <TcmsText>{z.text}</TcmsText>
                      </p>
                    )}
                    {z.eigen ? (
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Ziel ${nr} entfernen`}
                        title="Ziel entfernen"
                        onClick={() => setZiele(ziele.filter((x) => x.key !== z.key))}
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={
                          bearbeiten === z.key
                            ? `Ziel ${nr}: Bearbeitung beenden`
                            : `Ziel ${nr}: Text anpassen`
                        }
                        aria-pressed={bearbeiten === z.key}
                        onClick={() => setBearbeiten(bearbeiten === z.key ? null : z.key)}
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div className="flex flex-wrap items-end gap-4">
                      <div>
                        <label className="label-sm" htmlFor={`${id}-w-${z.key}`}>
                          Wesentlichkeitsgrenze (€)
                        </label>
                        <input
                          id={`${id}-w-${z.key}`}
                          type="number"
                          min={0}
                          step={100}
                          className="input w-32 text-right font-mono"
                          value={z.wesentlichkeitEur}
                          onChange={(e) =>
                            aendere(z.key, {
                              wesentlichkeitEur:
                                e.target.value === '' ? 0 : Math.round(Number(e.target.value)),
                            })
                          }
                        />
                      </div>
                      <div>
                        <label className="label-sm" htmlFor={`${id}-a-${z.key}`}>
                          Risikoappetit
                        </label>
                        <select
                          id={`${id}-a-${z.key}`}
                          className="input w-auto"
                          value={z.risikoappetit}
                          onChange={(e) =>
                            aendere(z.key, {
                              risikoappetit: e.target.value as EntwurfZiel['risikoappetit'],
                            })
                          }
                        >
                          {APPETITE.map((a) => (
                            <option key={a} value={a}>
                              {KLASSE_LABEL[a]}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {!z.aktiv ? (
                      <span className="badge-gray">nicht übernommen</span>
                    ) : freigabe.anfordern ? (
                      <span className="badge-yellow">Mandantenfreigabe ausstehend</span>
                    ) : (
                      <span className="badge-gray">ohne Freigabeanforderung</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="mt-2">
            <button
              type="button"
              className="btn-secondary text-xs py-1"
              onClick={() =>
                setZiele([
                  ...ziele,
                  {
                    key: `eigen-${Date.now().toString(36)}`,
                    text: '',
                    wesentlichkeitEur: 0,
                    risikoappetit: 'MITTEL',
                    aktiv: true,
                    eigen: true,
                  },
                ])
              }
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Eigenes Ziel hinzufügen
            </button>
          </div>
          <fieldset className="card p-3 mt-4">
            <legend className="sr-only">Freigabe der Ziele</legend>
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={freigabe.anfordern}
                  disabled={mitZugang.length === 0 && !freigabe.anfordern}
                  onChange={(e) =>
                    setFreigabe({
                      anfordern: e.target.checked,
                      empfaengerId: freigabe.empfaengerId ?? mitZugang[0]?.id ?? null,
                    })
                  }
                />
                Freigabe beim Mandanten anfordern
              </label>
              {freigabe.anfordern ? (
                <span className="inline-flex items-center gap-2">
                  <label htmlFor={`${id}-empfaenger`} className="text-sm text-secondary">
                    Empfänger
                  </label>
                  <select
                    id={`${id}-empfaenger`}
                    className="input w-auto"
                    value={freigabe.empfaengerId ?? ''}
                    onChange={(e) =>
                      setFreigabe({ ...freigabe, empfaengerId: e.target.value || null })
                    }
                  >
                    <option value="">Bitte wählen …</option>
                    {gv.map((p) => (
                      <option {...TCMS_TEXT_ISOLIERT} key={p.id} value={p.id} disabled={!p.portal}>
                        {empfaengerLabel(p.name, p.portal, ' (gesetzliche Vertretung)')}
                      </option>
                    ))}
                  </select>
                </span>
              ) : null}
            </div>
            <p className="hint">
              {gv.length === 0
                ? 'Für diesen Mandanten ist im Tax-CMS keine gesetzliche Vertretung hinterlegt (Kontakte & Rollen); die Freigabe kann später angefordert werden.'
                : mitZugang.length === 0
                  ? `${KEIN_EMPFAENGER_MIT_PORTALZUGANG} Die Freigabe kann später angefordert werden.`
                  : 'Die Anforderung entsteht mit Version 1; die Freigabe erteilt die gesetzliche Vertretung im Mandantenportal (Bestätigung per E-Mail-Code).'}
            </p>
          </fieldset>
        </div>
      )}
    </SchrittFormular>
  );
}

// ---------------------------------------------------------------------------
// Schritt 4: Risikovorschlag
// ---------------------------------------------------------------------------

export function SchrittRisiken({
  plan,
  ...b
}: Basis & { plan: Pick<PlanView, 'risiken' | 'nichtVorgeschlagen' | 'appetit'> }) {
  const id = useId();
  const [risiken, setRisiken] = useState<Record<string, EntwurfRisiko>>(() =>
    Object.fromEntries(
      plan.risiken.map((r) => [
        r.code,
        { uebernehmen: r.kern || r.uebernehmen, begruendung: r.kern ? '' : r.begruendung },
      ]),
    ),
  );
  const setze = (code: string, teil: Partial<EntwurfRisiko>) =>
    setRisiken({ ...risiken, [code]: { ...risiken[code]!, ...teil } });
  const uebernommen = plan.risiken.filter((r) => risiken[r.code]?.uebernehmen).length;
  return (
    <SchrittFormular
      {...b}
      schritt={4}
      daten={{ risiken }}
      hinweis={`${uebernommen} von ${plan.risiken.length} übernommen · Risikoappetit ${KLASSE_LABEL[plan.appetit]}`}
      labels={[[/^risiken/, 'Risikoentscheidung']]}
    >
      {() => (
        <div className="pt-2">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Vorgeschlagene Risiken</caption>
              <thead>
                <tr>
                  <th scope="col" className="th w-28">
                    Übernehmen
                  </th>
                  <th scope="col" className="th">
                    Risiko
                  </th>
                  <th scope="col" className="th">
                    Grund
                  </th>
                  <th scope="col" className="th">
                    GT
                  </th>
                  <th scope="col" className="th">
                    Brutto
                  </th>
                  <th scope="col" className="th">
                    <span className="sr-only">Hinweis</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {plan.risiken.map((z) => {
                  const r = risiken[z.code]!;
                  const laenge = r.begruendung.trim().length;
                  const zuKurz = !r.uebernehmen && laenge < MIN_BEGRUENDUNG;
                  const begruendungId = `${id}-b-${z.code}`;
                  return (
                    <tr key={z.code} className="border-t border-default align-top">
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          checked={r.uebernehmen}
                          disabled={z.kern}
                          aria-label={`${z.code} übernehmen${z.kern ? ' (Kernrisiko, immer aktiv)' : ''}`}
                          onChange={(e) => setze(z.code, { uebernehmen: e.target.checked })}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <span className={r.uebernehmen ? 'font-medium' : 'text-muted'}>
                          {z.code} · <TcmsText>{z.titel}</TcmsText>
                        </span>
                        {!r.uebernehmen ? (
                          <div className="mt-2">
                            <label className="label-sm" htmlFor={begruendungId}>
                              Begründung der Ablehnung
                            </label>
                            <textarea
                              {...TCMS_TEXT_ISOLIERT}
                              id={begruendungId}
                              className="input min-w-[20rem]"
                              rows={2}
                              maxLength={2000}
                              placeholder={`mindestens ${MIN_BEGRUENDUNG} Zeichen`}
                              aria-describedby={`${begruendungId}-zaehler`}
                              aria-invalid={zuKurz || undefined}
                              value={r.begruendung}
                              onChange={(e) => setze(z.code, { begruendung: e.target.value })}
                            />
                            <p
                              id={`${begruendungId}-zaehler`}
                              className={`flex justify-between gap-2 text-xs mt-1 ${zuKurz ? 'text-red-700 dark:text-red-400' : 'text-muted'}`}
                            >
                              <span>
                                Ablehnen erfordert eine Begründung; sie wird mit Name und Zeitpunkt
                                protokolliert.
                              </span>
                              <span className="font-mono">
                                {laenge}/{MIN_BEGRUENDUNG}
                              </span>
                            </p>
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2">
                        {r.uebernehmen ? (
                          <span
                            className="badge-brand"
                            title={`Profilantwort ${z.frage}`}
                            {...TCMS_TEXT_ISOLIERT}
                          >
                            {z.grund}
                          </span>
                        ) : (
                          <span className="badge-gray">nicht übernommen</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {r.uebernehmen ? (
                          <GtBadge gt={z.gt} />
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {r.uebernehmen ? (
                          <KlasseBadge
                            klasse={z.brutto}
                            title="Brutto-Startwert aus dem Bewertungsmodell"
                          />
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {z.kern ? (
                          <span className="badge-gray gap-1">
                            <Lock className="h-3 w-3" aria-hidden="true" /> Kern
                          </span>
                        ) : r.uebernehmen && z.ueberAppetit ? (
                          <span className="text-muted whitespace-nowrap">über Appetit</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-6 pt-3 space-y-3">
            <p className="alert-info-sm text-sm" role="note">
              Kernrisiken sind immer aktiv und können nicht abgelehnt werden. Ablehnen erfordert
              eine Begründung und wird protokolliert. Brutto-Startwerte stammen aus dem
              Bewertungsmodell und sind vom Berufsträger zu kalibrieren.
            </p>
            {plan.nichtVorgeschlagen.length ? (
              <details className="details-box">
                <summary>
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />{' '}
                  {plan.nichtVorgeschlagen.length} Katalogrisiken laut Profil nicht vorgeschlagen
                </summary>
                <ul className="details-body space-y-1">
                  {plan.nichtVorgeschlagen.map((n) => (
                    <li key={n.code} className="flex flex-wrap justify-between gap-2 text-sm">
                      <span>
                        <span className="font-mono text-muted">{n.code}</span>{' '}
                        <TcmsText>{n.titel}</TcmsText>
                      </span>
                      {katalogRisiko(n.code)?.anwendbarWenn ? (
                        <span className="text-xs text-muted">
                          anwendbar wenn <TcmsText>{katalogRisiko(n.code)!.anwendbarWenn}</TcmsText>
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </div>
      )}
    </SchrittFormular>
  );
}

// ---------------------------------------------------------------------------
// Schritt 5: Kontrollvorschlag
// ---------------------------------------------------------------------------

type PlanKontrolle = PlanView['kontrollen'][number];

export interface KontrollGruppe {
  /** Frequenzbestimmendes Risiko der Gruppe; null = ohne Risikobezug. */
  code: string | null;
  titel: string;
  brutto: Klasse | null;
  kontrollen: PlanKontrolle[];
}

/** Platzhalter ohne Person (TCMS s10: unbekannte Personen kommen als `null`). */
export const PERSON_BITTE_WAEHLEN = 'Bitte wählen …';
export const OHNE_VERTRETUNG = 'keine Vertretung';
export const OHNE_GEGENZEICHNUNG = 'keine Gegenzeichnung';
export const GEGENZEICHNUNG_PFLICHT = 'Bitte wählen … (Pflicht bei Schlüsselkontrolle)';

/**
 * Auswahl einer Person. `ohne`: Beschriftung der Wahl „keine Person“ (nur bei
 * optionalen Rollen); ohne sie ist eine leere Auswahl keine Person: Ist noch
 * niemand gesetzt (der Dienst liefert unbekannte Personen seit TCMS s10 als
 * `null`), erscheint ein gesperrter Platzhalter „Bitte wählen …“, der sich
 * nicht wieder auswählen lässt.
 */
function PersonAuswahl({
  label,
  wert,
  pool,
  onChange,
  ohne,
}: {
  label: string;
  wert: string | null;
  pool: readonly Person[];
  onChange: (id: string | null) => void;
  ohne: string | null;
}) {
  // Eine vorbelegte Person außerhalb der Auswahl bleibt sichtbar (und wird beim Speichern abgewiesen).
  const fremd = wert && !pool.some((p) => p.id === wert);
  return (
    <select
      className="input w-auto py-1 text-xs"
      aria-label={label}
      value={wert ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      {ohne !== null ? (
        <option value="">{ohne}</option>
      ) : !wert ? (
        <option value="" disabled>
          {PERSON_BITTE_WAEHLEN}
        </option>
      ) : null}
      {fremd ? <option value={wert}>Person ohne Zugriff – bitte ändern</option> : null}
      {pool.map((p) => (
        <option {...TCMS_TEXT_ISOLIERT} key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

export function SchrittKontrollen({
  gruppen,
  start,
  kanzlei,
  mandant,
  zusammenfassung,
  ...b
}: Basis & {
  gruppen: readonly KontrollGruppe[];
  start: Record<string, EntwurfKontrolle>;
  /** Kanzleipersonen mit Zugriff auf den Mandanten (kanzleikonsole). */
  kanzlei: readonly Person[];
  /** Kontakte dieses Mandanten mit Rolle im Tax-CMS. */
  mandant: readonly Person[];
  zusammenfassung: ReactNode;
}) {
  const [wahl, setWahl] = useState<Record<string, EntwurfKontrolle>>(start);
  const setze = (code: string, teil: Partial<EntwurfKontrolle>) =>
    setWahl({ ...wahl, [code]: { ...wahl[code]!, ...teil } });
  const anzahl = new Set(gruppen.flatMap((g) => g.kontrollen.map((k) => k.code))).size;
  const pool = (partei: 'KANZLEI' | 'MANDANT') => (partei === 'KANZLEI' ? kanzlei : mandant);

  return (
    <SchrittFormular
      {...b}
      schritt={5}
      daten={{ kontrollen: wahl }}
      hinweis="Abschluss erzeugt Version 1; die Ziele gehen danach zur Mandantenfreigabe."
      labels={[[/^kontrollen/, 'Zuständigkeiten']]}
    >
      {() => (
        <div className="px-6 py-4 space-y-3">
          {gruppen.map((g, gi) => {
            const eigene = g.kontrollen.filter((k) => k.primaer === g.code);
            return (
              <details key={g.code ?? 'ohne'} className="details-box" open={gi < 2}>
                <summary className="flex flex-wrap items-center gap-2">
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  {g.code ? <span className="font-mono text-muted">{g.code}</span> : null}
                  <span className="grow">
                    <TcmsText>{g.titel}</TcmsText>
                  </span>
                  {g.brutto ? (
                    <KlasseBadge klasse={g.brutto} title="Bruttoklasse (Startwert)" />
                  ) : null}
                  <span className="badge-gray">
                    {g.kontrollen.length} {g.kontrollen.length === 1 ? 'Vorlage' : 'Vorlagen'}
                  </span>
                </summary>
                <div className="details-body overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">
                      Kontrollvorlagen {g.code ? `zu ${g.code}` : 'ohne Risikobezug'}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col" className="th">
                          Vorlage
                        </th>
                        <th scope="col" className="th">
                          Schlüssel
                        </th>
                        <th scope="col" className="th">
                          Partei
                        </th>
                        <th scope="col" className="th">
                          Durchführend
                        </th>
                        <th scope="col" className="th">
                          Vertretung
                        </th>
                        <th scope="col" className="th">
                          Gegenzeichnung
                        </th>
                        <th scope="col" className="th">
                          Frequenz
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.kontrollen.map((k) => {
                        const kat = katalogKontrolle(k.code);
                        const vorlage = (
                          <th scope="row" className="px-2 py-2 text-left font-normal min-w-[12rem]">
                            <span className="block font-medium">
                              {k.code} · <TcmsText>{k.titel}</TcmsText>
                            </span>
                            <span className="block text-xs text-muted">
                              {kat
                                ? `${KONTROLLART_LABEL[kat.art]} · ${AUSFUEHRUNG_LABEL[kat.ausfuehrung]}`
                                : ''}
                              {kat?.review ? ` · ${kat.review}` : ''}
                              {k.risikoCodes.length > 1
                                ? ` · deckt ${k.risikoCodes.join(', ')}`
                                : ''}
                            </span>
                          </th>
                        );
                        if (g.code && k.primaer !== g.code) {
                          return (
                            <tr key={k.code} className="border-t border-default align-top">
                              {vorlage}
                              <td className="px-2 py-2" colSpan={6}>
                                <span className="text-xs text-muted">
                                  Zuständigkeiten und Frequenz unter {k.primaer}{' '}
                                  (frequenzbestimmendes Risiko)
                                </span>
                              </td>
                            </tr>
                          );
                        }
                        const w = wahl[k.code]!;
                        return (
                          <tr key={k.code} className="border-t border-default align-top">
                            {vorlage}
                            <td className="px-2 py-2">
                              {k.schluessel ? (
                                <span className="badge-brand gap-1">
                                  <KeyRound className="h-3 w-3" aria-hidden="true" /> Schlüssel
                                </span>
                              ) : (
                                <span className="text-muted">–</span>
                              )}
                            </td>
                            <td className="px-2 py-2">
                              <select
                                className="input w-auto py-1 text-xs"
                                aria-label={`Partei ${k.code}`}
                                value={w.partei}
                                onChange={(e) => {
                                  const partei =
                                    e.target.value === 'MANDANT' ? 'MANDANT' : 'KANZLEI';
                                  const p = pool(partei);
                                  setze(k.code, {
                                    partei,
                                    durchfuehrendId: p[0]?.id ?? null,
                                    vertretungId: p[1]?.id ?? null,
                                  });
                                }}
                              >
                                <option value="KANZLEI">Kanzlei</option>
                                <option value="MANDANT">Mandant</option>
                              </select>
                            </td>
                            <td className="px-2 py-2">
                              <PersonAuswahl
                                label={`Durchführend ${k.code}`}
                                wert={w.durchfuehrendId}
                                pool={pool(w.partei)}
                                ohne={null}
                                onChange={(id) => setze(k.code, { durchfuehrendId: id })}
                              />
                            </td>
                            <td className="px-2 py-2">
                              <PersonAuswahl
                                label={`Vertretung ${k.code}`}
                                wert={w.vertretungId}
                                pool={pool(w.partei)}
                                ohne={OHNE_VERTRETUNG}
                                onChange={(id) => setze(k.code, { vertretungId: id })}
                              />
                            </td>
                            <td className="px-2 py-2">
                              <span className="inline-flex items-center gap-1">
                                <select
                                  className="input w-auto py-1 text-xs"
                                  aria-label={`Gegenzeichnung ${k.code}${k.schluessel ? ' (Pflicht bei Schlüsselkontrolle)' : ''}`}
                                  value={w.gegenzeichnerId ?? ''}
                                  onChange={(e) =>
                                    setze(k.code, { gegenzeichnerId: e.target.value || null })
                                  }
                                >
                                  {/* Keine Gegenzeichnung (auch `null` des Dienstes, TCMS s10): bei
                                      Schlüsselkontrollen Pflicht, deshalb dort nur Platzhalter. */}
                                  {k.schluessel ? (
                                    <option value="" disabled>
                                      {GEGENZEICHNUNG_PFLICHT}
                                    </option>
                                  ) : (
                                    <option value="">{OHNE_GEGENZEICHNUNG}</option>
                                  )}
                                  {w.gegenzeichnerId &&
                                  ![...kanzlei, ...mandant].some(
                                    (p) => p.id === w.gegenzeichnerId,
                                  ) ? (
                                    <option value={w.gegenzeichnerId}>
                                      Person ohne Zugriff – bitte ändern
                                    </option>
                                  ) : null}
                                  <optgroup label="Kanzlei">
                                    {kanzlei.map((p) => (
                                      <option {...TCMS_TEXT_ISOLIERT} key={p.id} value={p.id}>
                                        {p.name}
                                      </option>
                                    ))}
                                  </optgroup>
                                  <optgroup label="Mandant (zweite Person)">
                                    {mandant.map((p) => (
                                      <option {...TCMS_TEXT_ISOLIERT} key={p.id} value={p.id}>
                                        {p.name}
                                      </option>
                                    ))}
                                  </optgroup>
                                </select>
                                {k.schluessel ? (
                                  <span
                                    className="font-bold text-red-700 dark:text-red-400"
                                    aria-hidden="true"
                                  >
                                    *
                                  </span>
                                ) : null}
                              </span>
                            </td>
                            <td className="px-2 py-2 min-w-[8rem]">
                              <span className="block text-sm font-medium">
                                {frequenzLabel(k.effektiv)}
                              </span>
                              <span className="block text-xs text-muted">
                                <TcmsText>{k.begruendung}</TcmsText>
                              </span>
                              <span className="block text-xs text-muted">
                                {k.perioden} Durchführungen im Wirksamkeitszeitraum
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {g.code && eigene.length === 0 ? (
                    <p className="hint">
                      Alle Vorlagen dieses Risikos werden unter dem frequenzbestimmenden Risiko
                      konfiguriert.
                    </p>
                  ) : null}
                </div>
              </details>
            );
          })}
          <p className="hint">
            {anzahl} Kontrollen aus dem Paket. Frequenzen sind aus der Häufigkeitsmatrix abgeleitet
            (strengere aus Vorlage und Governance-Typ × Bruttoklasse); Abweichungen erfordern nach
            der Einrichtung eine Begründung und eine zweite Person. Die Designbeurteilung folgt in
            Phase 3. * Gegenzeichnung ist bei Schlüsselkontrollen Pflicht.
          </p>
          {zusammenfassung}
        </div>
      )}
    </SchrittFormular>
  );
}
