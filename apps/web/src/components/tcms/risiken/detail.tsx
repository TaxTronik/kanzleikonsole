// =============================================================================
// Detailbereich eines Risikos (TCMS Stufe 3, portiert aus der Demo
// components/risiken/drawer.tsx). Anzeige von `GET …/risiken/:risikoId`
// (Stände, Kontrollen, Audit) und des Eintrags aus dem Inventar; Kontrollen,
// Ereignisse und Feststellungen aus dem Kontext; Namen aus der kanzleikonsole.
//
// Aktionen: neu bewerten, Bewertung bestätigen, übersteuern, Übersteuerung
// entscheiden, einreichen, freigeben, zurückweisen, Risikoakzeptanz anfordern.
// Vier-Augen-Anzeige: Wer beantragt bzw. eingereicht hat, sieht den Antrag
// mit Namen, bekommt die Entscheidung aber nicht angeboten; entscheidend
// bleibt der Dienst (TCMS-DIENST-001). Maskierte Feststellungen nennen keine
// Risikocodes und erscheinen deshalb hier nicht (RT-01).
// =============================================================================

import Link from 'next/link';
import { CalendarClock, Check, CheckCheck, Pencil, RefreshCw, Send } from 'lucide-react';
import type { KontextAntwort, RisikoDetail, RisikoEintrag } from '@taxtronik/tcms-contract';
import {
  EREIGNIS_STATUS_BADGE,
  EREIGNIS_STATUS_LABEL,
  FOLGE_LABEL,
  GOVERNANCE_ERKLAERUNG,
  GOVERNANCE_LABEL,
  GOVERNANCE_TYPEN,
  GRUPPE_LABEL,
  katalogRisiko,
  KLASSE_LABEL,
  KLASSE_RANG,
  KLASSEN,
  KONTROLLART_LABEL,
  NORMSTUFE_BADGE,
  NORMSTUFE_LABEL,
  REICHWEITE_LABEL,
  SCHADEN_LABEL,
  SCHAEDEN,
  WAHRSCHEINLICHKEIT_LABEL,
  WAHRSCHEINLICHKEITEN,
  type FolgeArt,
} from '@taxtronik/tcms-domain';
import type { TcmsNamen } from '@/server/tcms/namen';
import type { TcmsSeitenZustand } from '@/server/tcms/zustand';
import { KlasseBadge } from '../badges';
import { AktionsKnopf, AuswahlFeld, BegruendungsDialog } from '../bereich-b/aktion';
import { empfaengerLabel, KEIN_EMPFAENGER_MIT_PORTALZUGANG } from '../empfaenger';
import { Abschnitt, DetailBereich, DetailZustand, SperrHinweis } from '../bereich-b/detail';
import type { TcmsAktion } from '../bereich-b/ergebnis';
import { mitStand, selbstBeantragt } from '../bereich-b/seite';
import { isoDatumText, isoZeitText } from '../format';
import { DesignBadge, DurchfuehrungBadge } from '../kontrollen/badges';
import { BETRIEB_BADGE, BETRIEB_KURZ, BETRIEB_LABEL } from '../kontrollen/labels';
import { badgeKlasse } from '../ton';
import { zustellungGescheitert, ZustellungAnzeige, zustellungText } from '../zustellung';
import {
  AKZEPTANZ_STATUS_BADGE,
  AKZEPTANZ_STATUS_LABEL,
  kurzName,
  mindestfrequenzText,
  RISIKO_AUDIT_LABEL,
  RISIKO_FREIGABE_BADGE,
  RISIKO_FREIGABE_LABEL,
  RISIKO_FREIGABE_SCHRITTE,
  risikoAuditText,
  SICHT_LABEL,
  UEBERSTEUERUNG_STATUS_BADGE,
  UEBERSTEUERUNG_STATUS_LABEL,
} from './labels';
import { TcmsText } from '@/components/tcms/text';

export interface RisikoAktionen {
  neuBewerten: TcmsAktion;
  bestaetigen: TcmsAktion;
  uebersteuern: TcmsAktion;
  entscheiden: TcmsAktion;
  freigabeSchritt: TcmsAktion;
  zurueckweisen: TcmsAktion;
  akzeptanz: TcmsAktion;
}

export interface GesetzlicheVertretung {
  id: string;
  name: string;
  funktion: string | null;
  /** Aktiver Portalzugang (kk-tcms-s11): sonst nicht wählbar, mit Hinweis. */
  portal: boolean;
}

/** Gemeinsame Angaben aller Abschnitte des Detailbereichs. */
interface Teil {
  r: RisikoEintrag;
  daten: RisikoDetail | null;
  ctx: KontextAntwort;
  alle: readonly RisikoEintrag[];
  namen: TcmsNamen;
  ich: string;
  sperre: string | null;
  basis: string;
  betriebAktiv: boolean;
  link: (href: string) => string;
  detailHref: (risikoId: string) => string;
  aktionen: RisikoAktionen;
  vertretung: readonly GesetzlicheVertretung[];
}

/** Datum mit Uhrzeit; reine Tagesdaten (UTC-Mitternacht) ohne Uhrzeit. */
function zeitpunkt(iso: string | null | undefined): string {
  return iso && /T00:00:00(\.000)?Z$/.test(iso) ? isoDatumText(iso) : isoZeitText(iso);
}

