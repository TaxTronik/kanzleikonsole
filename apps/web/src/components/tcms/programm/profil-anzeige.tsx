// =============================================================================
// Lesbare Darstellung eines Profilstands P1–P12 und der Änderungen zum
// Vorgänger (TCMS Stufe 3, Bereich A; aus der Demo
// components/profil/profil-anzeige.tsx). Reine Anzeige; der Vergleich zweier
// Stände (`profilDiff`) ist eine Anzeigehilfe aus @taxtronik/tcms-domain.
// =============================================================================

import type { ReactNode } from 'react';
import {
  fmtEurGanz,
  fmtMonatJahr,
  LAGER_ART_LABEL,
  LAND_NAME,
  PROFIL_FRAGEN,
  type FrageDiff,
  type Geschaeftsprofil,
} from '@taxtronik/tcms-domain';
import { TCMS_TEXT_ISOLIERT, TcmsText } from '@/components/tcms/text';

type Key = keyof Geschaeftsprofil;

const jn = (b: boolean) => (b ? 'ja' : 'nein');

function Laender({ codes, leer = '—' }: { codes: readonly string[]; leer?: string }) {
  if (!codes.length) return <span className="text-muted">{leer}</span>;
  return (
    <span className="inline-flex flex-wrap justify-end gap-1">
      {codes.map((c) => (
        <abbr key={c} className="badge-brand font-mono no-underline" title={LAND_NAME[c] ?? c}>
          {c}
        </abbr>
      ))}
    </span>
  );
}

function Werte({ liste, leer = 'keine' }: { liste: readonly string[]; leer?: string }) {
  if (!liste.length) return <span className="text-muted">{leer}</span>;
  return (
    <span className="inline-flex flex-wrap justify-end gap-1">
      {liste.map((w) => (
        <span key={w} className="badge-gray" {...TCMS_TEXT_ISOLIERT}>
          {w}
        </span>
      ))}
    </span>
  );
}

function Zeile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-0.5">
      <dt className="text-sm text-secondary shrink-0">{label}</dt>
      <dd className="text-sm text-right" {...TCMS_TEXT_ISOLIERT}>
        {children}
      </dd>
    </div>
  );
}

