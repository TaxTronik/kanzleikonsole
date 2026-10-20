// =============================================================================
// /portal/tcms — Tax-CMS im Mandantenportal (TCMS Stufe 3, portiert aus der
// Demo portal/tcms/page.tsx).
//
// Der Mandant kommt ausschließlich aus der Portal-Sitzung (tcmsPortalSeite);
// welche Aufgaben die Person sieht (gesetzliche Vertretung und
// Tax-Compliance-Beauftragte alle, Mitarbeitende nur eigene) und ob sie
// melden darf, entscheidet der Dienst (`rechte` in der Antwort). Namen kommen
// aus der kanzleikonsole (Kontakte nur dieses Mandanten).
// =============================================================================

import Link from 'next/link';
import { CheckCheck, FileCheck, Inbox, Plus, ShieldCheck } from 'lucide-react';
import { ENDPUNKTE, type PortalUebersichtAntwort } from '@taxtronik/tcms-contract';
import { EREIGNIS_STATUS_LABEL, PHASEN, ereignistyp } from '@taxtronik/tcms-domain';
import { AnzeigeBadge } from '@/components/tcms/badges';
import { isoDatumText } from '@/components/tcms/format';
import { KatalogIcon } from '@/components/tcms/icon';
import { TcmsLeer } from '@/components/tcms/leer';
import { tonChip } from '@/components/tcms/ton';
import { MiniSteps, ZeitraumLeiste } from '@/components/tcms/visual';
import { TcmsZustand } from '@/components/tcms/zustand';
import type { TcmsNamen } from '@/server/tcms/namen';
import { personIdsAus } from '@/server/tcms/namen';
import { tcmsLesen, tcmsNamenLesen, tcmsPortalSeite } from '@/server/tcms/seite';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import { TcmsText } from '@/components/tcms/text';

export const metadata = { title: 'Tax-CMS' };

type Aufgabe = PortalUebersichtAntwort['aufgaben'][number];

