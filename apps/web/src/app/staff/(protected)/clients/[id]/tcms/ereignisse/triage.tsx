// =============================================================================
// Triage eines Ereignisses (TCMS Stufe 3, Bereich D; aus der Demo
// staff/clients/[id]/tcms/ereignisse/page.tsx, TriagePanel). Bindet die
// Aktionen an Mandant, Ereignis und Folge (gebundene Argumente) und zeigt die
// Antwort von `ereignisLesen`. Was die Oberfläche sperrt, ist Anzeige (Stichtag,
// Rechte-Kennzeichen des Kontexts, Status der Folgen laut Dienst); entscheidend
// bleibt das Tax-CMS, das jede Aktion selbst prüft. Abschließen, Verwerfen
// beantragen und Verwerfen bestätigen folgen seit TCMS s7 den Rechten am
// Ereignis (`rechte.abschliessen`, `rechte.verwerfen.*`: `erlaubt` und der
// Grund `verweigerung` des 403, den der Schritt jetzt erhielte): gesperrt
// sichtbar mit dem festen Text zum Grund (TCMS_KEIN_RECHT); steht nur der
// Zustand entgegen (`verweigerung: null`), ein fester Zustandshinweis.
//
// Vier-Augen beim Verwerfen: Wer den Antrag gestellt hat, bekommt keine
// Entscheidung angeboten, nur „Antrag zurückziehen“; die Bestätigung durch
// dieselbe Person weist der Dienst ohnehin ab (TCMS_KEIN_RECHT.VIER_AUGEN).
// =============================================================================

import Link from 'next/link';
import { FileText, History, Info, Lock, Plus } from 'lucide-react';
import type { EreignisDetailSchema, KontextAntwort } from '@taxtronik/tcms-contract';
import {
  EREIGNIS_STATUS_BADGE,
  EREIGNIS_STATUS_LABEL,
  ereignisErledigt,
  ereignistyp,
  FOLGE_LABEL,
  MIN_BEGRUENDUNG,
  type FolgeArt,
} from '@taxtronik/tcms-domain';
import type { z } from 'zod';
import { GtBadge, HashKurz, KlasseBadge } from '@/components/tcms/badges';
import { isoDatumText, isoZeitText } from '@/components/tcms/format';
import { KatalogIcon } from '@/components/tcms/icon';
import { badgeKlasse, tonChip } from '@/components/tcms/ton';
import {
  TcmsAktionsKnopf,
  TcmsFormDialog,
  TcmsFormular,
} from '@/components/tcms/ereignisse/aktionen';
import { FolgeZeile, VorschlagZeile, type PersonOption } from '@/components/tcms/ereignisse/folgen';
import { quelleText, typInfo, typKurz } from '@/components/tcms/ereignisse/texte';
import type { TcmsNamen } from '@/server/tcms/namen';
import { keinRechtText, type TcmsKeinRechtGrund } from '@/server/tcms/zustand';
import { tcmsTextBereinigen } from '@/server/tcms/zeichen';
import {
  ereignisAbschliessenAction,
  ereignisInPruefungNehmenAction,
  ereignisVerwerfenAblehnenAction,
  ereignisVerwerfenBeantragenAction,
  ereignisVerwerfenBestaetigenAction,
  folgeErledigenAction,
  folgeHinzufuegenAction,
  folgenAnlegenAction,
  folgeVerwerfenAction,
} from './actions';

export type EreignisDetail = z.infer<typeof EreignisDetailSchema>;

const FOLGE_ARTEN = Object.keys(FOLGE_LABEL) as FolgeArt[];