export function RisikoDetailBereich({
  r,
  detail,
  ctx,
  alle,
  namen,
  ich,
  sperre,
  basis,
  stand,
  detailHref,
  schliessenHref,
  aktionen,
  vertretung,
}: {
  r: RisikoEintrag;
  detail: { ok: true; daten: RisikoDetail } | { ok: false; zustand: TcmsSeitenZustand } | null;
  ctx: KontextAntwort;
  alle: readonly RisikoEintrag[];
  namen: TcmsNamen;
  /** Staff-ID der angemeldeten Person (Vier-Augen-Anzeige). */
  ich: string;
  sperre: string | null;
  basis: string;
  stand: string | null;
  detailHref: (risikoId: string) => string;
  schliessenHref: string;
  aktionen: RisikoAktionen;
  /** Gesetzliche Vertretung (Kontakte dieses Mandanten mit aktiver Rolle). */
  vertretung: readonly GesetzlicheVertretung[];
}) {
  const t: Teil = {
    r,
    daten: detail?.ok ? detail.daten : null,
    ctx,
    alle,
    namen,
    ich,
    sperre,
    basis,
    betriebAktiv: !!ctx.programm?.wirksamAb && ctx.programm.wirksamAb.slice(0, 10) <= ctx.stand,
    link: (href) => mitStand(href, stand),
    detailHref,
    aktionen,
    vertretung,
  };
  const b = r.bewertung;
  return (
    <DetailBereich
      id={`tcms-risiko-${r.id}`}
      kennung={r.code}
      titel={r.titel}
      schliessenHref={schliessenHref}
      plaketten={
        <>
          <span className={RISIKO_FREIGABE_BADGE[r.freigabe]}>
            {RISIKO_FREIGABE_LABEL[r.freigabe]}
          </span>
          {r.hinweise.length > 0 ? (
            <span className="badge-yellow gap-1">
              <RefreshCw className="h-3 w-3" aria-hidden="true" /> neu bewerten
            </span>
          ) : null}
        </>
      }
      unterzeile={
        <>
          Gruppe {r.gruppe} · Governance-Typ {r.gt} · Brutto {KLASSE_LABEL[b.brutto.klasse]} · Netto{' '}
          {t.betriebAktiv ? 'Betrieb' : 'Design'} {KLASSE_LABEL[r.netto]} · Verantwortlich:{' '}
          {namen.name(r.ownerId)}
        </>
      }
    >
      <SperrHinweis grund={sperre} />
      {detail && !detail.ok ? <DetailZustand zustand={detail.zustand} /> : null}
      <NeuBewertenHinweis t={t} />
      <BeschreibungAbschnitte t={t} />
      <BewertungAbschnitt t={t} />
      <HerleitungAbschnitt t={t} />
      <AppetitAbschnitt t={t} />
      <UebersteuerungenAbschnitt t={t} />
      <FreigabeAbschnitt t={t} />
      <InterdependenzAbschnitt t={t} />
      <EreignisseAbschnitt t={t} />
      <StaendeAbschnitt t={t} />
      <HistorieAbschnitt t={t} />
      <p className="text-xs text-muted">
        Gruppe {GRUPPE_LABEL[r.gruppe]} · Klassen berechnet das Tax-CMS, sie werden nie
        überschrieben. Statusangaben sind Betriebsinformationen.
        {KLASSE_RANG[b.nettoBetrieb.klasse] > KLASSE_RANG[b.nettoDesign.klasse]
          ? ' Netto (Betrieb) liegt über Netto (Design), weil ein Kontrollabschlag im Betrieb entfällt.'
          : ''}
      </p>
    </DetailBereich>
  );
}

// ---------------------------------------------------------------------------
// Bewertung erfassen / bestätigen
// ---------------------------------------------------------------------------

function NeuBewertenDialog({ t }: { t: Teil }) {
  const { r } = t;
  return (
    <BegruendungsDialog
      ausloeser={
        <>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />{' '}
          {r.freigabe === 'IDENTIFIZIERT' ? 'Bewertung erfassen …' : 'Neu bewerten …'}
        </>
      }
      titel={`${r.code} neu bewerten`}
      hinweis={`Der aktuelle Stand wird mit Gültig-bis geschlossen und ein neuer Stand angelegt (Modell ${r.bewertung.modell}). Geänderte Werte brauchen eine erneute Freigabe durch eine zweite Person. Ändern sich Governance-Typ oder Bruttoklasse, plant das Tax-CMS künftige Durchführungen der verknüpften Kontrollen neu.`}
      aktion={t.aktionen.neuBewerten}
      felder={{ risikoId: r.id, standId: r.standId }}
      bestaetigen="Neuen Stand speichern"
      vierAugen={false}
      gesperrt={t.sperre}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <AuswahlFeld
          name="s"
          label="Schadensintensität (S)"
          defaultValue={r.s}
          optionen={SCHAEDEN.map((s) => ({ wert: s, label: `${s} – ${SCHADEN_LABEL[s]}` }))}
        />
        <AuswahlFeld
          name="w"
          label="Wahrscheinlichkeit (W)"
          defaultValue={r.w}
          optionen={WAHRSCHEINLICHKEITEN.map((w) => ({
            wert: w,
            label: WAHRSCHEINLICHKEIT_LABEL[w],
          }))}
        />
        <AuswahlFeld
          name="r"
          label="Reichweite (R)"
          defaultValue={String(r.r)}
          optionen={([1, 2, 3] as const).map((x) => ({
            wert: String(x),
            label: REICHWEITE_LABEL[x],
          }))}
        />
        <AuswahlFeld
          name="gt"
          label="Governance-Typ"
          defaultValue={r.gt}
          optionen={GOVERNANCE_TYPEN.map((g) => ({ wert: g, label: GOVERNANCE_LABEL[g] }))}
        />
      </div>
      {r.hinweise.length > 0 ? (
        <p className="alert-warning text-xs">Anlass: {r.hinweise.map((h) => h.text).join(' · ')}</p>
      ) : null}
    </BegruendungsDialog>
  );
}

