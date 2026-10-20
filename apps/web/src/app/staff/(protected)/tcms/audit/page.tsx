// =============================================================================
// /staff/tcms/audit — Audit-Protokoll des Tax-CMS (TCMS Stufe 3, Bereich D;
// portiert aus der Demo staff/admin/audit/page.tsx).
//
// Nur Admins und Partner: tcmsAdminSeite (requireStaffPage admin, sonst
// Weiterleitung zum Portfolio) und im Dienst kannVerwalten. Liste über
// `auditLesen` (Filter nur in gültiger Form, sonst ohne Filter), neueste
// zuerst, Blättern über die Position `vor`. Kettenprüfung als Aktion (nurAdmin).
//
// Personen erscheinen mit dem im Protokoll festgehaltenen Namen (Bestandteil
// des gehashten Eintrags, aus der Akteursbestätigung der kanzleikonsole zum
// Zeitpunkt der Handlung) – bewusst nicht mit dem heutigen Namen. Mandanten
// mit dem Namen aus der kanzleikonsole.
// =============================================================================

import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { AuditQuerySchema, ENDPUNKTE, MAX_AUDIT_POS } from '@taxtronik/tcms-contract';
import { AdminKopf, Blaettern } from '@/components/tcms/admin/teile';
import { HashKurz } from '@/components/tcms/badges';
import { TcmsAktionsKnopf } from '@/components/tcms/ereignisse/aktionen';
import { isoZeitText } from '@/components/tcms/format';
import { TcmsLeer } from '@/components/tcms/leer';
import { TcmsZustand } from '@/components/tcms/zustand';
import { tcmsAdminSeite, tcmsLesen, tcmsTenantLesen } from '@/server/tcms/seite';
import { auditPruefenAction } from './actions';
import { TCMS_TEXT_ISOLIERT, TcmsText } from '@/components/tcms/text';

export const metadata = { title: 'Tax-CMS – Audit-Protokoll' };

const PRO_SEITE = 50;
const MAX_MANDANTEN_AUSWAHL = 2000;
type SP = Record<string, string | string[] | undefined>;
const eins = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

interface Filter {
  mandantId: string;
  aktion: string;
  vor: number | null;
}

/** Filter aus der URL; nur was der Vertrag annimmt, sonst ohne diesen Filter. */
function auditFilter(sp: SP): Filter {
  const mandant = eins(sp['mandant']).toLowerCase();
  const aktion = eins(sp['aktion']).trim();
  const vor = eins(sp['vor']);
  const filter: Filter = { mandantId: '', aktion: '', vor: null };
  if (AuditQuerySchema.safeParse({ mandantId: mandant }).success) filter.mandantId = mandant;
  if (AuditQuerySchema.safeParse({ aktion }).success) filter.aktion = aktion;
  if (/^[0-9]{1,10}$/.test(vor) && Number(vor) <= MAX_AUDIT_POS) filter.vor = Number(vor);
  return filter;
}

function href(f: Filter, vor: number | null): string {
  const p = new URLSearchParams();
  if (f.mandantId) p.set('mandant', f.mandantId);
  if (f.aktion) p.set('aktion', f.aktion);
  if (vor !== null) p.set('vor', String(vor));
  const q = p.toString();
  return q ? `/staff/tcms/audit?${q}` : '/staff/tcms/audit';
}

