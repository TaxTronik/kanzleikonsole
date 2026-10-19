// =============================================================================
// /staff/clients/:id/tcms/kontakte — Kontakte & Tax-CMS-Rollen (TCMS Stufe 3).
//
// Kontakte kommen aus der kanzleikonsole (nur dieser Mandant), Rollen aus dem
// TCMS (`GET …/kontakte`). Einträge des TCMS ohne Kontakt dieses Mandanten
// werden nicht angezeigt, nur gezählt – keine Daten eines anderen Mandanten,
// keine erratenen Namen. Ein Kontakt ohne aktive Rolle hat im Tax-CMS keinen
// Zugriff (ADR 0001 §5).
// =============================================================================

import { Users } from 'lucide-react';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { TcmsLeer } from '@/components/tcms/leer';
import {
  TCMS_KONTAKT_ROLLE_LABEL,
  TCMS_KONTAKT_ROLLEN,
  type TcmsKontaktRolle,
} from '@/components/tcms/rollen';
import { TcmsZustand } from '@/components/tcms/zustand';
import { kontakteDesMandantenTx } from '@/server/tcms/personen';
import { tcmsLesen, tcmsMandantSeite, tcmsTenantLesen } from '@/server/tcms/seite';
import { RollenFormular } from './rollen-formular';

export const metadata = { title: 'Tax-CMS – Kontakte & Rollen' };

const ROLLEN_AUSWAHL = TCMS_KONTAKT_ROLLEN.map((wert) => ({
  wert,
  label: TCMS_KONTAKT_ROLLE_LABEL[wert],
}));

export default async function TcmsKontaktePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const seite = await tcmsMandantSeite(id);
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;

  const rollen = await tcmsLesen(seite, ENDPUNKTE.kontakteLesen);
  if (!rollen.ok) return <TcmsZustand zustand={rollen.zustand} />;
  const kontakte = await tcmsTenantLesen(seite, (tx) =>
    kontakteDesMandantenTx(tx, {
      tenantId: seite.session.user.tenantId,
      mandantId: seite.mandantId,
    }),
  );

  const rollenJe = new Map(rollen.daten.kontakte.map((k) => [k.kontaktId.toLowerCase(), k.rollen]));
  const bekannt = new Set(kontakte.map((k) => k.id.toLowerCase()));
  const ohneKontakt = rollen.daten.kontakte.filter(
    (k) => !bekannt.has(k.kontaktId.toLowerCase()) && k.rollen.some((r) => r.aktiv),
  ).length;

  return (
    <section aria-labelledby="tcms-kontakte">
      <h2 id="tcms-kontakte" className="text-lg font-semibold text-primary mb-1">
        Kontakte & Rollen
      </h2>
      <p className="text-sm text-muted mb-4 max-w-3xl">
        Rollen der Mandantenseite im Tax-CMS. Die gesetzliche Vertretung und die
        Tax-Compliance-Beauftragten sehen im Portal alle Aufgaben, Mitarbeitende nur ihre eigenen.
        Ohne aktive Rolle hat ein Kontakt keinen Zugriff auf das Tax-CMS. Kontakte selbst pflegen
        Sie in der Mandantenakte.
      </p>
      {ohneKontakt > 0 ? (
        <p className="alert-warning mb-4" role="status">
          {ohneKontakt === 1
            ? 'Ein Eintrag im Tax-CMS gehört zu keinem Kontakt dieses Mandanten und wird hier nicht angezeigt.'
            : `${ohneKontakt} Einträge im Tax-CMS gehören zu keinem Kontakt dieses Mandanten und werden hier nicht angezeigt.`}
        </p>
      ) : null}
      {kontakte.length === 0 ? (
        <div className="card">
          <TcmsLeer icon={Users} text="Für diesen Mandanten sind keine Kontakte erfasst." />
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="th">Kontakt</th>
                <th className="th">Aktive Rollen im Tax-CMS</th>
                <th className="th">Rollen ändern</th>
              </tr>
            </thead>
            <tbody>
              {kontakte.map((k) => {
                const eintraege = rollenJe.get(k.id.toLowerCase()) ?? [];
                const aktiv = eintraege.filter((r) => r.aktiv);
                return (
                  <tr key={k.id} className="border-t border-default align-top">
                    <td className="px-6 py-3">
                      <span className="block font-medium text-primary">{k.name}</span>
                      <span className="block text-xs text-muted">{k.email}</span>
                      {k.funktion ? (
                        <span className="block text-xs text-muted">{k.funktion}</span>
                      ) : null}
                      {!k.aktiv ? <span className="badge-gray mt-1">inaktiv</span> : null}
                    </td>
                    <td className="px-6 py-3">
                      {aktiv.length === 0 ? (
                        <span className="text-muted">keine – kein Zugriff</span>
                      ) : (
                        <ul className="flex flex-wrap gap-1">
                          {aktiv.map((r) => (
                            <li key={r.rolle} className="badge-brand">
                              {TCMS_KONTAKT_ROLLE_LABEL[r.rolle as TcmsKontaktRolle]}
                            </li>
                          ))}
                        </ul>
                      )}
                      {aktiv[0]?.funktion ? (
                        <span className="block text-xs text-muted mt-1">{aktiv[0].funktion}</span>
                      ) : null}
                    </td>
                    <td className="px-6 py-3 min-w-[18rem]">
                      <RollenFormular
                        mandantId={seite.mandantId}
                        kontaktId={k.id}
                        kontaktName={k.name}
                        rollen={ROLLEN_AUSWAHL}
                        aktiveRollen={aktiv.map((r) => r.rolle)}
                        funktion={aktiv[0]?.funktion ?? null}
                        rollenZuweisbar={k.aktiv}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted mt-4">
        Ob Sie Rollen ändern dürfen, entscheidet das Tax-CMS (Admins und Partner, zuständige
        Berufsträgerin oder Hauptbearbeitung).
      </p>
    </section>
  );
}
