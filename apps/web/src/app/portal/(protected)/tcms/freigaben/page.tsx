// =============================================================================
// /portal/tcms/freigaben — Freigaben und Kenntnisnahmen (TCMS Stufe 3,
// Bereich D; portiert aus der Demo portal/tcms/freigaben/page.tsx).
//
// Mandant nur aus der Portal-Sitzung. Sichtbarkeit (Mitarbeitende nur
// Eigenes), Rechte-Kennzeichen und Codezustand berechnet das Tax-CMS
// (`portalFreigabenLesen`); Namen aus der kanzleikonsole. Der Bestätigungscode
// erscheint nirgends auf der Seite – nur in der E-Mail an die adressierte
// Person; der Entwicklungs-Postausgang der Demo entfällt.
// =============================================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeft, CheckCheck, FileText, Mail } from 'lucide-react';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { isoZeitText } from '@/components/tcms/format';
import { TcmsLeer } from '@/components/tcms/leer';
import { ErledigtZeile, erledigtText, FreigabeKarte } from '@/components/tcms/portal/freigabe';
import { TcmsZustand } from '@/components/tcms/zustand';
import { personIdsAus } from '@/server/tcms/namen';
import { tcmsLesen, tcmsNamenLesen, tcmsPortalSeite } from '@/server/tcms/seite';
import {
  portalFreigabeCodeAnfordernAction,
  portalFreigebenAction,
  portalKenntnisnahmeAction,
} from './actions';

export const metadata = { title: 'Tax-CMS – Freigaben und Kenntnisnahmen' };

function Rahmen({ children }: { children: ReactNode }) {
  return (
    <div className="p-8">
      <Link href="/portal/tcms" className="back-link">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Zur Übersicht
      </Link>
      <h1 className="text-2xl font-bold text-primary">Freigaben und Kenntnisnahmen</h1>
      {children}
    </div>
  );
}

const SCHRITTE: ReadonlyArray<{ Icon: typeof FileText; titel: string; text: string }> = [
  {
    Icon: FileText,
    titel: 'Dokument ansehen',
    text: 'Die vorgelegte Fassung ist eingefroren und durch einen SHA-256-Wert gebunden.',
  },
  {
    Icon: Mail,
    titel: 'Code anfordern',
    text: 'Sie erhalten einen 6-stelligen Code per E-Mail; er ist befristet gültig.',
  },
  {
    Icon: CheckCheck,
    titel: 'Freigeben',
    text: 'Mit dem Code bestätigen Sie die Fassung. Nach mehreren Fehlversuchen wird der Code gesperrt.',
  },
];

