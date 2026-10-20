'use client';

// =============================================================================
// Formular für das Geschäftsprofil P1–P12 (TCMS Stufe 3, Bereich A; aus der Demo
// components/profil/profil-formular.tsx): Schritt 2 des Einrichtungsassistenten
// und „Profil ändern“. Kontrollierte Komponente ohne Server-Aufruf; geprüft wird
// beim Speichern im Dienst (`ProfilAntwortenSchema`, Pflichtangaben).
//
// Die Hinweise unten (Lager ohne Registrierung, Zahl der Risikovorschläge) sind
// eine Anzeige-Vorschau aus @taxtronik/tcms-domain – maßgeblich ist der
// Vorschlag, den der Dienst nach dem Speichern liefert.
// =============================================================================

import { useId, useState, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import {
  EU_LAENDER,
  LAGER_ART_LABEL,
  LAGER_ARTEN,
  LAND_NAME,
  lagerOhneRegistrierung,
  MARKTPLAETZE,
  PROFIL_FRAGEN,
  schlageRisikenVor,
  ZAHLUNGSWEGE,
  type Geschaeftsprofil,
  type LagerArt,
} from '@taxtronik/tcms-domain';
import { TCMS_TEXT_ISOLIERT, TcmsText } from '@/components/tcms/text';

/** Person der Mandantenseite für P12 (Name aus der kanzleikonsole, Rolle aus dem Tax-CMS). */
export interface ProfilPerson {
  id: string;
  name: string;
  funktion: string | null;
  rolle: string;
}

const LAGER_LAENDER = [...EU_LAENDER, 'CH', 'GB'];
const SYSTEM_ARTEN = [
  'Shop',
  'Marktplatz-Tool',
  'Warenwirtschaft',
  'FiBu',
  'Schnittstelle',
  'Sonstiges',
];

const landLabel = (c: string) => (LAND_NAME[c] ? `${LAND_NAME[c]} (${c})` : c);

function Gruppe({ titel, children }: { titel: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-secondary mb-2">{titel}</h4>
      {children}
    </section>
  );
}

function Frage({ nr, titel, children }: { nr: string; titel: string; children: ReactNode }) {
  return (
    <fieldset className="mb-4 min-w-0">
      <legend className="label-sm">
        {nr} · {titel}
      </legend>
      {children}
    </fieldset>
  );
}

function JaNein({
  label,
  wert,
  onChange,
}: {
  label: string;
  wert: boolean;
  onChange: (b: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm text-secondary" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="input w-auto shrink-0"
        value={wert ? 'ja' : 'nein'}
        onChange={(e) => onChange(e.target.value === 'ja')}
      >
        <option value="ja">Ja</option>
        <option value="nein">Nein</option>
      </select>
    </div>
  );
}

function Haken({
  label,
  wert,
  onChange,
}: {
  label: string;
  wert: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-sm">
      <input type="checkbox" checked={wert} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Mehrfach({
  optionen,
  werte,
  onChange,
}: {
  optionen: readonly string[];
  werte: string[];
  onChange: (w: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {optionen.map((o) => (
        <Haken
          key={o}
          label={o}
          wert={werte.includes(o)}
          onChange={(b) => onChange(b ? [...werte, o] : werte.filter((w) => w !== o))}
        />
      ))}
    </div>
  );
}

function Chip({
  text,
  titel,
  onEntfernen,
}: {
  text: string;
  titel?: string;
  onEntfernen: () => void;
}) {
  return (
    <li className="badge-brand gap-1" title={titel}>
      <span {...TCMS_TEXT_ISOLIERT}>{text}</span>
      <button
        type="button"
        className="inline-flex"
        aria-label={`${titel ?? text} entfernen`}
        onClick={onEntfernen}
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </li>
  );
}

/** Länder als ISO-Codes mit Mehrfachauswahl (Plaketten + Auswahl bzw. freie Eingabe). */
export function LaenderChips({
  werte,
  onChange,
  auswahl = EU_LAENDER,
  frei = false,
  label,
}: {
  werte: string[];
  onChange: (w: string[]) => void;
  auswahl?: readonly string[];
  frei?: boolean;
  label: string;
}) {
  const [eingabe, setEingabe] = useState('');
  const uebrig = auswahl.filter((c) => !werte.includes(c));
  const hinzu = (c: string) => {
    const code = c.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code) && !werte.includes(code)) onChange([...werte, code]);
    setEingabe('');
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {werte.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${label}: gewählt`}>
          {werte.map((c) => (
            <Chip
              key={c}
              text={c}
              titel={landLabel(c)}
              onEntfernen={() => onChange(werte.filter((w) => w !== c))}
            />
          ))}
        </ul>
      ) : null}
      {frei ? (
        <input
          className="input w-40 py-1 text-sm"
          placeholder="ISO-Code, Enter …"
          aria-label={label}
          value={eingabe}
          maxLength={2}
          onChange={(e) => setEingabe(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              hinzu(eingabe);
            }
          }}
          onBlur={() => eingabe && hinzu(eingabe)}
        />
      ) : (
        <select
          className="input w-auto py-1 text-sm"
          aria-label={label}
          value=""
          onChange={(e) => e.target.value && hinzu(e.target.value)}
        >
          <option value="">Land …</option>
          {uebrig.map((c) => (
            <option key={c} value={c}>
              {landLabel(c)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Freitext-Liste als Plaketten (z. B. Anbieter, Ein-/Ausschlüsse). */
export function TextChips({
  werte,
  onChange,
  label,
  maxLaenge = 200,
}: {
  werte: string[];
  onChange: (w: string[]) => void;
  label: string;
  maxLaenge?: number;
}) {
  const [eingabe, setEingabe] = useState('');
  const hinzu = () => {
    const t = eingabe.trim();
    if (t && !werte.includes(t)) onChange([...werte, t]);
    setEingabe('');
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {werte.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${label}: Einträge`}>
          {werte.map((w) => (
            <Chip key={w} text={w} onEntfernen={() => onChange(werte.filter((x) => x !== w))} />
          ))}
        </ul>
      ) : null}
      <input
        className="input w-52 py-1 text-sm"
        placeholder="Eintrag hinzufügen …"
        aria-label={label}
        value={eingabe}
        maxLength={maxLaenge}
        onChange={(e) => setEingabe(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            hinzu();
          }
        }}
        onBlur={() => eingabe.trim() && hinzu()}
      />
    </div>
  );
}