export default async function PortalTcmsPage() {
  const seite = await tcmsPortalSeite();
  if (!seite.ok) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold text-primary mb-4">Tax-CMS</h1>
        <TcmsZustand zustand={seite.zustand} />
      </div>
    );
  }
  const uebersicht = await tcmsLesen(seite, ENDPUNKTE.portalUebersichtLesen);
  if (!uebersicht.ok) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold text-primary mb-4">Tax-CMS</h1>
        <TcmsZustand zustand={uebersicht.zustand} />
      </div>
    );
  }
  const u = uebersicht.daten;
  const namen = await tcmsNamenLesen(
    seite,
    personIdsAus(
      u.aufgaben.map((a) => a.zustaendigId),
      u.meldungen.map((m) => m.gemeldetVon),
    ),
  );
  const eigene = u.aufgaben.filter((a) => a.eigene);
  const weitere = u.rechte.portalLesen ? u.aufgaben.filter((a) => !a.eigene) : [];
  const ueberfaellig = u.aufgaben.filter((a) => a.anzeige === 'UEBERFAELLIG').length;

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-primary">Tax-CMS</h1>
      <p className="text-sm text-muted mb-6 max-w-3xl">
        Ihre Kanzlei dokumentiert das Tax-Compliance-Programm Ihres Unternehmens. Hier sehen Sie den
        Stand und wo Ihre Mitarbeit gebraucht wird.
      </p>

      {!u.programm ? (
        <div className="card">
          <TcmsLeer
            icon={ShieldCheck}
            text="Für Ihr Unternehmen ist noch kein Tax-Compliance-Programm eingerichtet. Ihre Kanzlei meldet sich, sobald es losgeht."
          />
        </div>
      ) : (
        <>
          <section className="card p-6 mb-4" aria-labelledby="tcms-stand">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <h2 id="tcms-stand" className="text-lg font-semibold text-primary">
                {u.programm.zeitraum && u.programm.aktivePhase === 6
                  ? `Zeitraum ${isoDatumText(u.programm.wirksamAb)} – ${isoDatumText(u.programm.wirksamBis)}`
                  : `Stand: ${PHASEN[u.programm.aktivePhase - 1] ?? ''}`}
              </h2>
              <span className="inline-flex items-center gap-2">
                {u.programm.zeitraum ? (
                  <span className="badge-brand">
                    Monat {u.programm.zeitraum.monat} von {u.programm.zeitraum.monate}
                  </span>
                ) : (
                  <span className="badge-brand">
                    Schritt {u.programm.aktivePhase} von {PHASEN.length}
                  </span>
                )}
                {ueberfaellig > 0 ? (
                  <span className="badge-red">
                    {ueberfaellig} Aufgabe{ueberfaellig === 1 ? '' : 'n'} überfällig
                  </span>
                ) : (
                  <span className="badge-green">keine Aufgabe überfällig</span>
                )}
              </span>
            </div>
            {u.programm.monate.length > 0 ? (
              <ZeitraumLeiste monate={u.programm.monate} />
            ) : (
              <MiniSteps aktiv={u.programm.aktivePhase} />
            )}
          </section>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-4">
            <section className="card xl:col-span-2" aria-labelledby="tcms-aufgaben">
              <div className="card-header">
                <h2 id="tcms-aufgaben" className="text-sm font-semibold text-primary">
                  Ihre Aufgaben
                </h2>
                <span className="badge-gray">{eigene.length} offen</span>
              </div>
              {eigene.length ? (
                <ul>
                  {eigene.map((a) => (
                    <AufgabeZeile key={`${a.art}-${a.durchfuehrungId}`} a={a} namen={namen} />
                  ))}
                </ul>
              ) : (
                <TcmsLeer icon={CheckCheck} text="Für Sie liegt gerade keine Aufgabe an." />
              )}
              {weitere.length ? (
                <details className="details-box m-4">
                  <summary>Weitere Aufgaben in Ihrem Unternehmen ({weitere.length})</summary>
                  <ul className="details-body">
                    {weitere.map((a) => (
                      <AufgabeZeile key={`${a.art}-${a.durchfuehrungId}`} a={a} namen={namen} />
                    ))}
                  </ul>
                </details>
              ) : null}
            </section>

            <section
              className="card p-6 flex flex-col justify-between gap-4"
              aria-labelledby="tcms-melden"
            >
              <div>
                <h2 id="tcms-melden" className="text-lg font-semibold text-primary">
                  Neues melden
                </h2>
                <p className="text-sm text-secondary mt-2">
                  Neuer Marktplatz, neues Lager, neues Zielland oder neuer Zahlungsdienst? Bitte
                  melden Sie Veränderungen – die Kanzlei kümmert sich um die Prüfung.
                </p>
              </div>
              {u.rechte.melden ? (
                <Link href="/portal/tcms/ereignis" className="btn-primary justify-center">
                  <Plus className="h-4 w-4" aria-hidden="true" /> Ereignis melden
                </Link>
              ) : (
                <p className="text-sm text-muted">{TCMS_KEIN_RECHT.PORTAL_ROLLE}</p>
              )}
              <Link href="/portal/tcms/freigaben" className="btn-secondary justify-center">
                <FileCheck className="h-4 w-4" aria-hidden="true" /> Freigaben &amp; Kenntnisnahmen
              </Link>
            </section>
          </div>
        </>
      )}

      <section className="card" aria-labelledby="tcms-meldungen">
        <div className="card-header">
          <h2 id="tcms-meldungen" className="text-sm font-semibold text-primary">
            {u.rechte.portalLesen ? 'Letzte Meldungen' : 'Ihre Meldungen'}
          </h2>
          <span className="text-xs text-muted">werden von der Kanzlei geprüft</span>
        </div>
        {u.meldungen.length ? (
          <ul>
            {u.meldungen.slice(0, 6).map((m) => {
              const typ = ereignistyp(m.typ);
              return (
                <li
                  key={m.id}
                  className="flex items-start gap-3 px-6 py-3 border-b border-default last:border-b-0"
                >
                  <span className={`kpi-chip ${tonChip(typ?.ton)}`}>
                    <KatalogIcon name={typ?.icon ?? 'Bell'} />
                  </span>
                  <span className="grow">
                    <span className="block text-sm font-medium text-primary">
                      <TcmsText>{m.titel}</TcmsText>
                    </span>
                    <span className="block text-xs text-muted mt-0.5">
                      {m.typ} · gemeldet {isoDatumText(m.gemeldetAm)}
                      {m.gemeldetVon ? ` von ${namen.name(m.gemeldetVon)}` : ''} · Vorgang{' '}
                      {m.nummer}
                    </span>
                  </span>
                  <span className="badge-gray shrink-0">{EREIGNIS_STATUS_LABEL[m.status]}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <TcmsLeer icon={Inbox} text="Noch keine Meldungen über das Portal." />
        )}
      </section>

      <p className="alert-info-sm mt-4">
        Angaben Ihrer Kanzlei. Statusangaben sind Arbeitsstände, keine Aussage über Angemessenheit
        oder Wirksamkeit. Rückfragen richten Sie bitte an Ihr Kanzleiteam.
      </p>
    </div>
  );
}

function AufgabeZeile({ a, namen }: { a: Aufgabe; namen: TcmsNamen }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-6 py-3 border-b border-default last:border-b-0">
      <span>
        <Link
          href={`/portal/tcms/aufgaben/${encodeURIComponent(a.durchfuehrungId)}`}
          className="block text-sm font-medium text-primary hover:underline"
        >
          {a.art === 'BESTAETIGEN' ? 'Bestätigen: ' : ''}
          <TcmsText>{a.titel}</TcmsText>
        </Link>
        <span className="block text-xs text-muted mt-0.5">
          <TcmsText>{a.periodeLabel}</TcmsText> · fällig {isoDatumText(a.faelligAm)} · Nachweise{' '}
          {a.nachweise}/{a.mindestNachweise}
          {a.zustaendigId ? ` · ${namen.name(a.zustaendigId)}` : ''}
        </span>
      </span>
      <AnzeigeBadge status={a.anzeige} />
    </li>
  );
}