export default async function TcmsAuditPage({ searchParams }: { searchParams: Promise<SP> }) {
  const seite = await tcmsAdminSeite();
  if (!seite.ok) return <TcmsZustand zustand={seite.zustand} />;
  const f = auditFilter(await searchParams);

  const liste = await tcmsLesen(seite, ENDPUNKTE.auditLesen, {
    query: {
      ...(f.mandantId ? { mandantId: f.mandantId } : {}),
      ...(f.aktion ? { aktion: f.aktion } : {}),
      vor: String(f.vor ?? MAX_AUDIT_POS),
      limit: String(PRO_SEITE),
    },
  });
  if (!liste.ok) return <TcmsZustand zustand={liste.zustand} />;
  const { eintraege, weiter, kopf } = liste.daten;
  const mandanten = await tcmsTenantLesen(seite, (tx) =>
    tx.client.findMany({
      where: { tenantId: seite.session.user.tenantId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: MAX_MANDANTEN_AUSWAHL,
    }),
  );
  const mandantName = new Map(mandanten.map((m) => [m.id.toLowerCase(), m.name]));
  const praefixe = [
    ...new Set(eintraege.flatMap((e) => [e.aktion.split('.').slice(0, 2).join('.'), e.aktion])),
  ].sort();
  const gefiltert = f.mandantId !== '' || f.aktion !== '';

  return (
    <div className="p-8">
      <AdminKopf
        titel="Audit-Protokoll"
        unter="Manipulationsevidentes Protokoll aller fachlichen Änderungen im Tax-CMS (SHA-256-Hashkette je Kanzlei)."
      />

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 mb-4 items-start">
        <section className="card p-4 xl:col-span-8" aria-labelledby="tcms-audit-filter">
          <h2 id="tcms-audit-filter" className="sr-only">
            Filter
          </h2>
          <form method="get" action="/staff/tcms/audit" className="flex flex-wrap items-end gap-4">
            <div>
              <label htmlFor="audit-mandant" className="label-sm">
                Mandant
              </label>
              <select
                id="audit-mandant"
                name="mandant"
                className="input max-w-xs"
                defaultValue={f.mandantId}
              >
                <option value="">Alle</option>
                {mandanten.map((m) => (
                  <option {...TCMS_TEXT_ISOLIERT} key={m.id} value={m.id.toLowerCase()}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="audit-aktion" className="label-sm">
                Aktion beginnt mit
              </label>
              <input
                id="audit-aktion"
                name="aktion"
                className="input font-mono text-sm w-56"
                list="audit-praefixe"
                placeholder="z. B. tcms.durchfuehrung"
                defaultValue={f.aktion}
                maxLength={100}
              />
              <datalist id="audit-praefixe">
                {praefixe.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>
            <div className="flex gap-2">
              <button type="submit" className="btn-secondary">
                Filtern
              </button>
              {gefiltert ? (
                <Link href="/staff/tcms/audit" className="btn-secondary">
                  Zurücksetzen
                </Link>
              ) : null}
            </div>
          </form>
        </section>

        <section className="card p-4 xl:col-span-4" aria-labelledby="tcms-audit-integritaet">
          <h2 id="tcms-audit-integritaet" className="text-sm font-semibold text-primary">
            Integrität
          </h2>
          <p className="text-xs text-muted mt-1 mb-3">
            {kopf ? (
              <>
                Kettenende #{kopf.pos} · <HashKurz wert={kopf.hash} /> · {isoZeitText(kopf.at)}
              </>
            ) : (
              'noch keine Einträge'
            )}
          </p>
          <TcmsAktionsKnopf aktion={auditPruefenAction}>
            <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Hashkette prüfen
          </TcmsAktionsKnopf>
        </section>
      </div>

      <p className="alert-info-sm mb-4" role="note">
        Hashkette ohne qualifizierten Zeitstempel. Ein Hash bindet Inhalte, er authentifiziert keine
        Person. Einträge werden nie geändert oder gelöscht.
      </p>

      <section className="card overflow-x-auto" aria-labelledby="tcms-audit-liste">
        <h2 id="tcms-audit-liste" className="sr-only">
          Einträge
        </h2>
        {eintraege.length === 0 ? (
          <TcmsLeer
            icon={ShieldCheck}
            text={gefiltert ? 'Keine Einträge für diesen Filter.' : 'Noch keine Audit-Einträge.'}
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th scope="col" className="th text-right">
                  #
                </th>
                <th scope="col" className="th">
                  Zeit
                </th>
                <th scope="col" className="th">
                  Person (laut Protokoll)
                </th>
                <th scope="col" className="th">
                  Aktion
                </th>
                <th scope="col" className="th">
                  Objekt
                </th>
                <th scope="col" className="th">
                  Mandant
                </th>
                <th scope="col" className="th">
                  Hash
                </th>
              </tr>
            </thead>
            <tbody>
              {eintraege.map((e) => {
                const detail = JSON.stringify(e.detail ?? {});
                const mandant = e.mandantId ? mandantName.get(e.mandantId.toLowerCase()) : null;
                return (
                  <tr key={e.pos} id={`pos-${e.pos}`} className="border-t border-default align-top">
                    <td className="px-3 py-2 td-num text-xs">{e.pos}</td>
                    <td className="px-3 py-2 text-xs font-mono whitespace-nowrap">
                      {isoZeitText(e.at)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <TcmsText>{e.actorName}</TcmsText>
                    </td>
                    <td className="px-3 py-2">
                      <span className="font-mono text-xs font-semibold">
                        <TcmsText>{e.aktion}</TcmsText>
                      </span>
                      {detail !== '{}' ? (
                        <span
                          className="block text-xs text-muted font-mono mt-1 max-w-xs truncate"
                          title={detail}
                          {...TCMS_TEXT_ISOLIERT}
                        >
                          {detail}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {e.objektTyp}
                      <span className="block font-mono text-muted" title={e.objektId}>
                        …{e.objektId.slice(-8)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-secondary">
                      {mandant ?? <span className="text-muted">–</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="badge-gray" title={`Vorgänger ${e.prevHash}`}>
                        <HashKurz wert={e.hash} />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="card-footer flex flex-wrap items-center justify-between gap-2">
          <span>
            {eintraege.length} {eintraege.length === 1 ? 'Eintrag' : 'Einträge'}
            {gefiltert ? ' im Filter' : ''} · neueste zuerst · {PRO_SEITE} je Seite
          </span>
          <Blaettern
            neueste={f.vor !== null ? href(f, null) : null}
            aeltere={weiter !== null ? href(f, weiter) : null}
          />
        </div>
      </section>
    </div>
  );
}