function ZahlFeld({
  label,
  wert,
  onChange,
  einheit = '€',
  max,
}: {
  label: string;
  wert: number;
  onChange: (n: number) => void;
  einheit?: string;
  max?: number;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm text-secondary" htmlFor={id}>
        {label}
      </label>
      <span className="inline-flex items-center gap-1.5 shrink-0">
        <input
          id={id}
          type="number"
          className="input w-40 text-right font-mono"
          min={0}
          max={max}
          step={1}
          value={Number.isFinite(wert) ? wert : 0}
          onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        />
        <span className="text-sm text-muted" aria-hidden="true">
          {einheit}
        </span>
      </span>
    </div>
  );
}

function Buchhaltung({
  wert,
  onChange,
}: {
  wert: 'KANZLEI' | 'INTERN';
  onChange: (w: 'KANZLEI' | 'INTERN') => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm text-secondary" htmlFor={id}>
        Buchhaltung
      </label>
      <select
        id={id}
        className="input w-auto shrink-0"
        value={wert}
        onChange={(e) => onChange(e.target.value === 'INTERN' ? 'INTERN' : 'KANZLEI')}
      >
        <option value="KANZLEI">über die Kanzlei</option>
        <option value="INTERN">intern beim Mandanten</option>
      </select>
    </div>
  );
}

