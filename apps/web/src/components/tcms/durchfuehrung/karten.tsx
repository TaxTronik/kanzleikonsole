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
import { Lock, Upload } from 'lucide-react';
import type { DurchfuehrungDetail } from '@taxtronik/tcms-contract';
import {
  AUSFUEHRUNG_LABEL,
  DESIGN_LABEL,
  fmtEur,
  frequenzLabel,
  KONTROLLART_LABEL,
  type Turnus,
} from '@taxtronik/tcms-domain';
import { AnzeigeBadge } from '@/components/tcms/badges';
import { isoDatumText, isoZeitText } from '@/components/tcms/format';
import type { TcmsNamen } from '@/server/tcms/namen';
import {
  NachweisAuswahl,
  NachweisEntfernenKnopf,
  NachweisHochladen,
  type DokumentWahl,
  type TcmsFormAktion,
} from './formulare';
import { NachweisListe, nachweisAnzeigename, type NachweisZustand } from './nachweis-liste';
import { TcmsText } from '@/components/tcms/text';

/** Abgleich eines Nachweises mit der Ablage (aus verweis.ts, hier als Anzeige). */
export type { NachweisZustand } from './nachweis-liste';

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
  dateinamen,
  downloadHref,
  bedienung,
  gesperrtText,
}: {
  d: DurchfuehrungDetail;
  namen: TcmsNamen;
  abgleich: ReadonlyMap<string, NachweisZustand>;
  /** Dateinamen aus der eigenen Ablage (RT3B-K-04). */
  dateinamen?: ReadonlyMap<string, string>;
  downloadHref: (nachweisId: string) => string;
  bedienung: NachweisBedienung;
  gesperrtText: string;
}) {
  return (
    <NachweisListe
      id="df-nachweise"
      titel="Nachweise"
      ebene="h3"
      nachweise={d.nachweise}
      mindest={d.kontrolle.mindestNachweise}
      anforderung={d.kontrolle.nachweis}
      ausgeblendet={d.nachweiseAusgeblendet}
      namen={namen}
      abrufHref={downloadHref}
      abgleich={abgleich}
      dateinamen={dateinamen}
      aenderbarBis="Einreichen"
      entfernen={(n) =>
        !n.gesperrt && bedienung.erlaubt && d.status !== 'GEPLANT' ? (
          <NachweisEntfernenKnopf
            action={bedienung.entfernen}
            nachweisId={n.id}
            dateiname={nachweisAnzeigename(n, dateinamen)}
          />
        ) : null
      }
      fuss={
        bedienung.erlaubt ? (
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
        )
      }
    />
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
        <span>
          Ziel: <TcmsText>{k.ziel}</TcmsText>
        </span>
        <span>
          Nachweis: <TcmsText>{k.nachweis}</TcmsText>
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
              <span className="sr-only">
                {' '}
                <TcmsText>{r.titel}</TcmsText>
              </span>
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
                <span className="text-sm text-primary">
                  <TcmsText>{x.periodeLabel}</TcmsText>
                </span>
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
              <TcmsText>{e.text}</TcmsText>
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
              <dt className="text-xs text-muted">
                <TcmsText>{z.label}</TcmsText>
              </dt>
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
