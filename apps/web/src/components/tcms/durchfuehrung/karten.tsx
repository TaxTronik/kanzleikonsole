// =============================================================================
// Karten der Kontrolldurchführung (TCMS Stufe 3, Bereich C; portiert aus der
// Demo components/durchfuehrung/karten.tsx). Reine Anzeige der Antwort von
// `durchfuehrungLesen`; Namen kommen aufgelöst aus der kanzleikonsole.
//
// Nachweise: Der Verweis des Tax-CMS (Dokument-ID, SHA-256) wird vor der
// Anzeige mit der Ablage abgeglichen (server/tcms/durchfuehrung/verweis.ts).
// Abrufbar ist nur ein Nachweis, dessen Dokument dieses Mandanten mit gleichem
// SHA-256 vorliegt; die Route prüft beim Abruf erneut.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  Download,
  FileSpreadsheet,
  FileText,
  Hash,
  Lock,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import type { DurchfuehrungDetail } from '@taxtronik/tcms-contract';
import {
  AUSFUEHRUNG_LABEL,
  DESIGN_LABEL,
  fmtEur,
  frequenzLabel,
  KONTROLLART_LABEL,
  type Turnus,
} from '@taxtronik/tcms-domain';
import { AnzeigeBadge, HashKurz } from '@/components/tcms/badges';
import { isoDatumText, isoZeitText } from '@/components/tcms/format';
import type { TcmsNamen } from '@/server/tcms/namen';
import {
  NachweisAuswahl,
  NachweisEntfernenKnopf,
  NachweisHochladen,
  type DokumentWahl,
  type TcmsFormAktion,
} from './formulare';
import { fmtGroesse } from './werte';

type Nachweis = DurchfuehrungDetail['nachweise'][number];

/** Abgleich eines Nachweises mit der Ablage (aus verweis.ts, hier als Anzeige). */
export type NachweisZustand = 'OK' | 'ABWEICHUNG' | 'FEHLT';

function dateiIcon(n: Nachweis) {
  const x = n.dateiname.toLowerCase();
  return /\.(xlsx?|csv|ods)$/.test(x) || n.mime.includes('spreadsheet') || n.mime === 'text/csv'
    ? FileSpreadsheet
    : FileText;
}