/** Darstellung je Profilfrage (je Frage eine Funktion). */
const INHALT: Readonly<Record<Key, (p: Geschaeftsprofil) => ReactNode>> = {
  p1: (p) => (
    <>
      <Zeile label="Eigener Shop">{p.p1.eigenerShop ? p.p1.shopSystem || 'ja' : 'nein'}</Zeile>
      <Zeile label="Marktplätze">
        <Werte liste={p.p1.marktplaetze} />
      </Zeile>
    </>
  ),
  p2: (p) => (
    <>
      <Zeile label="Eigenversand ab DE">{jn(p.p2.eigenversandDE)}</Zeile>
      <Zeile label="Lager">
        {p.p2.lager.length ? (
          <span className="flex flex-col items-end gap-1">
            {p.p2.lager.map((l, i) => (
              <span key={`${l.land}-${i}`} className="inline-flex items-center gap-1.5">
                <abbr
                  className="badge-brand font-mono no-underline"
                  title={LAND_NAME[l.land] ?? l.land}
                >
                  {l.land}
                </abbr>
                <span className="text-xs text-muted">
                  seit {fmtMonatJahr(l.seit)} · {LAGER_ART_LABEL[l.art] ?? l.art}
                </span>
              </span>
            ))}
          </span>
        ) : (
          <span className="text-muted">keine</span>
        )}
      </Zeile>
    </>
  ),
  p3: (p) => (
    <>
      <Zeile label="Zielländer">
        <Laender codes={p.p3.laender} />
      </Zeile>
      <Zeile label="B2B-Anteil">{p.p3.b2bAnteilProzent} %</Zeile>
      <Zeile label="EU-B2B · Inland-B2B">
        {jn(p.p3.b2bEU)} · {jn(p.p3.b2bInland)}
      </Zeile>
    </>
  ),
  p4: (p) => (
    <>
      <Zeile label="Warengruppen">
        {p.p4.warengruppen.length ? (
          <span className="flex flex-col items-end gap-1">
            {p.p4.warengruppen.map((w, i) => (
              <span key={`${w.name}-${i}`}>
                <TcmsText>{w.name}</TcmsText>{' '}
                {w.abweichenderSatz ? (
                  <span className="badge-yellow">abweichender Satz</span>
                ) : (
                  <span className="text-xs text-muted">Regelsatz</span>
                )}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-muted">keine</span>
        )}
      </Zeile>
      <Zeile label="Gebrauchtware">{jn(p.p4.gebrauchtware)}</Zeile>
    </>
  ),
  p5: (p) =>
    p.p5.drittlandImport ? (
      <>
        <Zeile label="Import aus">
          <Laender codes={p.p5.laender} />
        </Zeile>
        <Zeile label="Zollabwicklung">
          <TcmsText>{p.p5.zollabwicklung || '—'}</TcmsText>
        </Zeile>
      </>
    ) : (
      <Zeile label="Drittlandimport">nein</Zeile>
    ),
  p6: (p) => (
    <Zeile label="Zahlungswege">
      <Werte liste={p.p6.zahlungswege} />
    </Zeile>
  ),
  p7: (p) => (
    <Zeile label="Gutscheine · Abos · Bundles">
      {jn(p.p7.gutscheine)} · {jn(p.p7.abos)} · {jn(p.p7.bundles)}
    </Zeile>
  ),
  p8: (p) => (
    <Zeile label="Systeme">
      {p.p8.systeme.length ? (
        <span className="flex flex-col items-end gap-1">
          {p.p8.systeme.map((s, i) => (
            <span key={i}>
              <span className="text-xs text-muted">{s.art}:</span> <TcmsText>{s.name}</TcmsText>
              {s.version && s.version !== '—' ? ` ${s.version}` : ''}
            </span>
          ))}
        </span>
      ) : (
        <span className="text-muted">keine erfasst</span>
      )}
    </Zeile>
  ),
  p9: (p) => (
    <>
      <Zeile label="OSS · IOSS">
        {p.p9.ossSeit ? `seit ${fmtMonatJahr(p.p9.ossSeit)}` : 'kein OSS'} ·{' '}
        {p.p9.ioss ? 'IOSS' : 'kein IOSS'}
      </Zeile>
      <Zeile label="Lokale USt-Registrierungen">
        <Laender codes={p.p9.lokaleUstNr} leer="keine" />
      </Zeile>
      <Zeile label="Dauerfristverlängerung">{jn(p.p9.dauerfrist)}</Zeile>
    </>
  ),
  p10: (p) => (
    <>
      <Zeile label="Vorjahresumsatz">
        <span className="font-mono">{fmtEurGanz(p.p10.vorjahresumsatzEur)}</span>
      </Zeile>
      <Zeile label="EU-Fernverkäufe Vorjahr">
        <span className="font-mono">{fmtEurGanz(p.p10.euFernverkaeufeVorjahrEur)}</span>
      </Zeile>
      <Zeile label="EU-Fernverkäufe lfd. Jahr">
        <span className="font-mono">{fmtEurGanz(p.p10.euFernverkaeufeLfdEur)}</span>
      </Zeile>
    </>
  ),
  p11: (p) => (
    <Zeile label="Ausländische Leistende">
      {p.p11.vorhanden ? (
        <Werte liste={p.p11.anbieter} />
      ) : (
        <span className="text-muted">keine</span>
      )}
    </Zeile>
  ),
  p12: (p) => (
    <Zeile label="Buchhaltung">
      {p.p12.buchhaltung === 'KANZLEI' ? 'über die Kanzlei' : 'intern'}
    </Zeile>
  ),
};

const GRUPPEN = [...new Set(PROFIL_FRAGEN.map((f) => f.gruppe))];

/** Profil gruppiert in zwei Spalten; geänderte Fragen (gegenüber dem Vorgänger) sind markiert. */
export function ProfilAnzeige({
  profil,
  geaendert,
}: {
  profil: Geschaeftsprofil;
  geaendert?: ReadonlySet<string>;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-7 gap-y-2">
      {GRUPPEN.map((g) => (
        <section key={g}>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-secondary mb-2 mt-2">
            {g}
          </h4>
          {PROFIL_FRAGEN.filter((f) => f.gruppe === g).map((f) => {
            const neu = geaendert?.has(f.key) ?? false;
            return (
              <div
                key={f.key}
                className={`mb-2 border-l-2 pl-2.5 ${neu ? 'border-brand-500' : 'border-default'}`}
              >
                <p className="label-sm flex items-center gap-1.5 mb-0.5">
                  {f.nr} · <TcmsText>{f.titel}</TcmsText>
                  {neu ? <span className="badge-brand">geändert</span> : null}
                </p>
                <dl>{INHALT[f.key](profil)}</dl>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

/** Änderungen je Profilfrage gegenüber dem Vorgängerstand (Anzeigehilfe). */
export function ProfilDiffListe({ diff }: { diff: readonly FrageDiff[] }) {
  if (!diff.length) return <p className="text-xs text-muted">Keine inhaltliche Änderung.</p>;
  return (
    <ul className="space-y-1.5">
      {diff.map((d) => (
        <li key={d.key}>
          <p className="text-xs font-semibold text-secondary">
            {d.nr} · <TcmsText>{d.titel}</TcmsText>
          </p>
          <ul>
            {d.neu.map((z) => (
              <li key={`n-${z}`} className="text-xs flex items-start gap-1.5">
                <span
                  className="font-mono text-emerald-700 dark:text-emerald-400"
                  aria-hidden="true"
                >
                  +
                </span>
                <span>
                  <span className="sr-only">neu: </span>
                  {z}
                </span>
              </li>
            ))}
            {d.entfallen.map((z) => (
              <li key={`e-${z}`} className="text-xs text-muted flex items-start gap-1.5">
                <span className="font-mono text-red-700 dark:text-red-400" aria-hidden="true">
                  −
                </span>
                <span>
                  <span className="sr-only">entfallen: </span>
                  <s>{z}</s>
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
