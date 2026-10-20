// =============================================================================
// Ansicht des Länder-Monitors (TCMS Stufe 3, portiert aus der Demo
// staff/clients/[id]/tcms/laender/page.tsx und components/laender/*):
// Schwellenkarte, Ländertabelle und Detailbereich eines Landes.
//
// Schwelle (Status, Anteile), Registrierungsstatus und Fernverkaufssummen
// liefert der Dienst. Die Bezüge eines Landes (Risiken mit Grund, Kontrollen,
// Ereignisse) ordnet seit TCMS s7 der Dienst zu (`bezuege`); die Seite zeigt
// sie nur an und verlinkt auf die Bereiche (keine eigene Zuordnung).
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Check, Flame, FileText } from 'lucide-react';
import type { KontextAntwort, Laender, LandStand } from '@taxtronik/tcms-contract';
import {
  EU_LIEFERSCHWELLE_EUR,
  FESTSTELLUNG_STATUS_LABEL,
  fmtEurGanz,
  fmtMonatJahr,
  LAND_NAME,
  WARNSTUFE,
} from '@taxtronik/tcms-domain';
import type { TcmsNamen } from '@/server/tcms/namen';
import { DetailBereich, SperrHinweis } from '../bereich-b/detail';
import { isoDatumText, isoZeitText } from '../format';
import { SchwellenAnzeige } from '../visual';
import { lagerArt, profilP9, REG_BADGE, REG_LABEL, REG_LANG, standUnterschiede } from './anzeige';
import { TcmsText } from '@/components/tcms/text';

type Land = KontextAntwort['laender'][number];
type Feststellung = Laender['feststellungen'][number]['eintraege'][number];

const SCHWELLE_BADGE = {
  UEBERSCHRITTEN: 'badge-red',
  WARNUNG: 'badge-yellow',
  UNTERSCHRITTEN: 'badge-green',
} as const;

const prozent = (anteil: number) => `${Math.round(Math.max(0, anteil) * 100)} %`;

/** Kopfkarte EU-Lieferschwelle (laufendes Jahr und Vorjahr, Fachkonzept S12). */
export function SchwellenKarte({
  ctx,
  juengster,
  namen,
}: {
  ctx: KontextAntwort;
  juengster: LandStand | null;
  namen: TcmsNamen;
}) {
  const s = ctx.schwelle;
  const jahr = Number((ctx.laenderStand ?? ctx.stand).slice(0, 4));
  return (
    <section className="card mt-4" aria-labelledby="tcms-schwelle">
      <div className="card-header flex-wrap gap-2">
        <h3 id="tcms-schwelle" className="text-sm font-semibold text-primary">
          EU-Fernverkäufe – Schwelle {fmtEurGanz(EU_LIEFERSCHWELLE_EUR)} (OSS)
        </h3>
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className={SCHWELLE_BADGE[s.status]}>
            <TcmsText>{s.label}</TcmsText>
          </span>
          <span className="text-xs text-muted">
            Warnung ab {Math.round(WARNSTUFE * 100)} % der Schwelle
          </span>
        </span>
      </div>
      <div className="p-4 space-y-3">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-lg border border-default p-3">
            <dt className="text-xs text-muted">Laufendes Jahr {jahr}</dt>
            <dd className="text-lg font-bold font-mono text-primary">
              {fmtEurGanz(ctx.fernverkaeufeLfd)}
            </dd>
            <dd className="text-xs text-secondary">{prozent(s.anteilLfd)} der Schwelle</dd>
          </div>
          <div className="rounded-lg border border-default p-3">
            <dt className="text-xs text-muted">Vorjahr {jahr - 1}</dt>
            <dd className="text-lg font-bold font-mono text-secondary">
              {fmtEurGanz(ctx.fernverkaeufeVorjahr)}
            </dd>
            <dd className="text-xs text-secondary">{prozent(s.anteilVorjahr)} der Schwelle</dd>
          </div>
        </dl>
        <div>
          <p className="flex justify-between text-xs text-muted mb-1">
            <span>Anteil an der Schwelle (laufendes Jahr)</span>
            <span className="font-mono">{prozent(s.anteilLfd)}</span>
          </p>
          <SchwellenAnzeige anteil={s.anteilLfd} label="Anteil an der EU-Lieferschwelle" />
        </div>
        <p className="text-xs text-muted">
          {ctx.laenderStand ? `Stand ${isoDatumText(ctx.laenderStand)} · ` : ''}
          Schwelle vgl. § 3c Abs. 4 UStG (Normanker ungeprüft). Status und Anteile berechnet das
          Tax-CMS.
        </p>
      </div>
      <div className="card-footer flex-wrap gap-2">
        <span>
          Datenquelle: {ctx.laenderQuelle === 'CSV' ? 'CSV-Import' : 'manuell erfasst'}
          {juengster
            ? ` · zuletzt erfasst ${isoZeitText(juengster.createdAt)} von ${namen.name(juengster.erfasstVon)}`
            : ''}
        </span>
      </div>
    </section>
  );
}

