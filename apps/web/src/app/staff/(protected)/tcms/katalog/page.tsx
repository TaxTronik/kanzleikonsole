// =============================================================================
// /staff/tcms/katalog — Katalog des Tax-CMS-Branchenpakets (TCMS Stufe 3,
// Bereich A; portiert aus der Demo staff/admin/katalog/page.tsx). Nur Lesen,
// nur Daten aus @taxtronik/tcms-domain; kein Dienstaufruf.
//
// Wie in der Demo Admins und Partnern vorbehalten (Katalogverwaltung):
// Einstieg `tcmsAdminSeite()` (requireStaffPage({ admin: true }), Modul
// `tcms`, Dienst konfiguriert und aktiv, Akteur ohne Mandantenbezug). Andere
// Kanzleipersonen leitet der Einstieg zum Portfolio um.
// =============================================================================

import Link from 'next/link';
import { ArrowLeft, TriangleAlert } from 'lucide-react';
import { PAKET } from '@taxtronik/tcms-domain';
import {
  EreignisseTab,
  KATALOG_TABS,
  KatalogKennzahlen,
  katalogTab,
  KontrollenTab,
  MatrixTab,
  ProfilTab,
  RisikenTab,
} from '@/components/tcms/programm/katalog';
import { TcmsZustand } from '@/components/tcms/zustand';
import { tcmsAdminSeite } from '@/server/tcms/seite';
import { TcmsText } from '@/components/tcms/text';

export const metadata = { title: 'Tax-CMS – Katalog' };

export default async function TcmsKatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const seite = await tcmsAdminSeite();
  if (!seite.ok) {
    return (
      <div className="p-8">
        <TcmsZustand
          zustand={seite.zustand}
          zurueck={{ href: '/staff/tcms', label: 'Zum Portfolio' }}
        />
      </div>
    );
  }
  const roh = (await searchParams).tab;
  const tab = katalogTab(Array.isArray(roh) ? roh[0] : roh);

  return (
    <div className="p-8">
      <Link href="/staff/tcms" className="back-link">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Zum Tax-CMS-Portfolio
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-primary">Tax-CMS-Katalog</h1>
          <p className="text-sm text-muted">
            Branchenpaket <TcmsText>{PAKET.name}</TcmsText> v{PAKET.version} · Startfassung · nur
            Lesen
          </p>
        </div>
        <span className="badge-yellow">Status: Entwurf (ungeprüft)</span>
      </div>

      <div className="alert-warning mb-4 flex items-start gap-3" role="note">
        <TriangleAlert className="h-5 w-5 shrink-0 mt-0.5" aria-hidden="true" />
        <p>
          <strong>Ungeprüfter Entwurf.</strong> Katalogwerte, Normanker und die Startwerte der
          Häufigkeitsmatrix sind ungeprüfte Entwürfe und vom Berufsträger zu kalibrieren. Normanker
          tragen die Vertrauensstufe „ungeprüft“, bis ein Berufsträger sie freigibt; der Katalog
          ersetzt keine Einzelfallprüfung.
        </p>
      </div>

      <KatalogKennzahlen />

      <nav aria-label="Teile des Katalogs" className="mb-4 overflow-x-auto">
        <ul className="flex gap-2 pb-1 min-w-max">
          {KATALOG_TABS.map((t) => (
            <li key={t.key}>
              <Link
                href={
                  t.key === 'risiken' ? '/staff/tcms/katalog' : `/staff/tcms/katalog?tab=${t.key}`
                }
                className={`${t.key === tab ? 'btn-primary' : 'btn-secondary'} text-xs py-1`}
                aria-current={t.key === tab ? 'page' : undefined}
              >
                <TcmsText>{t.label}</TcmsText>
                {t.anzahl !== null ? ` (${t.anzahl})` : ''}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {tab === 'risiken' ? <RisikenTab /> : null}
      {tab === 'kontrollen' ? <KontrollenTab /> : null}
      {tab === 'ereignisse' ? <EreignisseTab /> : null}
      {tab === 'matrix' ? <MatrixTab /> : null}
      {tab === 'profil' ? <ProfilTab /> : null}

      <p className="text-xs text-muted mt-4">
        Katalogänderungen laufen im TCMS-Repo nur vorwärts im Vier-Augen-Prinzip; Mandanten erhalten
        eine neue Version als Update-Vorschlag, nie still.
      </p>
    </div>
  );
}