function BestaetigenDialog({ t }: { t: Teil }) {
  const { r } = t;
  return (
    <BegruendungsDialog
      ausloeser={
        <>
          <Check className="h-3.5 w-3.5" aria-hidden="true" /> Bewertung bestätigen …
        </>
      }
      titel={`${r.code} · Bewertung unverändert bestätigen`}
      hinweis="Der aktuelle Stand wird mit denselben Werten fortgeschrieben; der Anlass für „neu bewerten“ ist damit erledigt."
      aktion={t.aktionen.bestaetigen}
      felder={{ risikoId: r.id, standId: r.standId }}
      bestaetigen="Bewertung bestätigen"
      vierAugen={false}
      gesperrt={
        t.sperre ?? (r.freigabe === 'IDENTIFIZIERT' ? 'Zuerst die Bewertung erfassen.' : null)
      }
    />
  );
}

function NeuBewertenHinweis({ t }: { t: Teil }) {
  const { r } = t;
  if (r.hinweise.length === 0) return null;
  return (
    <div className="alert-warning space-y-2" role="note">
      <strong className="text-sm">Neu bewerten</strong>
      <ul className="text-xs space-y-1">
        {r.hinweise.map((h) => (
          <li key={h.text}>
            {h.ereignisId ? (
              <Link
                className="underline"
                href={t.link(`${t.basis}/ereignisse?e=${encodeURIComponent(h.ereignisId)}`)}
              >
                <TcmsText>{h.text}</TcmsText>
              </Link>
            ) : (
              h.text
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <NeuBewertenDialog t={t} />
        <BestaetigenDialog t={t} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Beschreibung, Anwendbarkeit, Normanker
// ---------------------------------------------------------------------------

function BeschreibungAbschnitte({ t }: { t: Teil }) {
  const { r, daten } = t;
  const kat = katalogRisiko(r.code);
  return (
    <>
      <Abschnitt titel="Beschreibung" offen>
        <p className="text-sm text-secondary">
          <span className="font-medium text-primary">Fehlerquelle:</span>{' '}
          <TcmsText>{r.fehlerquelle}</TcmsText> →{' '}
          <span className="font-medium text-primary">Folge:</span> <TcmsText>{r.folge}</TcmsText>
        </p>
      </Abschnitt>
      <Abschnitt titel="Anwendbarkeit">
        <div className="flex flex-wrap gap-2">
          {r.kern ? <span className="badge-gray">Kernrisiko – immer aktiv</span> : null}
          {r.vorschlagsgrund && !r.kern ? (
            <span className="badge-brand">
              <TcmsText>{r.vorschlagsgrund}</TcmsText>
            </span>
          ) : null}
          {r.herkunft === 'BERATER' ? (
            <span className="badge-gray">eigenes Risiko (Herkunft Berater)</span>
          ) : null}
        </div>
        <p className="text-xs text-muted">
          {kat ? `Katalog: anwendbar, wenn ${kat.anwendbarWenn}. ` : ''}
          {daten ? `Im Inventar seit ${isoDatumText(daten.aktivAb)}.` : ''}
        </p>
      </Abschnitt>
      <Abschnitt titel={`Normanker (${r.normanker.length})`}>
        {r.normanker.length === 0 ? (
          <p className="text-sm text-muted">Kein Normanker hinterlegt.</p>
        ) : (
          <ul className="space-y-1">
            {r.normanker.map((n) => (
              <li
                key={n.text}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span>
                  <TcmsText>{n.text}</TcmsText>
                </span>
                <span className={badgeKlasse(NORMSTUFE_BADGE[n.stufe])}>
                  {NORMSTUFE_LABEL[n.stufe]}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="alert-info-sm">
          Normanker und Katalogwerte sind ungeprüfte Entwürfe (Katalog v
          {t.ctx.programm?.paketVersion ?? '1.0'}); sie ersetzen keine Einzelfallprüfung. Normtexte
          werden nicht angezeigt.
        </p>
      </Abschnitt>
    </>
  );
}

// ---------------------------------------------------------------------------
// Bewertung
// ---------------------------------------------------------------------------

function NettoPlakette({ t, sicht }: { t: Teil; sicht: 'DESIGN' | 'BETRIEB' }) {
  const b = t.r.bewertung;
  const wirksam = sicht === 'DESIGN' ? b.wirksamDesign : b.wirksamBetrieb;
  const berechnet = sicht === 'DESIGN' ? b.nettoDesign : b.nettoBetrieb;
  const uebersteuert = sicht === 'DESIGN' ? b.uebersteuertDesign : b.uebersteuertBetrieb;
  return (
    <>
      <span className="text-xs text-muted">{SICHT_LABEL[sicht]}</span>
      <KlasseBadge klasse={wirksam} uebersteuert={uebersteuert} title={berechnet.erklaerung} />
      {uebersteuert ? (
        <span className="text-xs text-muted">berechnet {KLASSE_LABEL[berechnet.klasse]}</span>
      ) : null}
    </>
  );
}

function UebersteuernDialog({ t }: { t: Teil }) {
  const { r } = t;
  const b = r.bewertung;
  const offen = r.uebersteuerungen.filter((u) => u.status === 'BEANTRAGT');
  const sichtenFrei = (['DESIGN', 'BETRIEB'] as const).filter(
    (s) => !offen.some((u) => u.sicht === s),
  );
  return (
    <BegruendungsDialog
      ausloeser={
        <>
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Übersteuern …
        </>
      }
      titel={`${r.code} · Nettoklasse übersteuern`}
      hinweis="Die Übersteuerung ist ein eigenes Objekt; der berechnete Wert bleibt sichtbar. Sie gilt erst nach Freigabe durch eine zweite Person."
      aktion={t.aktionen.uebersteuern}
      felder={{ risikoId: r.id }}
      bestaetigen="Übersteuerung beantragen"
      gesperrt={
        t.sperre ??
        (sichtenFrei.length === 0
          ? 'Für beide Sichten ist bereits eine Übersteuerung beantragt.'
          : null)
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <AuswahlFeld
          name="sicht"
          label="Sicht"
          platzhalter="bitte wählen"
          optionen={sichtenFrei.map((s) => ({
            wert: s,
            label: `${SICHT_LABEL[s]} (berechnet: ${KLASSE_LABEL[s === 'DESIGN' ? b.nettoDesign.klasse : b.nettoBetrieb.klasse]})`,
          }))}
        />
        <AuswahlFeld
          name="klasse"
          label="Zielklasse"
          platzhalter="bitte wählen"
          optionen={KLASSEN.map((k) => ({ wert: k, label: KLASSE_LABEL[k] }))}
        />
      </div>
    </BegruendungsDialog>
  );
}

function BewertungAbschnitt({ t }: { t: Teil }) {
  const { r } = t;
  const b = r.bewertung;
  const turnus = t.ctx.programm?.erklaerungsTurnus ?? 'MONATLICH';
  return (
    <Abschnitt titel="Bewertung" offen>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="label-sm">Schadensintensität (S)</dt>
          <dd>
            {r.s} – {SCHADEN_LABEL[r.s]}
          </dd>
        </div>
        <div>
          <dt className="label-sm">Wahrscheinlichkeit (W)</dt>
          <dd>{WAHRSCHEINLICHKEIT_LABEL[r.w]}</dd>
        </div>
        <div>
          <dt className="label-sm">Reichweite (R)</dt>
          <dd>{REICHWEITE_LABEL[r.r]}</dd>
        </div>
        <div>
          <dt className="label-sm">Governance-Typ</dt>
          <dd title={GOVERNANCE_ERKLAERUNG[r.gt]}>{GOVERNANCE_LABEL[r.gt]}</dd>
        </div>
      </dl>
      <p className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="text-xs text-muted">Brutto</span>
        <KlasseBadge klasse={b.brutto.klasse} title={b.brutto.erklaerung} />
        <span className="text-muted" aria-hidden="true">
          →
        </span>
        <NettoPlakette t={t} sicht="DESIGN" />
        <span className="text-muted" aria-hidden="true">
          →
        </span>
        <NettoPlakette t={t} sicht="BETRIEB" />
      </p>
      <ul className="text-xs text-muted space-y-0.5">
        <li>
          <span className="font-medium text-secondary">Brutto:</span>{' '}
          <TcmsText>{b.brutto.erklaerung}</TcmsText>
        </li>
        <li>
          <span className="font-medium text-secondary">Netto (Design):</span>{' '}
          <TcmsText>{b.nettoDesign.erklaerung}</TcmsText>
          {b.nettoDesign.zaehlend.length ? ` (${b.nettoDesign.zaehlend.join(', ')})` : ''}
        </li>
        <li>
          <span className="font-medium text-secondary">Netto (Betrieb):</span>{' '}
          <TcmsText>{b.nettoBetrieb.erklaerung}</TcmsText>
          {b.nettoBetrieb.zaehlend.length ? ` (${b.nettoBetrieb.zaehlend.join(', ')})` : ''}
        </li>
        <li>
          Modell <TcmsText>{b.modell}</TcmsText> · Stand gültig ab {zeitpunkt(r.gueltigAb)} · Der
          Governance-Typ verändert die Klasse nicht.
        </li>
      </ul>
      <p className="inline-flex items-center gap-1.5 text-sm">
        <CalendarClock className="h-4 w-4 text-muted" aria-hidden="true" />
        Manuell prüfen (Mindestfrequenz, Vorschau nach Häufigkeitsmatrix):{' '}
        {mindestfrequenzText(r.gt, b.brutto.klasse, turnus)}
      </p>
      <div className="flex flex-wrap gap-2">
        {r.hinweise.length === 0 ? <NeuBewertenDialog t={t} /> : null}
        {r.hinweise.length === 0 ? <BestaetigenDialog t={t} /> : null}
        <UebersteuernDialog t={t} />
      </div>
    </Abschnitt>
  );
}

// ---------------------------------------------------------------------------
// Herleitung über Kontrollen
// ---------------------------------------------------------------------------

function HerleitungAbschnitt({ t }: { t: Teil }) {
  const { r, daten } = t;
  const b = r.bewertung;
  const kontrolleJe = new Map(t.ctx.kontrollen.map((k) => [k.id, k]));
  return (
    <Abschnitt
      titel={`Brutto/Netto-Herleitung · Kontrollen (${daten?.kontrollen.length ?? r.kontrollIds.length})`}
      offen
    >
      {r.kontrollIds.length === 0 ? (
        <p className="alert-error-sm">Keine Kontrolle zugeordnet – Netto = Brutto.</p>
      ) : !daten ? (
        <p className="text-sm text-muted">Die Kontrollen sind gerade nicht abrufbar.</p>
      ) : (
        <ul className="space-y-2">
          {daten.kontrollen.map((k) => {
            const voll = kontrolleJe.get(k.id);
            return (
              <li key={k.id} className="flex flex-wrap items-start justify-between gap-2">
                <span className="flex flex-col">
                  <Link
                    href={t.link(`${t.basis}/kontrollen?kontrolle=${encodeURIComponent(k.id)}`)}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    {k.code} · <TcmsText>{k.titel}</TcmsText>
                  </Link>
                  <span className="text-xs text-muted">
                    {KONTROLLART_LABEL[k.art]}
                    {k.schluessel ? ' · Schlüsselkontrolle' : ''} · Design{' '}
                    {b.nettoDesign.zaehlend.includes(k.code) ? 'zählt' : 'zählt nicht'} · Betrieb{' '}
                    {b.nettoBetrieb.zaehlend.includes(k.code) ? 'zählt' : 'zählt nicht'}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-1">
                  <DesignBadge
                    design={k.design}
                    von={t.namen.name(voll?.designVon ?? null)}
                    am={voll?.designAm ?? null}
                    begruendung={voll?.designBegruendung ?? null}
                    kurz
                  />
                  <span className={BETRIEB_BADGE[k.betrieb]} title={BETRIEB_LABEL[k.betrieb]}>
                    Betrieb: {BETRIEB_KURZ[k.betrieb]}
                  </span>
                  {voll?.letzte ? <DurchfuehrungBadge d={voll.letzte} /> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted">
        Netto (Design): Abschlag bei angemessen beurteilten Kontrollen; Netto (Betrieb): Abschlag
        nur bei letzter fälliger Durchführung ohne Befund und gegengezeichnet. Die Klassen berechnet
        das Tax-CMS.{' '}
        {t.betriebAktiv
          ? 'Für den Risikoappetit gilt Netto (Betrieb).'
          : 'Vor Beginn des Wirksamkeitszeitraums gilt für den Risikoappetit Netto (Design).'}
      </p>
    </Abschnitt>
  );
}

// ---------------------------------------------------------------------------
// Risikoappetit und Akzeptanz
// ---------------------------------------------------------------------------

function AkzeptanzDialog({ t }: { t: Teil }) {
  const { r, namen } = t;
  const offen = r.akzeptanzen.find((a) => a.status === 'OFFEN');
  const grund =
    t.sperre ??
    (offen
      ? `Bereits angefordert am ${isoDatumText(offen.angefordertAm)} – wartet auf ${namen.name(offen.empfaengerId)}.${
          zustellungGescheitert(offen.zustellung) && offen.zustellung
            ? ` ${zustellungText(offen.zustellung)} – bitte unter Kommunikation neu adressieren.`
            : ''
        }`
      : t.vertretung.length === 0
        ? 'Beim Mandanten ist keine gesetzliche Vertretung mit aktiver Rolle hinterlegt.'
        : t.vertretung.every((p) => !p.portal)
          ? KEIN_EMPFAENGER_MIT_PORTALZUGANG
          : null);
  return (
    <BegruendungsDialog
      ausloeser={
        <>
          <Send className="h-3.5 w-3.5" aria-hidden="true" /> Risikoakzeptanz anfordern …
        </>
      }
      titel={`Risikoakzeptanz ${r.code} anfordern`}
      hinweis="Die Freigabe im Portal erteilt nur die gesetzliche Vertretung (Bestätigung per E-Mail-Code). Die Erläuterung erscheint dort im Wortlaut."
      aktion={t.aktionen.akzeptanz}
      felder={{ risikoId: r.id }}
      bestaetigen="Im Portal anfordern"
      begruendungLabel="Erläuterung der Kanzlei"
      vierAugen={false}
      gesperrt={grund}
    >
      <AuswahlFeld
        name="empfaengerId"
        label="Gesetzliche Vertretung"
        platzhalter="bitte wählen"
        optionen={t.vertretung.map((p) => ({
          wert: p.id,
          label: empfaengerLabel(p.name, p.portal, p.funktion ? ` (${p.funktion})` : ''),
          deaktiviert: !p.portal,
        }))}
      />
    </BegruendungsDialog>
  );
}

function AppetitAbschnitt({ t }: { t: Teil }) {
  const { r, namen } = t;
  const feststellungen = t.ctx.feststellungen.flatMap((f) =>
    !f.maskiert && f.risikoCodes.includes(r.code) ? [f] : [],
  );
  return (
    <Abschnitt
      titel="Risikoappetit"
      offen={r.ueberAppetit}
      rechts={
        r.ueberAppetit ? (
          <span className="badge-red">über Appetit</span>
        ) : (
          <span className="badge-green">im Appetit</span>
        )
      }
    >
      <p className="text-sm text-secondary">
        Risikoappetit laut Compliance-Zielen: <strong>{KLASSE_LABEL[t.ctx.appetit]}</strong> ·
        maßgebliche Nettoklasse ({t.betriebAktiv ? 'Betrieb' : 'Design'}):{' '}
        <strong>{KLASSE_LABEL[r.netto]}</strong>.
      </p>
      {r.ueberAppetit ? (
        <p className="alert-warning text-sm">
          Liegt ein Risiko über dem Appetit, ist eine Maßnahme oder eine Risikoakzeptanz durch die
          gesetzlichen Vertreter (Portal) erforderlich.
        </p>
      ) : null}
      {feststellungen.length > 0 ? (
        <div>
          <p className="label-sm">Feststellungen und Maßnahmen</p>
          <ul className="space-y-1">
            {feststellungen.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  href={t.link(`${t.basis}/feststellungen/${encodeURIComponent(f.id)}`)}
                  className="text-sm hover:underline"
                >
                  <span className="font-mono">{f.nummer}</span> · <TcmsText>{f.titel}</TcmsText>
                </Link>
                <span className={f.massnahmenOffen ? 'badge-yellow' : 'badge-gray'}>
                  {f.massnahmenOffen
                    ? `${f.massnahmenOffen} Maßnahmen offen`
                    : `${f.massnahmen} Maßnahmen`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {r.akzeptanzen.length > 0 ? (
        <div>
          <p className="label-sm">Risikoakzeptanz</p>
          <ul className="space-y-1">
            {r.akzeptanzen.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-secondary">
                  angefordert {zeitpunkt(a.angefordertAm)} von {namen.name(a.angefordertVon)} bei{' '}
                  {namen.name(a.empfaengerId)}
                  {a.erledigtAm ? ` · entschieden ${zeitpunkt(a.erledigtAm)}` : ''}
                  {a.anmerkung ? (
                    <>
                      {' '}
                      · „<TcmsText>{a.anmerkung}</TcmsText>“
                    </>
                  ) : null}
                </span>
                <span className={AKZEPTANZ_STATUS_BADGE[a.status]}>
                  {AKZEPTANZ_STATUS_LABEL[a.status]}
                </span>
                {a.zustellung ? (
                  <div className="basis-full">
                    <ZustellungAnzeige zustellung={a.zustellung} />
                    {a.status === 'OFFEN' && zustellungGescheitert(a.zustellung) ? (
                      <p className="text-xs text-secondary mt-1">
                        Die gesetzliche Vertretung hat die Anforderung nicht erhalten.{' '}
                        {t.sperre === null ? (
                          <Link href={`${t.basis}/kommunikation`} className="underline">
                            Neu adressieren (Kommunikation)
                          </Link>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {r.ueberAppetit ? <AkzeptanzDialog t={t} /> : null}
    </Abschnitt>
  );
}

// ---------------------------------------------------------------------------
// Übersteuerungen (Vier-Augen)
// ---------------------------------------------------------------------------

type Uebersteuerung = RisikoEintrag['uebersteuerungen'][number];

function UebersteuerungEntscheidung({ t, u }: { t: Teil; u: Uebersteuerung }) {
  if (u.status !== 'BEANTRAGT') return null;
  if (selbstBeantragt(t.ich, u.beantragtVon)) {
    return (
      <p className="text-xs text-muted" role="note">
        Von Ihnen beantragt – die Entscheidung trifft eine zweite Person.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-start gap-2">
      <AktionsKnopf
        aktion={t.aktionen.entscheiden}
        felder={{ uebersteuerungId: u.id, entscheidung: 'FREIGEBEN' }}
        beschriftung={
          <>
            <Check className="h-3.5 w-3.5" aria-hidden="true" /> Übersteuerung freigeben
          </>
        }
        gesperrt={t.sperre}
      />
      <BegruendungsDialog
        ausloeser="Ablehnen …"
        titel="Übersteuerung ablehnen"
        aktion={t.aktionen.entscheiden}
        felder={{ uebersteuerungId: u.id, entscheidung: 'ABLEHNEN' }}
        bestaetigen="Ablehnen"
        vierAugen={false}
        gefahr
        gesperrt={t.sperre}
      />
    </div>
  );
}

function UebersteuerungenAbschnitt({ t }: { t: Teil }) {
  const { r, namen } = t;
  const offen = r.uebersteuerungen.filter((u) => u.status === 'BEANTRAGT');
  const wirksam = (u: Uebersteuerung) =>
    r.uebersteuerungen.find((x) => x.sicht === u.sicht && x.status === 'FREIGEGEBEN')?.id === u.id;
  return (
    <Abschnitt
      titel={`Übersteuerungen (${r.uebersteuerungen.length})`}
      offen={offen.length > 0}
      rechts={
        offen.length > 0 ? <span className="badge-purple">{offen.length} beantragt</span> : null
      }
    >
      {r.uebersteuerungen.length === 0 ? (
        <p className="text-sm text-muted">
          Keine Übersteuerung. Es gelten die berechneten Nettoklassen.
        </p>
      ) : (
        <ul className="space-y-3">
          {r.uebersteuerungen.map((u) => (
            <li key={u.id} className="border-t border-default pt-2 space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex flex-wrap items-center gap-1 text-sm">
                  <span className="font-medium">{SICHT_LABEL[u.sicht]}:</span>
                  <KlasseBadge klasse={u.berechnet} title="berechnet zum Antrag" />
                  <span aria-hidden="true">→</span>
                  <span className="sr-only">übersteuert auf</span>
                  <KlasseBadge klasse={u.klasse} uebersteuert />
                </span>
                <span className="inline-flex gap-1">
                  <span className={UEBERSTEUERUNG_STATUS_BADGE[u.status]}>
                    {UEBERSTEUERUNG_STATUS_LABEL[u.status]}
                  </span>
                  {u.status === 'FREIGEGEBEN' ? (
                    <span className={wirksam(u) ? 'badge-brand' : 'badge-gray'}>
                      {wirksam(u) ? 'gilt' : 'abgelöst'}
                    </span>
                  ) : null}
                </span>
              </div>
              <p className="text-xs text-secondary">
                „<TcmsText>{u.begruendung}</TcmsText>“
              </p>
              <p className="text-xs text-muted">
                beantragt von {namen.name(u.beantragtVon)} · {zeitpunkt(u.beantragtAm)}
                {u.entschiedenVon
                  ? ` · entschieden von ${namen.name(u.entschiedenVon)} · ${zeitpunkt(u.entschiedenAm)}`
                  : ''}
              </p>
              <UebersteuerungEntscheidung t={t} u={u} />
            </li>
          ))}
        </ul>
      )}
    </Abschnitt>
  );
}

// ---------------------------------------------------------------------------
// Freigabe des Risikos (Vier-Augen)
// ---------------------------------------------------------------------------

function FreigabeSchritte({ r }: { r: RisikoEintrag }) {
  const index = RISIKO_FREIGABE_SCHRITTE.indexOf(r.freigabe);
  const fertig = r.freigabe === 'FREIGEGEBEN';
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs" aria-label="Freigabeschritte">
      {RISIKO_FREIGABE_SCHRITTE.map((s, i) => {
        const erledigt = i < index || fertig;
        const aktuell = i === index && !fertig;
        return (
          <li
            key={s}
            className={`inline-flex items-center gap-1 ${aktuell ? 'font-semibold text-primary' : 'text-secondary'}`}
            aria-current={aktuell ? 'step' : undefined}
          >
            <span className={erledigt ? 'badge-green' : aktuell ? 'badge-brand' : 'badge-gray'}>
              {erledigt ? <Check className="h-3 w-3" aria-hidden="true" /> : i + 1}
            </span>
            {RISIKO_FREIGABE_LABEL[s]}
            {erledigt ? <span className="sr-only"> (erledigt)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function FreigabeBedienung({ t }: { t: Teil }) {
  const { r } = t;
  if (r.freigabe === 'IDENTIFIZIERT') {
    return (
      <p className="text-sm text-secondary">
        Zuerst die Bewertung erfassen („Bewertung erfassen …“ im Abschnitt Bewertung).
      </p>
    );
  }
  if (r.freigabe === 'BEWERTET') {
    return (
      <AktionsKnopf
        aktion={t.aktionen.freigabeSchritt}
        felder={{ risikoIds: r.id, schritt: 'einreichen' }}
        beschriftung={
          <>
            <Send className="h-3.5 w-3.5" aria-hidden="true" /> Zur Freigabe einreichen
          </>
        }
        gesperrt={t.sperre}
      />
    );
  }
  if (r.freigabe !== 'ZUR_FREIGABE') return null;
  if (selbstBeantragt(t.ich, r.freigabeEingereichtVon)) {
    return (
      <p className="text-xs text-muted" role="note">
        Von Ihnen eingereicht – die Freigabe erteilt eine zweite Person.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-start gap-2">
      <AktionsKnopf
        aktion={t.aktionen.freigabeSchritt}
        felder={{ risikoIds: r.id, schritt: 'freigeben' }}
        beschriftung={
          <>
            <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" /> Freigeben
          </>
        }
        gesperrt={t.sperre}
      />
      <BegruendungsDialog
        ausloeser="Zurückweisen …"
        titel={`${r.code} zurückweisen`}
        aktion={t.aktionen.zurueckweisen}
        felder={{ risikoId: r.id }}
        bestaetigen="Zurückweisen"
        vierAugen={false}
        gefahr
        gesperrt={t.sperre}
      />
    </div>
  );
}

function FreigabeAbschnitt({ t }: { t: Teil }) {
  const { r, namen } = t;
  return (
    <Abschnitt
      titel="Freigabe (Vier-Augen)"
      offen={r.freigabe !== 'FREIGEGEBEN'}
      rechts={
        <span className={RISIKO_FREIGABE_BADGE[r.freigabe]}>
          {RISIKO_FREIGABE_LABEL[r.freigabe]}
        </span>
      }
    >
      <FreigabeSchritte r={r} />
      <p className="text-xs text-muted">
        {r.freigabeEingereichtVon
          ? `Eingereicht von ${namen.name(r.freigabeEingereichtVon)}. `
          : ''}
        {r.freigabe === 'FREIGEGEBEN' && r.freigegebenVon
          ? `Freigegeben von ${namen.name(r.freigegebenVon)} · ${zeitpunkt(r.freigegebenAm)}. `
          : ''}
        Die Freigabe erteilt eine zweite Person mit Bearbeitungsrecht (nicht die einreichende). Eine
        geänderte Bewertung setzt den Status auf „bewertet“ zurück.
      </p>
      <FreigabeBedienung t={t} />
    </Abschnitt>
  );
}

// ---------------------------------------------------------------------------
// Interdependenzen, Ereignisse
// ---------------------------------------------------------------------------

function InterdependenzAbschnitt({ t }: { t: Teil }) {
  const { r, alle } = t;
  const beeinflusstVon = alle.filter((x) => x.wirktAuf.includes(r.code));
  return (
    <Abschnitt titel={`Interdependenzen (${r.wirktAuf.length + beeinflusstVon.length})`}>
      {r.wirktAuf.length + beeinflusstVon.length === 0 ? (
        <p className="text-sm text-muted">Keine Interdependenz im Katalog hinterlegt.</p>
      ) : null}
      {r.wirktAuf.length > 0 ? (
        <p className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted">wirkt auf</span>
          {r.wirktAuf.map((code) => {
            const ziel = alle.find((x) => x.code === code);
            return ziel ? (
              <Link
                key={code}
                href={t.detailHref(ziel.id)}
                scroll={false}
                className="badge-gray font-mono"
                title={ziel.titel}
              >
                {code}
              </Link>
            ) : (
              <span
                key={code}
                className="badge-gray font-mono opacity-70"
                title="nicht im Inventar"
              >
                {code}
              </span>
            );
          })}
        </p>
      ) : null}
      {beeinflusstVon.length > 0 ? (
        <p className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted">beeinflusst von</span>
          {beeinflusstVon.map((x) => (
            <Link
              key={x.id}
              href={t.detailHref(x.id)}
              scroll={false}
              className="badge-gray font-mono"
              title={x.titel}
            >
              {x.code}
            </Link>
          ))}
        </p>
      ) : null}
    </Abschnitt>
  );
}

function EreignisseAbschnitt({ t }: { t: Teil }) {
  const { r } = t;
  const ereignisse = t.ctx.ereignisse.filter((e) => e.folgen.some((f) => f.ziel === r.code));
  return (
    <Abschnitt
      titel={`Ereignisse (${ereignisse.length})`}
      rechts={
        r.offeneEreignisse > 0 ? (
          <span className="badge-yellow">{r.offeneEreignisse} offen</span>
        ) : null
      }
    >
      {ereignisse.length === 0 ? (
        <p className="text-sm text-muted">Kein Ereignis mit Bezug auf dieses Risiko.</p>
      ) : (
        <ul className="space-y-2">
          {ereignisse.map((e) => (
            <li key={e.id} className="space-y-0.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">
                  <Link
                    href={t.link(`${t.basis}/ereignisse?e=${encodeURIComponent(e.id)}`)}
                    className="font-mono font-medium hover:underline"
                  >
                    {e.typ}
                  </Link>{' '}
                  · <TcmsText>{e.titel}</TcmsText>
                </span>
                <span className={badgeKlasse(EREIGNIS_STATUS_BADGE[e.status])}>
                  {EREIGNIS_STATUS_LABEL[e.status]} · {isoDatumText(e.gemeldetAm)}
                </span>
              </div>
              {e.folgen
                .filter((f) => f.ziel === r.code)
                .map((f) => (
                  <p key={f.id} className="text-xs text-muted">
                    Folge: {FOLGE_LABEL[f.art as FolgeArt] ?? f.art} – <TcmsText>{f.text}</TcmsText>{' '}
                    ({f.status.toLowerCase()})
                  </p>
                ))}
            </li>
          ))}
        </ul>
      )}
    </Abschnitt>
  );
}

// ---------------------------------------------------------------------------
// Stände und Historie
// ---------------------------------------------------------------------------

function StaendeAbschnitt({ t }: { t: Teil }) {
  const { r, daten, namen } = t;
  return (
    <Abschnitt titel={`Stand-Historie (${daten?.staende.length ?? 0})`}>
      {daten && daten.staende.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <caption className="sr-only">Bewertungsstände von {r.code}</caption>
            <thead>
              <tr>
                <th scope="col" className="th">
                  gültig ab
                </th>
                <th scope="col" className="th">
                  gültig bis
                </th>
                <th scope="col" className="th">
                  S / W / R
                </th>
                <th scope="col" className="th">
                  GT
                </th>
                <th scope="col" className="th">
                  Brutto
                </th>
                <th scope="col" className="th">
                  Person
                </th>
              </tr>
            </thead>
            <tbody>
              {daten.staende.map((s) => {
                const person = namen.name(s.erstelltVon);
                return (
                  <tr
                    key={s.id}
                    className={`border-t border-default ${s.id === r.standId ? 'bg-surface-raised' : ''}`}
                  >
                    <td className="px-3 py-1.5 font-mono">{zeitpunkt(s.gueltigAb)}</td>
                    <td className="px-3 py-1.5 font-mono">
                      {s.gueltigBis ? (
                        zeitpunkt(s.gueltigBis)
                      ) : (
                        <span className="badge-brand">aktuell</span>
                      )}
                    </td>
                    <td
                      className="px-3 py-1.5"
                      title={`${SCHADEN_LABEL[s.s]} / ${WAHRSCHEINLICHKEIT_LABEL[s.w]} / ${REICHWEITE_LABEL[s.r]}`}
                    >
                      {s.s} / {WAHRSCHEINLICHKEIT_LABEL[s.w]} / {s.r}
                    </td>
                    <td className="px-3 py-1.5">{s.gt}</td>
                    <td className="px-3 py-1.5">
                      <KlasseBadge klasse={s.brutto} title={`Modell ${s.modell}`} />
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap" title={person}>
                      {namen.bekannt(s.erstelltVon) ? kurzName(person) : person}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted">Keine Stände bis zum Stichtag.</p>
      )}
      <p className="text-xs text-muted">
        Versionierte Stände werden nie geändert: Eine Neubewertung schließt den Stand mit Gültig-bis
        und legt einen neuen an.
      </p>
    </Abschnitt>
  );
}

function HistorieAbschnitt({ t }: { t: Teil }) {
  const { r, daten, namen } = t;
  return (
    <Abschnitt titel="Historie">
      {daten && daten.audit.length > 0 ? (
        <ul className="space-y-1">
          {daten.audit.map((a) => {
            const zusatz = risikoAuditText(a.detail, (id) => namen.name(id));
            return (
              <li key={a.pos} className="flex flex-wrap items-start gap-2 text-sm">
                <span className="text-xs font-mono text-muted shrink-0">{zeitpunkt(a.at)}</span>
                <span className="text-xs text-secondary shrink-0">{namen.name(a.actorId)}</span>
                <span className="grow">
                  {RISIKO_AUDIT_LABEL[a.aktion] ?? a.aktion}
                  {zusatz ? (
                    <span className="text-xs text-muted">
                      {' '}
                      · <TcmsText>{zusatz}</TcmsText>
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted">Keine protokollierten Änderungen bis zum Stichtag.</p>
      )}
      {daten ? (
        <p className="text-xs text-muted">
          {isoDatumText(daten.aktivAb)} · Risiko ins Inventar übernommen (
          {r.herkunft === 'KATALOG'
            ? `Katalog v${t.ctx.programm?.paketVersion ?? '1.0'}`
            : 'Herkunft Berater'}
          )
        </p>
      ) : null}
    </Abschnitt>
  );
}