export function LaenderTabelle({
  laender,
  feststellungen,
  profil,
  laenderStand,
  landHref,
  feststellungHref,
  ausgewaehlt,
}: {
  laender: readonly Land[];
  feststellungen: ReadonlyMap<string, readonly Feststellung[]>;
  profil: KontextAntwort['profil'];
  laenderStand: string | null;
  landHref: (land: string) => string;
  feststellungHref: (id: string) => string;
  ausgewaehlt: string | null;
}) {
  const maxLfd = Math.max(1, ...laender.map((l) => l.fernverkaeufeLfdEur));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Länder im Monitor ({laender.length})</caption>
        <thead>
          <tr>
            <th scope="col" className="th">
              Land
            </th>
            <th scope="col" className="th th-right">
              Fernverkäufe lfd. Jahr
            </th>
            <th scope="col" className="th">
              Lager seit
            </th>
            <th scope="col" className="th">
              OSS
            </th>
            <th scope="col" className="th">
              Lokale USt-Nr.
            </th>
            <th
              scope="col"
              className="th"
              title="ZM-relevante Bewegungen (Zusammenfassende Meldung)"
            >
              ZM-relevant
            </th>
            <th scope="col" className="th">
              Steuersätze geprüft am
            </th>
            <th scope="col" className="th">
              Registrierungsstatus
            </th>
          </tr>
        </thead>
        <tbody>
          {laender.map((l) => {
            const fest = feststellungen.get(l.land) ?? [];
            const fehlt = l.registrierung === 'FEHLT';
            const art = lagerArt(profil, l.land);
            const istAusgewaehlt = ausgewaehlt === l.land;
            return (
              <tr
                key={l.land}
                className={`border-t border-default align-top ${istAusgewaehlt ? 'bg-surface-raised' : ''}`}
                aria-current={istAusgewaehlt ? 'true' : undefined}
              >
                <td className="px-3 py-2">
                  <Link
                    href={landHref(l.land)}
                    scroll={false}
                    className="whitespace-nowrap hover:underline"
                  >
                    <span className="font-medium text-primary">{l.land}</span>{' '}
                    <span className="text-xs text-muted">{LAND_NAME[l.land] ?? ''}</span>
                  </Link>
                  {fehlt && l.lagerSeit ? (
                    <span className="block text-xs text-red-700 mt-1">
                      Lager seit {fmtMonatJahr(l.lagerSeit)} ohne Registrierung
                      {fest[0] ? (
                        <>
                          ,{' '}
                          <Link href={feststellungHref(fest[0].id)} className="underline">
                            Feststellung {fest[0].nummer}
                          </Link>
                        </>
                      ) : null}
                    </span>
                  ) : laenderStand && l.stand !== laenderStand ? (
                    <span className="block text-xs text-muted whitespace-nowrap">
                      Stand {isoDatumText(l.stand)}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right">
                  <span className="font-mono">{fmtEurGanz(l.fernverkaeufeLfdEur)}</span>
                  <span
                    className="mt-1 block h-1.5 rounded-full bg-surface-sunken overflow-hidden"
                    aria-hidden="true"
                  >
                    <span
                      className={`block h-full rounded-full ${fehlt ? 'dot-amber' : 'bg-brand-600'}`}
                      style={{ width: `${(Math.max(0, l.fernverkaeufeLfdEur) / maxLfd) * 100}%` }}
                    />
                  </span>
                </td>
                <td className="px-3 py-2 text-secondary">
                  {l.lagerSeit ? (
                    <>
                      {fmtMonatJahr(l.lagerSeit)}
                      {art ? <span className="block text-xs text-muted">{art}</span> : null}
                    </>
                  ) : (
                    '–'
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={`status-dot ${l.oss ? 'dot-green' : 'dot-gray'}`}
                      aria-hidden="true"
                    />
                    {l.oss ? 'ja' : 'nein'}
                  </span>
                </td>
                <td className="px-3 py-2">
                  {l.lokaleUstNr ? (
                    <span className="badge-green">erteilt</span>
                  ) : fehlt ? (
                    <span className="badge-red">fehlt</span>
                  ) : (
                    <span className="text-secondary">–</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {l.zmRelevant ? (
                    <span className="badge-yellow">ja</span>
                  ) : (
                    <span className="text-secondary">–</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {l.steuersaetzeGeprueftAm ? (
                    <span className="text-secondary">{isoDatumText(l.steuersaetzeGeprueftAm)}</span>
                  ) : (
                    <span className="badge-yellow" title="Noch nicht geprüft">
                      prüfen
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className={REG_BADGE[l.registrierung]}>{REG_LABEL[l.registrierung]}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function H({ children, rechts }: { children: ReactNode; rechts?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-sm font-semibold text-primary">{children}</h4>
      {rechts}
    </div>
  );
}

function RegistrierungAbschnitt({
  l,
  feststellungen,
  profil,
}: {
  l: Land;
  feststellungen: readonly Feststellung[];
  profil: KontextAntwort['profil'];
}) {
  const p9 = profilP9(profil);
  const schritte: Array<{ text: string; erledigt: boolean }> = l.lagerSeit
    ? [
        { text: `Lager seit ${fmtMonatJahr(l.lagerSeit)}`, erledigt: true },
        ...(feststellungen[0]
          ? [{ text: `Feststellung ${feststellungen[0].nummer}`, erledigt: true }]
          : []),
        { text: 'lokale USt-Registrierung', erledigt: l.lokaleUstNr },
        { text: 'Steuersätze geprüft', erledigt: !!l.steuersaetzeGeprueftAm },
      ]
    : [
        { text: l.oss ? 'über OSS erklärt' : 'kein OSS', erledigt: l.oss },
        { text: 'Steuersätze geprüft', erledigt: !!l.steuersaetzeGeprueftAm },
      ];
  const hinweis =
    l.lagerSeit && !l.lokaleUstNr
      ? `Keine lokale USt-Registrierung erfasst, obwohl seit ${fmtMonatJahr(l.lagerSeit)} ein Lager besteht.`
      : l.lokaleUstNr
        ? `Lokale USt-Nummer erfasst${p9.lokaleUstNr.includes(l.land) ? ' (Geschäftsprofil P9)' : ''}.`
        : `Keine lokale Registrierung erfasst; Umsätze ${l.oss ? 'laufen über den OSS' : 'ohne OSS-Kennzeichen'}.`;
  return (
    <>
      <H rechts={<span className={REG_BADGE[l.registrierung]}>{REG_LABEL[l.registrierung]}</span>}>
        Registrierung
      </H>
      <ol className="flex flex-wrap gap-2 text-xs" aria-label="Schritte der Registrierung">
        {schritte.map((s) => (
          <li key={s.text} className="inline-flex items-center gap-1">
            <span className={s.erledigt ? 'badge-green' : 'badge-gray'}>
              {s.erledigt ? <Check className="h-3 w-3" aria-hidden="true" /> : '·'}
            </span>
            <TcmsText>{s.text}</TcmsText>
            <span className="sr-only">{s.erledigt ? ' (erledigt)' : ' (offen)'}</span>
          </li>
        ))}
      </ol>
      <div className="rounded-lg border border-dashed border-default p-3 space-y-1">
        <p className="flex items-start gap-2 text-sm text-secondary">
          <FileText className="h-4 w-4 shrink-0 mt-0.5 text-muted" aria-hidden="true" />
          {hinweis}
        </p>
        <p className="text-xs text-muted">
          Nachweise (z. B. Registrierungsbescheid) werden an der Durchführung des Lagerland-Monitors
          abgelegt. Geschäftsprofil P9: lokale USt-Nummern{' '}
          {p9.lokaleUstNr.length ? p9.lokaleUstNr.join(', ') : 'keine'}
          {p9.ossSeit ? ` · OSS seit ${fmtMonatJahr(p9.ossSeit)}` : ''}.
        </p>
      </div>
    </>
  );
}

function Frist({
  punkt,
  titel,
  plakette,
  text,
}: {
  punkt: string;
  titel: string;
  plakette: ReactNode;
  text: string;
}) {
  return (
    <li className="flex items-start gap-2">
      <span className={`status-dot mt-1.5 ${punkt}`} aria-hidden="true" />
      <span className="grow">
        <span className="flex justify-between gap-2 text-sm font-medium">
          {titel}
          {plakette}
        </span>
        <span className="block text-xs text-muted">{text}</span>
      </span>
    </li>
  );
}

function FristenAbschnitt({ l }: { l: Land }) {
  const fehlt = l.registrierung === 'FEHLT';
  const lokal = l.lokaleUstNr
    ? { punkt: 'dot-green', badge: 'badge-green', text: 'registriert' }
    : fehlt
      ? { punkt: 'dot-red', badge: 'badge-red', text: 'wartet auf Registrierung' }
      : { punkt: 'dot-gray', badge: 'badge-gray', text: 'keine Registrierung erfasst' };
  return (
    <>
      <H>Fristen im Land</H>
      <ul className="space-y-2">
        <Frist
          punkt={l.oss ? 'dot-green' : 'dot-gray'}
          titel="OSS-Erklärung"
          plakette={
            <span className={l.oss ? 'badge-green' : 'badge-gray'}>
              {l.oss ? 'über OSS' : 'kein OSS'}
            </span>
          }
          text="Abstimmung vor Abgabe und Fristenkontrolle über die Kontrollen des Programms"
        />
        {l.zmRelevant ? (
          <Frist
            punkt="dot-amber"
            titel="Zusammenfassende Meldung"
            plakette={<span className="badge-yellow">ZM-relevant</span>}
            text="Verbringens- und ZM-Abstimmung"
          />
        ) : null}
        <Frist
          punkt={lokal.punkt}
          titel="Lokale Umsatzsteuererklärungen"
          plakette={<span className={lokal.badge}>{lokal.text}</span>}
          text="Termine führt das Fristenkontrollbuch; die Anbindung der Steuertermine folgt."
        />
      </ul>
    </>
  );
}

function LandHistorie({ historie, namen }: { historie: readonly LandStand[]; namen: TcmsNamen }) {
  return (
    <>
      <H rechts={<span className="text-xs text-muted">{historie.length} Stände</span>}>Historie</H>
      <ol className="space-y-2">
        {historie.map((s, i) => {
          const vorher = historie[i + 1];
          const unterschiede = vorher ? standUnterschiede(vorher, s) : null;
          return (
            <li
              key={s.id}
              className={`border-l-2 pl-3 text-xs text-secondary ${i === 0 ? 'border-brand-600' : 'border-default'}`}
            >
              <span className="flex flex-wrap justify-between gap-2">
                <span>
                  <span className="font-mono font-semibold">{isoDatumText(s.stand)}</span> ·{' '}
                  {namen.name(s.erfasstVon)} · {s.quelle === 'CSV' ? 'CSV-Import' : 'manuell'}
                  {i === 0 ? <span className="badge-brand ml-1">maßgeblich</span> : null}
                </span>
                <span className="text-muted">erfasst {isoZeitText(s.createdAt)}</span>
              </span>
              <span className="mt-1 flex flex-wrap gap-1">
                <StandUnterschiede stand={s} unterschiede={unterschiede} />
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function StandUnterschiede({
  stand: s,
  unterschiede,
}: {
  stand: LandStand;
  unterschiede: string[] | null;
}) {
  if (unterschiede === null) {
    return (
      <span className="text-muted">
        Erster Stand: {fmtEurGanz(s.fernverkaeufeLfdEur)} lfd. · Vorjahr{' '}
        {fmtEurGanz(s.fernverkaeufeVorjahrEur)} · Lager{' '}
        {s.lagerSeit ? fmtMonatJahr(s.lagerSeit) : '–'} · {REG_LABEL[s.registrierung]}
      </span>
    );
  }
  if (unterschiede.length === 0)
    return <span className="text-muted">unverändert fortgeschrieben</span>;
  return (
    <>
      {unterschiede.map((u) => (
        <span key={u} className="badge-gray">
          {u}
        </span>
      ))}
    </>
  );
}

/** Bezüge eines Landes laut Dienst, mit Links der Seite (null: nicht im Kontext auflösbar). */
export interface LandBezugAnzeige {
  risiken: readonly { code: string; grund: string; href: string | null }[];
  kontrollen: readonly { code: string; href: string | null }[];
  ereignisse: readonly { id: string; text: string; href: string | null }[];
}

function BezugLink({ href, children }: { href: string | null; children: ReactNode }) {
  return href ? (
    <Link href={href} className="font-medium underline">
      {children}
    </Link>
  ) : (
    <span className="font-medium">{children}</span>
  );
}

function BezuegeAbschnitt({ bezug }: { bezug: LandBezugAnzeige | null }) {
  const leer =
    !bezug ||
    (bezug.risiken.length === 0 && bezug.kontrollen.length === 0 && bezug.ereignisse.length === 0);
  return (
    <section aria-label="Bezüge im Tax-CMS">
      <H>Bezüge im Tax-CMS</H>
      {leer ? (
        <p className="text-xs text-muted">
          Keine Risiken, Kontrollen oder Ereignisse zu diesem Land.
        </p>
      ) : (
        <dl className="space-y-2 text-sm">
          {bezug.risiken.length ? (
            <div>
              <dt className="text-xs text-muted">Risiken</dt>
              <dd>
                <ul className="space-y-0.5">
                  {bezug.risiken.map((r) => (
                    <li key={`${r.code}-${r.grund}`}>
                      <BezugLink href={r.href}>{r.code}</BezugLink>
                      <span className="text-secondary">
                        {' '}
                        – <TcmsText>{r.grund}</TcmsText>
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          {bezug.kontrollen.length ? (
            <div>
              <dt className="text-xs text-muted">Kontrollen</dt>
              <dd>
                <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {bezug.kontrollen.map((k) => (
                    <li key={k.code}>
                      <BezugLink href={k.href}>{k.code}</BezugLink>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          {bezug.ereignisse.length ? (
            <div>
              <dt className="text-xs text-muted">Ereignisse</dt>
              <dd>
                <ul className="space-y-0.5">
                  {bezug.ereignisse.map((e) => (
                    <li key={e.id}>
                      <BezugLink href={e.href}>
                        <TcmsText>{e.text}</TcmsText>
                      </BezugLink>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
        </dl>
      )}
    </section>
  );
}

export function LandDetailBereich({
  l,
  historie,
  feststellungen,
  bezug,
  profil,
  namen,
  sperre,
  feststellungHref,
  schliessenHref,
  formular,
}: {
  l: Land;
  historie: readonly LandStand[];
  feststellungen: readonly Feststellung[];
  /** Bezüge laut Dienst (`bezuege`), null wenn der Dienst keine führt. */
  bezug: LandBezugAnzeige | null;
  profil: KontextAntwort['profil'];
  namen: TcmsNamen;
  sperre: string | null;
  feststellungHref: (id: string) => string;
  schliessenHref: string;
  /** Formular „neuer Stand“ (nur ohne Sperre). */
  formular: ReactNode;
}) {
  const art = lagerArt(profil, l.land);
  const lager = l.lagerSeit
    ? ` · Lager seit ${fmtMonatJahr(l.lagerSeit)}${art ? ` (${art})` : ''}`
    : ' · kein Lager';
  return (
    <DetailBereich
      id={`tcms-land-${l.land}`}
      titel={`${l.land} – Registrierungen und Fristen`}
      schliessenHref={schliessenHref}
      plaketten={<span className={REG_BADGE[l.registrierung]}>{REG_LANG[l.registrierung]}</span>}
      unterzeile={
        <>
          {LAND_NAME[l.land] ?? l.land}
          {lager} · {l.oss ? 'OSS aktiv' : 'kein OSS'} · Stand {isoDatumText(l.stand)}
        </>
      }
    >
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {(
          [
            [fmtEurGanz(l.fernverkaeufeLfdEur), 'Fernverkäufe lfd. Jahr'],
            [fmtEurGanz(l.fernverkaeufeVorjahrEur), 'Vorjahr'],
            [l.zmRelevant ? 'ja' : 'nein', 'ZM-relevante Bewegungen'],
          ] as const
        ).map(([wert, label]) => (
          <div key={label} className="flex flex-col-reverse rounded-lg border border-default p-3">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="font-mono font-semibold text-primary">{wert}</dd>
          </div>
        ))}
      </dl>
      <RegistrierungAbschnitt l={l} feststellungen={feststellungen} profil={profil} />
      {feststellungen.map((f) => (
        <div key={f.id} className="alert-warning flex items-start gap-3">
          <Flame className="h-5 w-5 shrink-0" aria-hidden="true" />
          <p className="text-sm">
            Feststellung{' '}
            <Link href={feststellungHref(f.id)} className="font-semibold underline">
              {f.nummer}
            </Link>
            <span className="block text-xs">
              „<TcmsText>{f.titel}</TcmsText>“ · {FESTSTELLUNG_STATUS_LABEL[f.status]}
              {f.p153Offen ? ' · §-153-Würdigung offen' : ''}
            </span>
          </p>
        </div>
      ))}
      <BezuegeAbschnitt bezug={bezug} />
      <FristenAbschnitt l={l} />
      <LandHistorie historie={historie} namen={namen} />
      <H>Neuen Stand erfassen</H>
      <SperrHinweis grund={sperre} />
      {sperre ? null : formular}
    </DetailBereich>
  );
}
