// =============================================================================
// /portal/tcms/ereignis — Ereignis melden (TCMS Stufe 3, Bereich D; portiert
// aus der Demo portal/tcms/ereignis/page.tsx).
//
// Mandant nur aus der Portal-Sitzung. Ob die Person melden darf und ob ein
// Programm besteht, sagt das Tax-CMS (`melden`, `programmVorhanden` von
// `portalMeldungenLesen`, TCMS s7); bisherige Meldungen ebenfalls von dort –
// ohne Leserecht im Portal (`rechte.portalLesen` der Übersicht) nur die
// eigenen (TCMS s8), mit Hinweis. Die Übersicht liefert zudem „heute“.
// Ansprechperson und Namen aus der kanzleikonsole.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeft, Check, Inbox, ShieldCheck } from 'lucide-react';
import { ENDPUNKTE, PORTAL_MAX_ANLAGE_BYTES, PORTAL_MAX_ANLAGEN } from '@taxtronik/tcms-contract';
import { EREIGNIS_STATUS_BADGE } from '@taxtronik/tcms-domain';
import {
  PORTAL_KACHELN,
  PORTAL_MELDUNG_STATUS_LABEL,
  typInfo,
} from '@/components/tcms/ereignisse/texte';
import { isoDatumText, isoZeitText } from '@/components/tcms/format';
import { KatalogIcon } from '@/components/tcms/icon';
import { TcmsLeer } from '@/components/tcms/leer';
import { MeldungFormular } from '@/components/tcms/portal/meldung-formular';
import {
  NUR_EIGENE_MELDUNGEN,
  PORTAL_ANLAGE_ACCEPT,
  portalAnlageHinweis,
} from '@/components/tcms/portal/texte';
import { badgeKlasse, tonChip } from '@/components/tcms/ton';
import { TcmsZustand } from '@/components/tcms/zustand';
import { readPortalFeaturesTx } from '@/server/settings/portal-features';
import { personIdsAus } from '@/server/tcms/namen';
import { ansprechpersonenTx } from '@/server/tcms/portal/ansprechpartner';
import { PORTAL_ANLAGEN_GESAMT_BYTES } from '@/server/tcms/portal/anlagen';
import { tcmsLesen, tcmsNamenLesen, tcmsPortalSeite, tcmsTenantLesen } from '@/server/tcms/seite';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import { portalEreignisMeldenAction } from './actions';

export const metadata = { title: 'Tax-CMS – Ereignis melden' };

/** Mindestlängen laut Vertrag (PortalMeldungBodySchema: Titel 5, Beschreibung 10). */
const MIN_TITEL = 5;
const MIN_BESCHREIBUNG = 10;

function Rahmen({ children }: { children: ReactNode }) {
  return (
    <div className="p-8">
      <Link href="/portal/tcms" className="back-link">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Zur Übersicht
      </Link>
      <h1 className="text-2xl font-bold text-primary">Ereignis melden</h1>
      {children}
    </div>
  );
}