function Entfernen({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} onClick={onClick}>
      <X className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

function Hinzufuegen({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="btn-secondary text-xs py-1" onClick={onClick}>
      <Plus className="h-3.5 w-3.5" aria-hidden="true" /> {children}
    </button>
  );
}

const frage = (key: keyof Geschaeftsprofil) => {
  const f = PROFIL_FRAGEN.find((x) => x.key === key)!;
  return { nr: f.nr, titel: f.titel };
};

/** Monat (YYYY-MM) des fachlichen Heute aus der Antwort des Dienstes. */
const monatAus = (heuteIso: string) => heuteIso.slice(0, 7);

export function ProfilFormular({
  wert,
  onChange,
  personen,
  heuteIso,
}: {
  wert: Geschaeftsprofil;
  onChange: (p: Geschaeftsprofil) => void;
  /** Gesetzliche Vertretung und Tax-Compliance-Beauftragte (P12, nur Anzeige). */
  personen: readonly ProfilPerson[];
  /** „Heute“ des Dienstes (`YYYY-MM-DD`) für neue Lager- und OSS-Monate. */
  heuteIso: string;
}) {
  const p = wert;
  const setze = <K extends keyof Geschaeftsprofil>(key: K, teil: Partial<Geschaeftsprofil[K]>) =>
    onChange({ ...p, [key]: { ...p[key], ...teil } });
  const ohneReg = lagerOhneRegistrierung(p);
  const vorschlaege = schlageRisikenVor(p);

  return (
    <div>
      <Gruppe titel="Kanäle & Fulfillment">
        <Frage {...frage('p1')}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <Haken
              label="Eigener Shop"
              wert={p.p1.eigenerShop}
              onChange={(b) => setze('p1', { eigenerShop: b })}
            />
            {p.p1.eigenerShop ? (
              <input
                className="input w-56 py-1 text-sm"
                placeholder="z. B. Shopware 6"
                aria-label="Shopsystem"
                maxLength={120}
                value={p.p1.shopSystem}
                onChange={(e) => setze('p1', { shopSystem: e.target.value })}
              />
            ) : null}
          </div>
          <div className="mt-2" role="group" aria-label="Marktplätze">
            <Mehrfach
              optionen={MARKTPLAETZE}
              werte={p.p1.marktplaetze}
              onChange={(w) => setze('p1', { marktplaetze: w })}
            />
          </div>
        </Frage>
        <Frage {...frage('p2')}>
          <div className="mb-2">
            <Haken
              label="Eigenversand ab Deutschland"
              wert={p.p2.eigenversandDE}
              onChange={(b) => setze('p2', { eigenversandDE: b })}
            />
          </div>
          <ul className="space-y-2">
            {p.p2.lager.map((l, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <select
                  className="input w-auto"
                  aria-label={`Lager ${i + 1}: Land`}
                  value={l.land}
                  onChange={(e) =>
                    setze('p2', {
                      lager: p.p2.lager.map((x, j) =>
                        j === i ? { ...x, land: e.target.value } : x,
                      ),
                    })
                  }
                >
                  {LAGER_LAENDER.map((c) => (
                    <option key={c} value={c}>
                      {landLabel(c)}
                    </option>
                  ))}
                </select>
                <input
                  type="month"
                  className="input w-auto"
                  aria-label={`Lager ${i + 1}: Beginn`}
                  value={l.seit}
                  onChange={(e) =>
                    setze('p2', {
                      lager: p.p2.lager.map((x, j) =>
                        j === i ? { ...x, seit: e.target.value } : x,
                      ),
                    })
                  }
                />
                <select
                  className="input w-auto"
                  aria-label={`Lager ${i + 1}: Art`}
                  value={l.art}
                  onChange={(e) =>
                    setze('p2', {
                      lager: p.p2.lager.map((x, j) =>
                        j === i ? { ...x, art: e.target.value as LagerArt } : x,
                      ),
                    })
                  }
                >
                  {LAGER_ARTEN.map((a) => (
                    <option key={a} value={a}>
                      {LAGER_ART_LABEL[a]}
                    </option>
                  ))}
                </select>
                <Entfernen
                  label={`Lager ${i + 1} entfernen`}
                  onClick={() => setze('p2', { lager: p.p2.lager.filter((_, j) => j !== i) })}
                />
              </li>
            ))}
          </ul>
          <div className="mt-2">
            <Hinzufuegen
              onClick={() =>
                setze('p2', {
                  lager: [
                    ...p.p2.lager,
                    {
                      land: p.p2.lager.length ? 'PL' : 'DE',
                      seit: monatAus(heuteIso),
                      art: 'EIGEN',
                    },
                  ],
                })
              }
            >
              Lager hinzufügen
            </Hinzufuegen>
          </div>
        </Frage>
      </Gruppe>

      <Gruppe titel="Märkte & Kunden">
        <Frage {...frage('p3')}>
          <LaenderChips
            label="Zielland hinzufügen"
            werte={p.p3.laender}
            onChange={(w) => setze('p3', { laender: w })}
          />
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 mt-2">
            <span className="inline-flex items-center gap-1.5">
              <input
                type="number"
                className="input w-20 text-right font-mono"
                min={0}
                max={100}
                aria-label="B2B-Anteil in Prozent"
                value={p.p3.b2bAnteilProzent}
                onChange={(e) =>
                  setze('p3', {
                    b2bAnteilProzent: e.target.value === '' ? 0 : Number(e.target.value),
                  })
                }
              />
              <span className="text-sm text-muted">% B2B-Anteil</span>
            </span>
            <Haken
              label="EU-B2B-Verkäufe"
              wert={p.p3.b2bEU}
              onChange={(b) => setze('p3', { b2bEU: b })}
            />
            <Haken
              label="Inland-B2B-Verkäufe"
              wert={p.p3.b2bInland}
              onChange={(b) => setze('p3', { b2bInland: b })}
            />
          </div>
        </Frage>
        <Frage {...frage('p6')}>
          <Mehrfach
            optionen={ZAHLUNGSWEGE}
            werte={p.p6.zahlungswege}
            onChange={(w) => setze('p6', { zahlungswege: w })}
          />
        </Frage>
        <Frage {...frage('p7')}>
          <div className="space-y-1.5">
            <JaNein
              label="Eigene Gutscheine (Einzweck/Mehrzweck)"
              wert={p.p7.gutscheine}
              onChange={(b) => setze('p7', { gutscheine: b })}
            />
            <JaNein
              label="Abonnements"
              wert={p.p7.abos}
              onChange={(b) => setze('p7', { abos: b })}
            />
            <JaNein
              label="Bundles"
              wert={p.p7.bundles}
              onChange={(b) => setze('p7', { bundles: b })}
            />
          </div>
        </Frage>
      </Gruppe>

      <Gruppe titel="Sortiment & Systeme">
        <Frage {...frage('p4')}>
          <ul className="space-y-2">
            {p.p4.warengruppen.map((w, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <input
                  className="input max-w-xs"
                  placeholder="Warengruppe"
                  aria-label={`Warengruppe ${i + 1}`}
                  maxLength={120}
                  value={w.name}
                  onChange={(e) =>
                    setze('p4', {
                      warengruppen: p.p4.warengruppen.map((x, j) =>
                        j === i ? { ...x, name: e.target.value } : x,
                      ),
                    })
                  }
                />
                <Haken
                  label="abweichender Steuersatz"
                  wert={w.abweichenderSatz}
                  onChange={(b) =>
                    setze('p4', {
                      warengruppen: p.p4.warengruppen.map((x, j) =>
                        j === i ? { ...x, abweichenderSatz: b } : x,
                      ),
                    })
                  }
                />
                <Entfernen
                  label={`Warengruppe ${i + 1} entfernen`}
                  onClick={() =>
                    setze('p4', { warengruppen: p.p4.warengruppen.filter((_, j) => j !== i) })
                  }
                />
              </li>
            ))}
          </ul>
          <div className="mt-2 mb-2">
            <Hinzufuegen
              onClick={() =>
                setze('p4', {
                  warengruppen: [...p.p4.warengruppen, { name: '', abweichenderSatz: false }],
                })
              }
            >
              Warengruppe hinzufügen
            </Hinzufuegen>
          </div>
          <JaNein
            label="Gebrauchtware / Differenzbesteuerung"
            wert={p.p4.gebrauchtware}
            onChange={(b) => setze('p4', { gebrauchtware: b })}
          />
        </Frage>
        <Frage {...frage('p5')}>
          <JaNein
            label="Import aus Drittländern"
            wert={p.p5.drittlandImport}
            onChange={(b) => setze('p5', { drittlandImport: b })}
          />
          {p.p5.drittlandImport ? (
            <div className="space-y-2 mt-2">
              <LaenderChips
                label="Herkunftsland hinzufügen"
                frei
                werte={p.p5.laender}
                onChange={(w) => setze('p5', { laender: w })}
              />
              <input
                className="input"
                placeholder="z. B. Spediteur mit indirekter Vertretung"
                aria-label="Zollabwicklung"
                maxLength={200}
                value={p.p5.zollabwicklung}
                onChange={(e) => setze('p5', { zollabwicklung: e.target.value })}
              />
            </div>
          ) : null}
        </Frage>
        <Frage {...frage('p8')}>
          <ul className="space-y-2">
            {p.p8.systeme.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <select
                  className="input w-auto"
                  aria-label={`System ${i + 1}: Art`}
                  value={SYSTEM_ARTEN.includes(s.art) ? s.art : 'Sonstiges'}
                  onChange={(e) =>
                    setze('p8', {
                      systeme: p.p8.systeme.map((x, j) =>
                        j === i ? { ...x, art: e.target.value } : x,
                      ),
                    })
                  }
                >
                  {SYSTEM_ARTEN.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
                <input
                  className="input max-w-60"
                  placeholder="System"
                  aria-label={`System ${i + 1}: Name`}
                  maxLength={120}
                  value={s.name}
                  onChange={(e) =>
                    setze('p8', {
                      systeme: p.p8.systeme.map((x, j) =>
                        j === i ? { ...x, name: e.target.value } : x,
                      ),
                    })
                  }
                />
                <input
                  className="input w-28"
                  placeholder="Version"
                  aria-label={`System ${i + 1}: Version`}
                  maxLength={40}
                  value={s.version}
                  onChange={(e) =>
                    setze('p8', {
                      systeme: p.p8.systeme.map((x, j) =>
                        j === i ? { ...x, version: e.target.value } : x,
                      ),
                    })
                  }
                />
                <Entfernen
                  label={`System ${i + 1} entfernen`}
                  onClick={() => setze('p8', { systeme: p.p8.systeme.filter((_, j) => j !== i) })}
                />
              </li>
            ))}
          </ul>
          <div className="mt-2">
            <Hinzufuegen
              onClick={() =>
                setze('p8', { systeme: [...p.p8.systeme, { art: 'Shop', name: '', version: '' }] })
              }
            >
              System hinzufügen
            </Hinzufuegen>
          </div>
        </Frage>
      </Gruppe>

      <Gruppe titel="Organisation">
        <Frage {...frage('p9')}>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
            <span className="inline-flex items-center gap-2">
              <Haken
                label="OSS-Registrierung seit"
                wert={p.p9.ossSeit != null}
                onChange={(b) => setze('p9', { ossSeit: b ? monatAus(heuteIso) : null })}
              />
              {p.p9.ossSeit != null ? (
                <input
                  type="month"
                  className="input w-auto"
                  aria-label="OSS-Registrierung seit (Monat)"
                  value={p.p9.ossSeit}
                  onChange={(e) => setze('p9', { ossSeit: e.target.value || null })}
                />
              ) : null}
            </span>
            <Haken label="IOSS" wert={p.p9.ioss} onChange={(b) => setze('p9', { ioss: b })} />
            <Haken
              label="Dauerfristverlängerung"
              wert={p.p9.dauerfrist}
              onChange={(b) => setze('p9', { dauerfrist: b })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <span className="text-sm text-secondary">Lokale USt-Registrierungen:</span>
            <LaenderChips
              label="Registrierungsland hinzufügen"
              auswahl={LAGER_LAENDER.filter((c) => c !== 'DE')}
              werte={p.p9.lokaleUstNr}
              onChange={(w) => setze('p9', { lokaleUstNr: w })}
            />
          </div>
          {ohneReg.length ? (
            <p className="alert-warning mt-2 text-sm" role="note">
              Hinweis:{' '}
              {ohneReg
                .map((l) => `Lager ${l.land} seit ${l.seit.slice(5, 7)}/${l.seit.slice(0, 4)}`)
                .join(', ')}{' '}
              ohne lokale USt-Registrierung – als Feststellung prüfen (P9).
            </p>
          ) : null}
        </Frage>
        <Frage {...frage('p10')}>
          <div className="space-y-1.5">
            <ZahlFeld
              label="Vorjahresumsatz"
              wert={p.p10.vorjahresumsatzEur}
              onChange={(n) => setze('p10', { vorjahresumsatzEur: n })}
            />
            <ZahlFeld
              label="EU-Fernverkäufe Vorjahr"
              wert={p.p10.euFernverkaeufeVorjahrEur}
              onChange={(n) => setze('p10', { euFernverkaeufeVorjahrEur: n })}
            />
            <ZahlFeld
              label="EU-Fernverkäufe laufendes Jahr"
              wert={p.p10.euFernverkaeufeLfdEur}
              onChange={(n) => setze('p10', { euFernverkaeufeLfdEur: n })}
            />
          </div>
        </Frage>
        <Frage {...frage('p11')}>
          <JaNein
            label="Eingangsleistungen ausländischer Plattformen, Werbe- oder SaaS-Anbieter"
            wert={p.p11.vorhanden}
            onChange={(b) => setze('p11', { vorhanden: b })}
          />
          {p.p11.vorhanden ? (
            <div className="mt-2">
              <TextChips
                label="Anbieter hinzufügen"
                maxLaenge={120}
                werte={p.p11.anbieter}
                onChange={(w) => setze('p11', { anbieter: w })}
              />
            </div>
          ) : null}
        </Frage>
        <Frage {...frage('p12')}>
          <dl className="space-y-1.5">
            {personen.map((x) => (
              <div key={`${x.rolle}-${x.id}`} className="flex justify-between gap-4">
                <dt className="text-sm text-secondary">
                  <TcmsText>{x.rolle}</TcmsText>
                </dt>
                <dd className="text-sm">
                  <TcmsText>{x.name}</TcmsText>
                  {x.funktion ? (
                    <span className="text-muted">
                      {' '}
                      (<TcmsText>{x.funktion}</TcmsText>)
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
            {personen.length === 0 ? (
              <p className="text-sm text-muted">
                Keine gesetzliche Vertretung und keine Tax-Compliance-Beauftragten im Tax-CMS
                hinterlegt (Kontakte & Rollen).
              </p>
            ) : null}
          </dl>
          <div className="mt-2">
            <Buchhaltung
              wert={p.p12.buchhaltung}
              onChange={(buchhaltung) => setze('p12', { buchhaltung })}
            />
          </div>
          <p className="hint">
            Personen stammen aus den Kontakten des Mandanten und ihren Rollen im Tax-CMS; ein
            Wechsel ist Ereignis T-12.
          </p>
        </Frage>
      </Gruppe>

      <p className="alert-info-sm text-sm" role="note">
        Vorschau: Aus diesen Angaben folgen {vorschlaege.length} Risikovorschläge, davon{' '}
        {vorschlaege.filter((v) => v.kern).length} Kernrisiken. Maßgeblich ist der Vorschlag, den
        das Tax-CMS nach dem Speichern zeigt; er ist deterministisch und nennt je Risiko seinen
        Grund.
      </p>
    </div>
  );
}