function KartenKopf({ id, titel, children }: { id: string; titel: string; children?: ReactNode }) {
  return (
    <div className="card-header">
      <h3 id={id} className="text-sm font-semibold text-primary">
        {titel}
      </h3>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nachweise
// ---------------------------------------------------------------------------

export interface NachweisBedienung {
  /** Hochladen/Auswählen/Entfernen anbieten (aktueller Stand und `rechte.bearbeiten`). */
  erlaubt: boolean;
  hochladen: TcmsFormAktion;
  auswaehlen: TcmsFormAktion;
  entfernen: TcmsFormAktion;
  dokumente: readonly DokumentWahl[];
  maxBytes: number;
  maxText: string;
}

export function NachweiseKarte({
  d,
  namen,
  abgleich,
  downloadHref,
  bedienung,
  gesperrtText,
}: {
  d: DurchfuehrungDetail;
  namen: TcmsNamen;
  abgleich: ReadonlyMap<string, NachweisZustand>;
  downloadHref: (nachweisId: string) => string;
  bedienung: NachweisBedienung;
  gesperrtText: string;
}) {
  const mind = d.kontrolle.mindestNachweise;
  return (
    <section className="card" aria-labelledby="df-nachweise">
      <KartenKopf id="df-nachweise" titel="Nachweise">
        <span className="flex items-center gap-2">
          {mind > 0 ? (
            <span
              className={d.nachweise.length >= mind ? 'badge-green' : 'badge-yellow'}
              title={`Nachweisanforderung: ${d.kontrolle.nachweis}`}
            >
              {d.nachweise.length} von mind. {mind}
            </span>
          ) : null}
          <span className="badge-gray">
            {d.nachweise.length === 1 ? '1 Datei' : `${d.nachweise.length} Dateien`}
          </span>
        </span>
      </KartenKopf>
      {d.nachweise.length === 0 ? (
        <p className="px-6 py-4 text-sm text-muted">
          Noch keine Nachweise hochgeladen. Erwartet: {d.kontrolle.nachweis}.
        </p>
      ) : (
        <ul>
          {d.nachweise.map((n) => {
            const Icon = dateiIcon(n);
            const zustand = abgleich.get(n.id) ?? 'FEHLT';
            return (
              <li
                key={n.id}
                className="flex items-start gap-3 px-6 py-3 border-b border-default last:border-b-0"
              >
                <Icon className="h-5 w-5 mt-0.5 shrink-0 text-muted" aria-hidden="true" />
                <div className="grow min-w-0">
                  {zustand === 'OK' ? (
                    <a
                      href={downloadHref(n.id)}
                      className="text-sm font-medium text-primary underline-offset-2 hover:underline break-all"
                    >
                      {n.dateiname}
                    </a>
                  ) : (
                    <span className="text-sm font-medium text-primary break-all">
                      {n.dateiname}
                    </span>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="badge-gray gap-1">
                      {n.gesperrt ? (
                        <Lock className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <Hash className="h-3 w-3" aria-hidden="true" />
                      )}
                      {n.gesperrt ? 'gesperrt · Hash' : 'Hash'} <HashKurz wert={n.sha256} />
                    </span>
                    {!n.gesperrt ? (
                      <span className="badge-yellow">bis zum Einreichen änderbar</span>
                    ) : null}
                    {zustand === 'ABWEICHUNG' ? (
                      <span className="badge-red gap-1">
                        <TriangleAlert className="h-3 w-3" aria-hidden="true" />
                        Abweichung zur Ablage – nicht abrufbar
                      </span>
                    ) : zustand === 'FEHLT' ? (
                      <span className="badge-gray">Dokument in der Ablage nicht verfügbar</span>
                    ) : null}
                    <span className="text-[11px] text-muted">
                      {fmtGroesse(n.groesse)} · {namen.name(n.hochgeladenVon)} ·{' '}
                      {isoZeitText(n.hochgeladenAm)}
                    </span>
                  </div>
                  {zustand === 'ABWEICHUNG' ? (
                    <p className="hint">
                      Die gespeicherte Datei stimmt nicht mit dem Verweis im Tax-CMS überein
                      (SHA-256 oder Größe). Sie wird nicht ausgeliefert; bitte die Kanzleiverwaltung
                      informieren.
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-start gap-2">
                  {zustand === 'OK' ? (
                    <a
                      className="btn-secondary text-xs py-1 inline-flex items-center gap-1"
                      href={downloadHref(n.id)}
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download
                      <span className="sr-only"> {n.dateiname}</span>
                    </a>
                  ) : null}
                  {!n.gesperrt && bedienung.erlaubt && d.status !== 'GEPLANT' ? (
                    <NachweisEntfernenKnopf
                      action={bedienung.entfernen}
                      nachweisId={n.id}
                      dateiname={n.dateiname}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {d.nachweiseAusgeblendet > 0 ? (
        <p className="px-6 py-3 text-xs text-muted border-t border-default">
          {d.nachweiseAusgeblendet} später hochgeladene Datei(en) zum Stichtag ausgeblendet.
        </p>
      ) : null}
      <div className="px-6 py-4 border-t border-default">
        {bedienung.erlaubt ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <NachweisHochladen
              action={bedienung.hochladen}
              maxBytes={bedienung.maxBytes}
              maxText={bedienung.maxText}
            />
            <NachweisAuswahl action={bedienung.auswaehlen} dokumente={bedienung.dokumente} />
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted">
            {d.nachweise.some((n) => n.gesperrt) ? (
              <Lock className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Upload className="h-4 w-4" aria-hidden="true" />
            )}
            {gesperrtText}
          </p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Seitenspalte
// ---------------------------------------------------------------------------

export function KontrollbeschreibungKarte({
  d,
  namen,
  frequenz,
}: {
  d: DurchfuehrungDetail;
  namen: TcmsNamen;
  frequenz: { turnus: Turnus; anlass: boolean } | null;
}) {
  const k = d.kontrolle;
  return (
    <details className="details-box" open>
      <summary>Kontrollbeschreibung</summary>
      <div className="details-body flex flex-col gap-1.5 text-sm text-secondary">
        <span>Ziel: {k.ziel}</span>
        <span>
          Nachweis: {k.nachweis}
          {k.mindestNachweise > 0
            ? ` (mindestens ${k.mindestNachweise} ${k.mindestNachweise === 1 ? 'Datei' : 'Dateien'})`
            : ''}
          .
        </span>
        {k.toleranzEur != null ? <span>Toleranz: {fmtEur(k.toleranzEur)} je Periode.</span> : null}
        <span className="text-xs text-muted">
          {KONTROLLART_LABEL[k.art]} · {AUSFUEHRUNG_LABEL[k.ausfuehrung]}
          {frequenz ? ` · ${frequenzLabel(frequenz)}` : ''} · fällig {k.faelligNachTagen} Tage nach
          Periodenende
        </span>
        <span className="text-xs text-muted">
          Version v{k.version} · gültig ab {isoDatumText(k.gueltigAb)} ·{' '}
          {k.design === 'ANGEMESSEN'
            ? `Designbeurteilung: angemessen · ${namen.name(k.designVon)} · ${isoDatumText(k.designAm)}`
            : k.design === 'MANGEL'
              ? `Designbeurteilung: Mangel · ${namen.name(k.designVon)}`
              : `Designbeurteilung: ${DESIGN_LABEL[k.design]}`}
        </span>
      </div>
    </details>
  );
}

export function RisikenKarte({
  d,
  href,
}: {
  d: DurchfuehrungDetail;
  href: (risikoId: string) => string;
}) {
  return (
    <section className="card" aria-labelledby="df-risiken">
      <KartenKopf id="df-risiken" titel="Verknüpfte Risiken" />
      <div className="flex flex-wrap gap-2 px-6 py-3">
        {d.risiken.length === 0 ? (
          <span className="text-sm text-muted">keine aktiven Risiken verknüpft</span>
        ) : (
          d.risiken.map((r) => (
            <Link key={r.id} href={href(r.id)} className="badge-gray font-mono" title={r.titel}>
              {r.code}
              <span className="sr-only"> {r.titel}</span>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}

export function LetzteKarte({ d, href }: { d: DurchfuehrungDetail; href: (id: string) => string }) {
  return (
    <section className="card" aria-labelledby="df-letzte">
      <KartenKopf id="df-letzte" titel="Letzte Durchführungen" />
      {d.letzte.length === 0 ? (
        <p className="px-6 py-3 text-sm text-muted">keine früheren Perioden</p>
      ) : (
        <ul>
          {d.letzte.map((x) => (
            <li key={x.id} className="border-b border-default last:border-b-0">
              <Link
                href={href(x.id)}
                className="flex items-center justify-between gap-2 px-6 py-2.5 hover:bg-surface-raised"
              >
                <span className="text-sm text-primary">{x.periodeLabel}</span>
                <AnzeigeBadge status={x.anzeige} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function VerlaufKarte({ d, namen }: { d: DurchfuehrungDetail; namen: TcmsNamen }) {
  return (
    <section className="card" aria-labelledby="df-verlauf">
      <KartenKopf id="df-verlauf" titel="Verlauf">
        <span
          className="text-[11px] text-muted"
          title="Einträge aus der Audit-Hashkette; „System“ = aus Datum abgeleitet"
        >
          Audit-Protokoll
        </span>
      </KartenKopf>
      {d.verlauf.length === 0 ? (
        <p className="px-6 py-3 text-sm text-muted">Noch keine Einträge.</p>
      ) : (
        <ol>
          {d.verlauf.map((e, i) => (
            <li
              key={`${e.pos}-${i}`}
              className="px-6 py-2.5 text-xs border-b border-default last:border-b-0"
            >
              <span className="font-mono text-muted">
                {e.system ? isoDatumText(e.at) : isoZeitText(e.at)}
              </span>{' '}
              · <span className="font-medium">{e.system ? 'System' : namen.name(e.actorId)}</span> ·{' '}
              {e.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Personenbelege: abgeschlossene Handlungen mit Name und Zeitpunkt. */
export function PersonenbelegeKarte({ d, namen }: { d: DurchfuehrungDetail; namen: TcmsNamen }) {
  const zeilen: { label: string; person: string; zeit: string | null }[] = [];
  if (d.begonnenAm)
    zeilen.push({ label: 'Begonnen', person: namen.name(d.durchgefuehrtVon), zeit: d.begonnenAm });
  if (d.eingereichtAm)
    zeilen.push({
      label: d.kontrolle.partei === 'MANDANT' ? 'Übermittelt' : 'Eingereicht',
      person: namen.name(d.durchgefuehrtVon),
      zeit: d.eingereichtAm,
    });
  if (d.mandantBestaetigtVon)
    zeilen.push({
      label: 'Bestätigt (Mandant)',
      person: namen.name(d.mandantBestaetigtVon),
      zeit: d.mandantBestaetigtAm,
    });
  if (d.zurueckgewiesenVon && d.zurueckgewiesenAm)
    zeilen.push({
      label: 'Zuletzt zurückgewiesen',
      person: namen.name(d.zurueckgewiesenVon),
      zeit: d.zurueckgewiesenAm,
    });
  if (d.abgeschlossenAm && d.gegengezeichnetVon)
    zeilen.push({
      label: 'Gegengezeichnet',
      person: namen.name(d.gegengezeichnetVon),
      zeit: d.abgeschlossenAm,
    });
  if (d.entfallenVon)
    zeilen.push({ label: 'Entfallen beantragt', person: namen.name(d.entfallenVon), zeit: null });
  if (d.entfallenAm)
    zeilen.push({
      label: 'Entfallen freigegeben',
      person: namen.name(d.entfallenFreigegebenVon),
      zeit: d.entfallenAm,
    });
  return (
    <section className="card" aria-labelledby="df-belege">
      <KartenKopf id="df-belege" titel="Personenbelege" />
      {zeilen.length === 0 ? (
        <p className="px-6 py-3 text-sm text-muted">Noch keine abgeschlossenen Handlungen.</p>
      ) : (
        <dl>
          {zeilen.map((z, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-2 px-6 py-2.5 border-b border-default"
            >
              <dt className="text-xs text-muted">{z.label}</dt>
              <dd className="text-xs font-medium text-right">
                {z.person}
                {z.zeit ? ` · ${isoZeitText(z.zeit)}` : ''}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="px-6 py-3 text-[11px] text-muted">
        Das Ergebnis ist die Angabe der durchführenden Person; die Gegenzeichnung belegt die
        Vier-Augen-Handlung, nicht die materielle Richtigkeit. Ein Hash bindet Inhalte, er
        authentifiziert keine Person.
      </p>
    </section>
  );
}