export default async function PortalEreignisPage({
  searchParams,
}: {
  searchParams: Promise<{ gemeldet?: string | string[] }>;
}) {
  const seite = await tcmsPortalSeite();
  if (!seite.ok) {
    return (
      <Rahmen>
        <TcmsZustand zustand={seite.zustand} />
      </Rahmen>
    );
  }
  const [meldungen, uebersicht] = await Promise.all([
    tcmsLesen(seite, ENDPUNKTE.portalMeldungenLesen),
    tcmsLesen(seite, ENDPUNKTE.portalUebersichtLesen),
  ]);
  if (!meldungen.ok) {
    return (
      <Rahmen>
        <TcmsZustand zustand={meldungen.zustand} />
      </Rahmen>
    );
  }
  if (!uebersicht.ok) {
    return (
      <Rahmen>
        <TcmsZustand zustand={uebersicht.zustand} />
      </Rahmen>
    );
  }
  const m = meldungen.daten;
  const u = uebersicht.daten;
  const [namen, kanzlei] = await Promise.all([
    tcmsNamenLesen(seite, personIdsAus(m.meldungen.map((x) => x.gemeldetVon))),
    tcmsTenantLesen(seite, async (tx) => {
      const bezug = { tenantId: seite.session.user.tenantId, mandantId: seite.mandantId };
      const [personen, funktionen] = await Promise.all([
        ansprechpersonenTx(tx, bezug),
        readPortalFeaturesTx(tx, bezug.tenantId),
      ]);
      return { ansprechperson: personen.hauptbearbeitung, upload: funktionen.documentUpload };
    }),
  ]);
  const { gemeldet: gemeldetRoh } = await searchParams;
  const gemeldet = Array.isArray(gemeldetRoh) ? gemeldetRoh[0] : gemeldetRoh;
  const bestaetigt = gemeldet ? m.meldungen.find((x) => x.nummer === gemeldet) : undefined;
  const darf = m.melden;
  const sperrHinweis = darf ? null : TCMS_KEIN_RECHT.PORTAL_ROLLE;
  const ansprechperson = kanzlei.ansprechperson?.name ?? null;

  return (
    <Rahmen>
      <p className="text-sm text-muted mb-6 max-w-3xl">
        Melden Sie betriebliche Veränderungen. Ihre Kanzlei prüft und meldet sich bei Fragen – meist
        innerhalb eines Arbeitstags.
      </p>
      {!m.programmVorhanden || !u.programm ? (
        <div className="card">
          <TcmsLeer
            icon={ShieldCheck}
            text="Für Ihr Unternehmen ist noch kein Tax-CMS eingerichtet. Bitte wenden Sie sich an Ihre Kanzlei."
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
          <div className="xl:col-span-7 space-y-4">
            {bestaetigt ? (
              <section className="card" aria-labelledby="tcms-meldung-bestaetigung">
                <div className="card-header">
                  <h2 id="tcms-meldung-bestaetigung" className="text-sm font-semibold text-primary">
                    Bestätigung
                  </h2>
                </div>
                <div className="p-6 space-y-4">
                  <div
                    className="alert-success flex flex-col items-center text-center gap-2"
                    role="status"
                  >
                    <span className="kpi-chip chip-green">
                      <Check className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="font-semibold">Ereignis eingegangen</span>
                    <span className="font-mono text-sm">Vorgangsnummer: {bestaetigt.nummer}</span>
                    <span className="text-sm">
                      Gemeldet am {isoZeitText(bestaetigt.gemeldetAm)}
                      {bestaetigt.gemeldetVon ? ` von ${namen.name(bestaetigt.gemeldetVon)}` : ''}.
                      Ihre Kanzlei wurde benachrichtigt.
                    </span>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-primary mb-2">So geht es weiter</h3>
                    <ol className="list-decimal pl-5 space-y-1 text-sm text-secondary">
                      <li>
                        Ihre Kanzlei sichtet die Meldung und entscheidet, welche Schritte nötig sind
                        – meist innerhalb eines Arbeitstags.
                      </li>
                      <li>
                        Bei Rückfragen meldet sich {ansprechperson ?? 'Ihre Kanzlei'} bei Ihnen.
                      </li>
                      <li>
                        Je nach Art der Änderung werden Steuersätze, Registrierungen oder Abläufe
                        geprüft; gegebenenfalls erhalten Sie dazu Aufgaben im Portal.
                      </li>
                      <li>
                        Den Bearbeitungsstand sehen Sie jederzeit unter „Ihre bisherigen Meldungen“.
                      </li>
                    </ol>
                  </div>
                  <div className="form-actions">
                    <Link href="/portal/tcms" className="btn-secondary">
                      Zurück zur Übersicht
                    </Link>
                    <Link href="/portal/tcms/ereignis" className="btn-primary">
                      Weiteres Ereignis melden
                    </Link>
                  </div>
                </div>
              </section>
            ) : (
              <>
                {sperrHinweis ? (
                  <p className="alert-info-sm" role="note">
                    {sperrHinweis} Bitte wenden Sie sich an diese Personen oder direkt an Ihre
                    Kanzlei.
                  </p>
                ) : null}
                <MeldungFormular
                  aktion={portalEreignisMeldenAction}
                  kacheln={PORTAL_KACHELN}
                  heute={u.heute}
                  darf={darf}
                  sperrHinweis={sperrHinweis}
                  upload={kanzlei.upload}
                  grenzen={{
                    maxDateien: PORTAL_MAX_ANLAGEN,
                    maxBytes: PORTAL_MAX_ANLAGE_BYTES,
                    maxGesamt: PORTAL_ANLAGEN_GESAMT_BYTES,
                    minTitel: MIN_TITEL,
                    minBeschreibung: MIN_BESCHREIBUNG,
                  }}
                  accept={PORTAL_ANLAGE_ACCEPT}
                  uploadHinweis={portalAnlageHinweis({
                    maxDateien: PORTAL_MAX_ANLAGEN,
                    maxBytes: PORTAL_MAX_ANLAGE_BYTES,
                    maxGesamt: PORTAL_ANLAGEN_GESAMT_BYTES,
                  })}
                />
              </>
            )}
          </div>

          <div className="xl:col-span-5 space-y-4">
            <section className="card" aria-labelledby="tcms-meldungen-bisher">
              <div className="card-header">
                <h2 id="tcms-meldungen-bisher" className="text-sm font-semibold text-primary">
                  Ihre bisherigen Meldungen
                </h2>
                <span className="badge-gray">{m.meldungen.length}</span>
              </div>
              {u.rechte.portalLesen ? null : (
                <p className="px-6 pt-3 text-xs text-muted" role="note">
                  {NUR_EIGENE_MELDUNGEN}
                </p>
              )}
              {m.meldungen.length === 0 ? (
                <TcmsLeer icon={Inbox} text="Sie haben noch keine Ereignisse gemeldet." />
              ) : (
                <ul>
                  {m.meldungen.map((x) => {
                    const t = typInfo(x.typ);
                    return (
                      <li
                        key={x.id}
                        className={`flex items-start gap-3 px-6 py-3 border-b border-default last:border-b-0 ${
                          bestaetigt?.id === x.id ? 'bg-surface-sunken' : ''
                        }`}
                      >
                        <span className={`kpi-chip ${tonChip(t.ton)}`}>
                          <KatalogIcon name={t.icon} />
                        </span>
                        <span className="grow min-w-0">
                          <span className="block text-sm font-medium text-primary">{x.titel}</span>
                          <span className="block text-xs text-muted mt-0.5">
                            <span className="font-mono">{x.nummer}</span> ·{' '}
                            {isoDatumText(x.gemeldetAm)}
                            {x.gemeldetVon ? ` · ${namen.name(x.gemeldetVon)}` : ''}
                          </span>
                        </span>
                        <span
                          className={`${badgeKlasse(EREIGNIS_STATUS_BADGE[x.status])} shrink-0`}
                        >
                          {PORTAL_MELDUNG_STATUS_LABEL[x.status]}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            <p className="card p-4 text-sm text-secondary">
              Jede Meldung wird dokumentiert und protokolliert. Rückfragen kommen von Ihrer Kanzlei
              {ansprechperson ? ` (Ansprechpartner: ${ansprechperson})` : ''}.
            </p>
          </div>
        </div>
      )}
    </Rahmen>
  );
}