export default async function PortalFreigabenPage({
  searchParams,
}: {
  searchParams: Promise<{ erledigt?: string | string[] }>;
}) {
  const seite = await tcmsPortalSeite();
  if (!seite.ok) {
    return (
      <Rahmen>
        <TcmsZustand zustand={seite.zustand} />
      </Rahmen>
    );
  }
  const gelesen = await tcmsLesen(seite, ENDPUNKTE.portalFreigabenLesen);
  if (!gelesen.ok) {
    return (
      <Rahmen>
        <TcmsZustand zustand={gelesen.zustand} />
      </Rahmen>
    );
  }
  const v = gelesen.daten;
  const namen = await tcmsNamenLesen(
    seite,
    personIdsAus(
      v.freigaben.flatMap((f) => [f.angefordertVon, f.empfaengerId, f.version?.freigegebenVon]),
      v.fruehere.map((x) => x.freigegebenVon),
      v.gesetzlicheVertreter,
    ),
  );
  const kann = (f: (typeof v.freigaben)[number]) => f.darfFreigeben || f.darfKenntnisnehmen;
  const offen = v.freigaben
    .filter((f) => f.status === 'OFFEN')
    .sort((a, b) => Number(kann(b)) - Number(kann(a)));
  const erledigt = v.freigaben.filter((f) => f.status !== 'OFFEN');
  const fruehere = v.kannPortalLesen ? v.fruehere : [];
  const gvNamen = v.gesetzlicheVertreter.map((id) => namen.name(id)).join(', ');
  const { erledigt: erledigtRoh } = await searchParams;
  const erledigtId = Array.isArray(erledigtRoh) ? erledigtRoh[0] : erledigtRoh;
  const bestaetigt = erledigtId ? erledigt.find((f) => f.id === erledigtId) : undefined;
  const ich = seite.session.user.contactId.toLowerCase();

  return (
    <Rahmen>
      <p className="text-sm text-muted mb-4 max-w-3xl">
        Hier geben Sie Dokumente Ihres Compliance-Programms frei oder bestätigen, dass Sie sie zur
        Kenntnis genommen haben. Jede Bestätigung wird mit Name und Zeitpunkt dokumentiert.
      </p>
      {bestaetigt ? (
        <p className="alert-success mb-4 flex items-center gap-2" role="status">
          <CheckCheck className="h-4 w-4" aria-hidden="true" />
          <span>
            <strong>{bestaetigt.titel}</strong>{' '}
            {bestaetigt.art === 'KENNTNISNAHME' ? 'zur Kenntnis genommen' : 'freigegeben'} ·{' '}
            {isoZeitText(bestaetigt.erledigtAm)}. Vielen Dank – die Bestätigung ist mit Name und
            Zeitpunkt dokumentiert.
          </span>
        </p>
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        <div className="xl:col-span-8 space-y-4">
          <section className="card" aria-labelledby="tcms-freigaben-offen">
            <div className="card-header">
              <h2 id="tcms-freigaben-offen" className="text-sm font-semibold text-primary">
                Offen
              </h2>
              <span className={offen.length ? 'badge-yellow' : 'badge-green'}>
                {offen.length ? `${offen.length} offen` : 'nichts offen'}
              </span>
            </div>
            {offen.length ? (
              <div className="p-4 space-y-4">
                {offen.map((f) => (
                  <FreigabeKarte
                    key={f.id}
                    f={f}
                    namen={namen}
                    gvNamen={gvNamen}
                    zeigeDokument={v.kannPortalLesen || f.empfaengerId.toLowerCase() === ich}
                    live={v.live}
                    aktionen={{
                      codeAnfordern: portalFreigabeCodeAnfordernAction.bind(null, f.id),
                      freigeben: portalFreigebenAction.bind(null, f.id),
                      kenntnisnehmen: portalKenntnisnahmeAction.bind(null, f.id),
                    }}
                  />
                ))}
              </div>
            ) : (
              <TcmsLeer
                icon={CheckCheck}
                text="Derzeit liegt nichts zur Freigabe oder Kenntnisnahme vor."
              />
            )}
            <p className="card-footer">
              <span>
                Freigaben sind der gesetzlichen Vertretung vorbehalten; Kenntnisnahmen bestätigt die
                adressierte Person.
              </span>
            </p>
          </section>

          <section className="card" aria-labelledby="tcms-freigaben-erledigt">
            <div className="card-header">
              <h2 id="tcms-freigaben-erledigt" className="text-sm font-semibold text-primary">
                Erledigt
              </h2>
              <span className="text-xs text-muted">{erledigt.length + fruehere.length}</span>
            </div>
            {erledigt.length || fruehere.length ? (
              <ul>
                {erledigt.map((f) => {
                  const e = erledigtText(f, namen);
                  return (
                    <ErledigtZeile
                      key={f.id}
                      titel={f.titel}
                      art={f.art}
                      text={e.text}
                      abgelehnt={e.abgelehnt}
                      hash={f.status === 'FREIGEGEBEN' ? (f.version?.snapshotSha256 ?? null) : null}
                    />
                  );
                })}
                {fruehere.map((x) => (
                  <ErledigtZeile
                    key={x.id}
                    titel={`CMS-Beschreibung v${x.nummer}`}
                    art="BESCHREIBUNG"
                    text={`freigegeben · ${namen.name(x.freigegebenVon)} · ${isoZeitText(x.freigegebenAm)}${
                      x.status === 'ABGELOEST'
                        ? ' · inzwischen durch eine neuere Version abgelöst'
                        : ''
                    }`}
                    hash={x.snapshotSha256}
                  />
                ))}
              </ul>
            ) : (
              <p className="px-6 py-4 text-sm text-muted">Noch keine erledigten Freigaben.</p>
            )}
          </section>
        </div>

        <aside className="xl:col-span-4 space-y-4" aria-label="So funktioniert die Freigabe">
          <section className="card" aria-labelledby="tcms-freigaben-hilfe">
            <div className="card-header">
              <h2 id="tcms-freigaben-hilfe" className="text-sm font-semibold text-primary">
                So funktioniert die Freigabe
              </h2>
            </div>
            <ol className="p-4 space-y-3">
              {SCHRITTE.map(({ Icon, titel, text }) => (
                <li key={titel} className="flex items-start gap-3">
                  <span className="kpi-chip chip-brand" aria-hidden="true">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold">{titel}</span>
                    <span className="block text-xs text-muted">{text}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="card-footer">
              <span>Ein Hash bindet Inhalte; er ersetzt keine Unterschrift.</span>
            </p>
          </section>
        </aside>
      </div>
    </Rahmen>
  );
}