/** Größe einer Anlage (KB, mindestens 1). */
function kb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('de-DE')} KB`;
}

export interface TriagePersonen {
  optionen: readonly PersonOption[];
  berufstraeger: string | null;
  hauptbearbeitung: string | null;
}

type Link_ = (pfad: string) => string;

interface PanelBasis {
  mandantId: string;
  e: EreignisDetail;
  namen: TcmsNamen;
  /** Grund, warum im Panel nichts geändert werden kann, sonst null. */
  sperre: string | null;
}

function TriageKopf({ e, namen }: { e: EreignisDetail; namen: TcmsNamen }) {
  const t = typInfo(e.typ);
  return (
    <div className="card-header items-start">
      <div className="min-w-0">
        <h3 id="tcms-triage" className="flex items-center gap-2 text-sm font-semibold text-primary">
          <span className={`kpi-chip ${tonChip(t.ton)}`}>
            <KatalogIcon name={t.icon} />
          </span>
          {typKurz(e.typ)} · Triage
        </h3>
        <p className="text-xs text-muted mt-1">
          Vorgang <span className="font-mono">{e.nummer}</span> · Eingang{' '}
          {isoDatumText(e.gemeldetAm)}
          {e.gemeldetVon ? ` · gemeldet von ${namen.name(e.gemeldetVon)}` : ''}
        </p>
      </div>
      <span className={`${badgeKlasse(EREIGNIS_STATUS_BADGE[e.status])} shrink-0`}>
        {EREIGNIS_STATUS_LABEL[e.status]}
      </span>
    </div>
  );
}

function AnlagenBlock({ e, basis }: { e: EreignisDetail; basis: string }) {
  if (!e.anlagen.length) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold text-secondary mb-1">Anlagen</h4>
      <ul className="space-y-1">
        {e.anlagen.map((a) => (
          <li key={a.sha256} className="flex flex-wrap items-center gap-2 text-sm">
            <FileText className="h-4 w-4 text-muted" aria-hidden="true" />
            <a
              href={`/api${basis}/ereignisse/anlage?e=${encodeURIComponent(e.id)}&h=${a.sha256}`}
              className="text-primary hover:underline break-all"
            >
              {tcmsTextBereinigen(a.dateiname, 'DATEINAME', 255) || 'Datei'}
              <span className="sr-only"> herunterladen</span>
            </a>
            <span className="badge-gray gap-1" title="SHA-256 laut Tax-CMS">
              <Lock className="h-3 w-3" aria-hidden="true" />
              <HashKurz wert={a.sha256} />
            </span>
            <span className="text-xs text-muted">{kb(a.groesse)}</span>
          </li>
        ))}
      </ul>
      <p className="hint">
        Abruf aus der Dokumentenablage von TaxTronik; ausgeliefert wird nur der Inhalt mit dem im
        Tax-CMS gespeicherten SHA-256.
      </p>
    </div>
  );
}

/** Betroffene Risiken und Kontrollen laut Katalog und Folgen (Daten aus dem Kontext). */
function BetroffenBlock({ e, ctx, link }: { e: EreignisDetail; ctx: KontextAntwort; link: Link_ }) {
  const kat = ereignistyp(e.typ);
  const ziele = [
    ...new Set(
      [...(kat?.folgen ?? []).map((f) => f.ziel), ...e.folgen.map((f) => f.ziel)].filter(
        (z): z is string => !!z,
      ),
    ),
  ];
  const risikoZiele = ziele.filter((z) => z.startsWith('EC-')).sort();
  const kontrollZiele = ziele.filter((z) => z.startsWith('K-EC-')).sort();
  if (!risikoZiele.length && !kontrollZiele.length) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold text-secondary mb-1">Betroffen laut Katalog</h4>
      {risikoZiele.length ? (
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <span className="text-xs text-muted">Risiken:</span>
          {risikoZiele.map((code) => {
            const r = ctx.risiken.find((x) => x.code === code);
            return (
              <span key={code} className="inline-flex items-center gap-1">
                <Link
                  href={link(`/risiken?risiko=${encodeURIComponent(code)}`)}
                  className="badge-gray font-mono hover:underline"
                  title={r?.titel ?? 'im Inventar nicht aktiv'}
                >
                  {code}
                </Link>
                {r ? (
                  <KlasseBadge klasse={r.netto} title="Nettoklasse" />
                ) : (
                  <span className="text-xs text-muted">nicht aktiv</span>
                )}
                {r?.neuBewerten ? <span className="badge-yellow">neu bewerten</span> : null}
              </span>
            );
          })}
        </div>
      ) : null}
      {kontrollZiele.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Kontrollen:</span>
          {kontrollZiele.map((code) => {
            const k = ctx.kontrollen.find((x) => x.code === code);
            return k ? (
              <span key={code} className="inline-flex items-center gap-1">
                <Link
                  href={link(`/kontrollen?kontrolle=${encodeURIComponent(k.id)}`)}
                  className="badge-gray font-mono hover:underline"
                  title={k.titel}
                >
                  {code}
                </Link>
                <GtBadge gt={k.gt} />
              </span>
            ) : (
              <span key={code} className="inline-flex items-center gap-1">
                <span className="badge-gray font-mono">{code}</span>
                <span className="text-xs text-muted">nicht aktiv</span>
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Hinweis zu einem Vorschlag, dessen Ziel im Programm nicht aktiv ist (Anzeige). */
function hinweisFuer(ctx: KontextAntwort, art: FolgeArt, ziel: string | null): string | null {
  if (!ziel) return null;
  if (art === 'RISIKO_NEU_BEWERTEN' && !ctx.risiken.some((r) => r.code === ziel)) {
    return 'Risiko ist im Inventar nicht aktiv – verwerfen oder zuerst aufnehmen.';
  }
  if (art === 'KONTROLLE_AUSSERPLANMAESSIG' && !ctx.kontrollen.some((k) => k.code === ziel)) {
    return 'Kontrolle ist im Programm nicht aktiv.';
  }
  return null;
}

function VorschlaegeBlock({
  mandantId,
  e,
  sperre,
  ctx,
  personen,
  standardFrist,
}: PanelBasis & { ctx: KontextAntwort; personen: TriagePersonen; standardFrist: string }) {
  const vorschlaege = e.folgen.filter((f) => f.status === 'VORGESCHLAGEN');
  if (!vorschlaege.length) return null;
  const kat = ereignistyp(e.typ);
  return (
    <div>
      <h4 className="text-xs font-semibold text-secondary mb-1">Vorgeschlagene Folgen</h4>
      <TcmsFormular
        aktion={folgenAnlegenAction.bind(null, mandantId, e.id)}
        absenden="Ausgewählte Folgen anlegen"
        gesperrt={sperre}
        titel="Folgen nicht angelegt."
      >
        <ul>
          {vorschlaege.map((f) => {
            const hinweis = hinweisFuer(ctx, f.art, f.ziel);
            return (
              <VorschlagZeile
                key={f.id}
                f={f}
                personen={personen.optionen}
                standardZustaendig={
                  f.art === 'HINWEIS' ? personen.berufstraeger : personen.hauptbearbeitung
                }
                standardFrist={standardFrist}
                heute={ctx.heute}
                vorbelegt={f.art !== 'FESTSTELLUNG_ANLEGEN' && !hinweis}
                hinweis={hinweis}
                ereignisTitel={e.titel}
                gesperrt={sperre}
                verwerfen={folgeVerwerfenAction.bind(null, mandantId, e.id, f.id)}
              />
            );
          })}
        </ul>
        <p className="alert-info-sm flex items-start gap-2">
          <Info className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            Systemvorschlag aus Ereignistyp {kat ? kat.code : 'Sonstiges'} und Katalogregeln. Keine
            automatische Bewertung – die Entscheidung liegt bei der Kanzlei.
          </span>
        </p>
      </TcmsFormular>
    </div>
  );
}

function WeitereFolgeDialog({ mandantId, e, sperre }: PanelBasis) {
  return (
    <TcmsFormDialog
      aktion={folgeHinzufuegenAction.bind(null, mandantId, e.id)}
      ausloeser={
        <>
          <Plus className="h-4 w-4" aria-hidden="true" /> Weitere Folge
        </>
      }
      titel="Weitere Folge vorschlagen"
      hinweis="Eigene Triage-Entscheidung, z. B. Profil- oder Länderprüfung als Aufgabe."
      bestaetigen="Vorschlagen"
      gesperrt={sperre}
      erfolg="Folge vorgeschlagen – jetzt auswählen und anlegen."
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="sm:col-span-2">
          <label htmlFor="wf-art" className="label-sm">
            Art
          </label>
          <select id="wf-art" name="art" className="input" defaultValue="HINWEIS">
            {FOLGE_ARTEN.map((art) => (
              <option key={art} value={art}>
                {FOLGE_LABEL[art]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="wf-ziel" className="label-sm">
            Risiko-/Kontrollcode
          </label>
          <input
            id="wf-ziel"
            name="ziel"
            className="input font-mono"
            placeholder="EC-UST-02"
            maxLength={20}
          />
        </div>
      </div>
      <div>
        <label htmlFor="wf-text" className="label-sm">
          Beschreibung
        </label>
        <input
          id="wf-text"
          name="text"
          className="input"
          required
          minLength={5}
          maxLength={300}
          placeholder="z. B. Länder-Monitor um CZ ergänzen"
        />
      </div>
    </TcmsFormDialog>
  );
}

/**
 * Offener Antrag auf Verwerfen. Vier-Augen (Anzeige): Wer beantragt hat, sieht
 * nur „Antrag zurückziehen“; alle anderen „bestätigen“ oder „ablehnen“.
 */
function VerwerfenAntragBlock({
  mandantId,
  e,
  namen,
  sperre,
  eigeneId,
}: PanelBasis & { eigeneId: string }) {
  const antrag = e.verwerfenAntrag;
  if (!antrag) return null;
  const eigenerAntrag = antrag.vonId?.toLowerCase() === eigeneId.toLowerCase();
  return (
    <div className="alert-warning text-sm space-y-2" role="status">
      <p>
        <strong>Verwerfen beantragt</strong> von {namen.name(antrag.vonId)} ·{' '}
        {isoZeitText(antrag.am)}
      </p>
      <p className="text-xs whitespace-pre-wrap">{antrag.begruendung}</p>
      <div className="flex flex-wrap items-start gap-2">
        {eigenerAntrag ? (
          <>
            <p className="text-xs w-full">
              Die Bestätigung muss durch eine zweite Person erfolgen.
            </p>
            <TcmsAktionsKnopf
              aktion={ereignisVerwerfenAblehnenAction.bind(null, mandantId, e.id)}
              className="btn-secondary text-xs py-1"
              gesperrt={sperre}
            >
              Antrag zurückziehen
            </TcmsAktionsKnopf>
          </>
        ) : (
          <>
            <TcmsAktionsKnopf
              aktion={ereignisVerwerfenBestaetigenAction.bind(null, mandantId, e.id)}
              className="btn-danger-outline text-xs py-1"
              gesperrt={
                sperre ??
                ereignisSperre(
                  e.rechte.verwerfen.bestaetigen,
                  'VIER_AUGEN',
                  'Der Antrag kann auf dem aktuellen Stand nicht bestätigt werden. Bitte laden Sie die Seite neu.',
                )
              }
              bestaetigung={{
                titel: `Ereignis ${e.nummer} verwerfen`,
                text: 'Das Ereignis wird verworfen; offene Vorschläge werden mit verworfen. Der Schritt wird mit Ihrem Namen protokolliert.',
                bestaetigen: 'Verwerfen bestätigen',
                gefahr: true,
              }}
            >
              Verwerfen bestätigen
            </TcmsAktionsKnopf>
            <TcmsAktionsKnopf
              aktion={ereignisVerwerfenAblehnenAction.bind(null, mandantId, e.id)}
              className="btn-secondary text-xs py-1"
              gesperrt={sperre}
            >
              Ablehnen
            </TcmsAktionsKnopf>
          </>
        )}
      </div>
    </div>
  );
}

type EreignisRecht = EreignisDetail['rechte']['abschliessen'];

/**
 * Sperrgrund eines Schritts am Ereignis aus dem Recht des Dienstes (TCMS s7):
 * frei, fester Text zum Verweigerungsgrund oder – wenn nur der Zustand
 * entgegensteht – der Zustandshinweis der Seite.
 */
export function ereignisSperre(
  recht: EreignisRecht,
  rueckfall: TcmsKeinRechtGrund,
  zustand: string,
): string | null {
  if (recht.erlaubt) return null;
  return recht.verweigerung !== null ? keinRechtText(recht.verweigerung, rueckfall) : zustand;
}

/** Zustandshinweis zum Abschließen (Anzeige-Vorschau der Domain; ob es geht, sagt das Recht). */
function abschliessenZustand(e: EreignisDetail): string {
  if (!ereignisErledigt(e.folgen)) {
    return 'Erst wenn jede Folge erledigt oder begründet verworfen ist.';
  }
  return e.folgen.some((f) => f.status === 'ERLEDIGT')
    ? 'Der Abschluss ist auf dem aktuellen Stand nicht möglich. Bitte laden Sie die Seite neu.'
    : 'Keine Folge erledigt – bitte „Verwerfen …“ (Bestätigung durch eine zweite Person).';
}

function abschliessenGesperrt(e: EreignisDetail, sperre: string | null): string | null {
  return sperre ?? ereignisSperre(e.rechte.abschliessen, 'BEARBEITEN', abschliessenZustand(e));
}

function FussAktionen({ mandantId, e, sperre }: PanelBasis) {
  const folgenAngelegt = e.folgen.some((f) => f.status === 'ANGELEGT' || f.status === 'ERLEDIGT');
  return (
    <div className="flex flex-wrap items-start justify-end gap-3 border-t border-default pt-4">
      {!e.verwerfenAntrag ? (
        <TcmsFormDialog
          aktion={ereignisVerwerfenBeantragenAction.bind(null, mandantId, e.id)}
          ausloeser="Verwerfen …"
          ausloeserKlasse="btn-danger-outline"
          titel={`Ereignis ${e.nummer} verwerfen`}
          hinweis="Nur ohne angelegte Folgen. Eine zweite Person bestätigt; offene Vorschläge werden dann mit verworfen."
          bestaetigen="Verwerfen beantragen"
          gefahr
          begruendung={{
            min: MIN_BEGRUENDUNG,
            max: 2000,
            hinweis: 'Wird von einer zweiten Person bestätigt.',
          }}
          gesperrt={
            sperre ??
            ereignisSperre(
              e.rechte.verwerfen.beantragen,
              'BEARBEITEN',
              folgenAngelegt
                ? 'Folgen sind bereits angelegt – einzeln erledigen oder verwerfen.'
                : 'Verwerfen ist auf dem aktuellen Stand nicht möglich. Bitte laden Sie die Seite neu.',
            )
          }
          erfolg="Verwerfen beantragt. Eine zweite Person muss bestätigen."
        />
      ) : null}
      {e.status === 'NEU' ? (
        <TcmsAktionsKnopf
          aktion={ereignisInPruefungNehmenAction.bind(null, mandantId, e.id)}
          gesperrt={sperre}
        >
          In Prüfung nehmen
        </TcmsAktionsKnopf>
      ) : null}
      <TcmsAktionsKnopf
        aktion={ereignisAbschliessenAction.bind(null, mandantId, e.id)}
        className="btn-primary"
        gesperrt={abschliessenGesperrt(e, sperre)}
      >
        Ereignis abschließen
      </TcmsAktionsKnopf>
    </div>
  );
}

function AbschlussInfo({ e, namen }: { e: EreignisDetail; namen: TcmsNamen }) {
  const triage = e.triagiertVon
    ? ` Triage: ${namen.name(e.triagiertVon)}${e.triagiertAm ? `, ${isoZeitText(e.triagiertAm)}` : ''}.`
    : '';
  return (
    <p className="text-xs text-muted">
      {e.status === 'ERLEDIGT'
        ? 'Erledigt – alle Folgen erledigt oder begründet verworfen.'
        : 'Verworfen.'}
      {triage}
    </p>
  );
}

function VerlaufBlock({ e, namen }: { e: EreignisDetail; namen: TcmsNamen }) {
  if (!e.verlauf.length) return null;
  return (
    <details className="details-box">
      <summary>
        <History className="h-4 w-4" aria-hidden="true" /> Verlauf ({e.verlauf.length})
      </summary>
      <ul className="details-body space-y-1">
        {e.verlauf.map((v) => (
          <li key={`${v.pos}-${v.at}`} className="text-xs">
            <span className="font-mono text-muted">{isoZeitText(v.at)}</span> ·{' '}
            <span className="font-medium">{namen.name(v.actorId)}</span> · {v.text}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function TriagePanel({
  mandantId,
  basis,
  link,
  e,
  ctx,
  namen,
  personen,
  sperre,
  eigeneId,
  standardFrist,
}: {
  mandantId: string;
  basis: string;
  link: Link_;
  e: EreignisDetail;
  ctx: KontextAntwort;
  namen: TcmsNamen;
  personen: TriagePersonen;
  /** Grund, warum nichts geändert werden kann (Stichtag, Rechte), sonst null. */
  sperre: string | null;
  /** Mitarbeiter-ID der Sitzung (nur Anzeige: Vier-Augen beim Verwerfen). */
  eigeneId: string;
  standardFrist: string;
}) {
  const t = typInfo(e.typ);
  const abgeschlossen = e.status === 'ERLEDIGT' || e.status === 'VERWORFEN';
  const panelSperre = sperre ?? (abgeschlossen ? 'Das Ereignis ist abgeschlossen.' : null);
  const basisProps: PanelBasis = { mandantId, e, namen, sperre: panelSperre };
  const weitere = e.folgen.filter((f) => f.status !== 'VORGESCHLAGEN');
  return (
    <section className="card self-start" aria-labelledby="tcms-triage">
      <TriageKopf e={e} namen={namen} />
      <div className="p-6 space-y-5">
        <div>
          <p className="text-sm font-medium text-primary">{e.titel}</p>
          <p className="text-xs text-muted mt-1">
            {t.titel} · Ereignisdatum {isoDatumText(e.ereignisDatum)} · Quelle{' '}
            {quelleText(e.quelle)}
          </p>
          <h4 className="text-xs font-semibold text-secondary mt-3 mb-1">Beschreibung</h4>
          <p className="text-sm text-secondary whitespace-pre-wrap">{e.beschreibung}</p>
        </div>
        <AnlagenBlock e={e} basis={basis} />
        <BetroffenBlock e={e} ctx={ctx} link={link} />
        <VorschlaegeBlock
          {...basisProps}
          ctx={ctx}
          personen={personen}
          standardFrist={standardFrist}
        />
        {weitere.length ? (
          <div>
            <h4 className="text-xs font-semibold text-secondary mb-1">Folgen</h4>
            <ul>
              {weitere.map((f) => (
                <FolgeZeile
                  key={f.id}
                  f={f}
                  link={link}
                  namen={namen}
                  gesperrt={panelSperre}
                  erledigen={folgeErledigenAction.bind(null, mandantId, e.id, f.id)}
                  verwerfen={folgeVerwerfenAction.bind(null, mandantId, e.id, f.id)}
                />
              ))}
            </ul>
          </div>
        ) : null}
        {!abgeschlossen ? <WeitereFolgeDialog {...basisProps} /> : null}
        <VerwerfenAntragBlock {...basisProps} eigeneId={eigeneId} />
        {e.verwerfen ? (
          <div className="alert-warning text-sm">
            <p>
              <strong>Verworfen</strong> · bestätigt von {namen.name(e.verwerfen.vonId)} ·{' '}
              {isoZeitText(e.verwerfen.am)}
            </p>
            <p className="text-xs mt-1 whitespace-pre-wrap">{e.verwerfen.begruendung}</p>
          </div>
        ) : null}
        {abgeschlossen ? <AbschlussInfo e={e} namen={namen} /> : <FussAktionen {...basisProps} />}
        <VerlaufBlock e={e} namen={namen} />
      </div>
      <p className="card-footer">
        {e.meldung ? (
          <span className="text-xs font-mono text-muted">
            Ereignis im Audit: {e.meldung.aktion} · {isoZeitText(e.meldung.at)} · Hash{' '}
            <HashKurz wert={e.meldung.hash} />
          </span>
        ) : (
          <span className="text-xs text-muted">Kein Meldungseintrag im Audit.</span>
        )}
      </p>
    </section>
  );
}
