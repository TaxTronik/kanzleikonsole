// =============================================================================
// Eingangsliste des Ereigniseingangs (TCMS Stufe 3, Bereich D; aus der Demo
// staff/clients/[id]/tcms/ereignisse/page.tsx). Reine Anzeige der Antwort von
// `ereignisseLesen` (Status zum Stichtag); die Auswahl öffnet die Triage über
// `?e=<id>`. Namen aus der kanzleikonsole.
// =============================================================================

import Link from 'next/link';
import { Inbox } from 'lucide-react';
import type { EreignisListeSchema } from '@taxtronik/tcms-contract';
import { EREIGNIS_STATUS_BADGE, EREIGNIS_STATUS_LABEL } from '@taxtronik/tcms-domain';
import type { z } from 'zod';
import { isoZeitText } from '../format';
import { KatalogIcon } from '../icon';
import { TcmsLeer } from '../leer';
import { badgeKlasse, tonChip } from '../ton';
import { quelleText, typInfo, typKurz } from './texte';
import { TcmsText } from '@/components/tcms/text';

export type EreignisListenEintrag = z.infer<typeof EreignisListeSchema>['ereignisse'][number];

export function EreignisListe({
  ereignisse,
  gewaehltId,
  href,
  namen,
  feststellungNummer,
}: {
  ereignisse: readonly EreignisListenEintrag[];
  gewaehltId: string | null;
  /** Link zur Auswahl eines Ereignisses (Stichtag bleibt erhalten). */
  href: (ereignisId: string) => string;
  namen: { name(id: string | null | undefined): string };
  /** Feststellung → Link (nur lesbare Nummern aus dem Kontext). */
  feststellungNummer: (id: string) => { nummer: string; href: string } | null;
}) {
  const neu = ereignisse.filter((e) => e.status === 'NEU').length;
  const inTriage = ereignisse.filter((e) => e.status === 'IN_TRIAGE').length;
  return (
    <section className="card self-start" aria-labelledby="tcms-ereignis-eingang">
      <div className="card-header">
        <h3 id="tcms-ereignis-eingang" className="text-sm font-semibold text-primary">
          Eingang
        </h3>
        <span className="text-xs text-muted">Neueste oben · Auswahl öffnet die Triage</span>
      </div>
      {ereignisse.length === 0 ? (
        <TcmsLeer icon={Inbox} text="Noch keine Ereignisse gemeldet." />
      ) : (
        <ul>
          {ereignisse.map((e) => {
            const t = typInfo(e.typ);
            const gewaehlt = e.id === gewaehltId;
            const feststellungen = e.folgen
              .filter((f) => f.art === 'FESTSTELLUNG_ANLEGEN' && f.objektId)
              .map((f) => feststellungNummer(f.objektId!))
              .filter((f): f is { nummer: string; href: string } => f !== null);
            return (
              <li
                key={e.id}
                className={`flex items-start gap-3 px-6 py-3 border-b border-default last:border-b-0 ${
                  gewaehlt ? 'bg-surface-sunken' : ''
                }`}
              >
                <span className={`kpi-chip ${tonChip(t.ton)}`}>
                  <KatalogIcon name={t.icon} />
                </span>
                <div className="grow min-w-0">
                  <Link
                    href={href(e.id)}
                    scroll={false}
                    aria-current={gewaehlt ? 'true' : undefined}
                    className="block text-sm font-medium text-primary hover:underline"
                  >
                    {typKurz(e.typ)} · <TcmsText>{e.titel}</TcmsText>
                  </Link>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted mt-1">
                    <span className="badge-gray">{quelleText(e.quelle)}</span>
                    <span className="font-mono">{e.nummer}</span>
                    <span>
                      {e.gemeldetVon ? `${namen.name(e.gemeldetVon)} · ` : ''}
                      {isoZeitText(e.gemeldetAm)}
                    </span>
                    {feststellungen.map((f) => (
                      <Link key={f.nummer} href={f.href} className="badge-gray hover:underline">
                        → {f.nummer}
                      </Link>
                    ))}
                  </div>
                </div>
                <span className="flex flex-col items-end gap-1 shrink-0">
                  <span className={badgeKlasse(EREIGNIS_STATUS_BADGE[e.status])}>
                    {EREIGNIS_STATUS_LABEL[e.status]}
                  </span>
                  {e.verwerfenBeantragt && e.status !== 'VERWORFEN' ? (
                    <span className="badge-yellow">Verwerfen beantragt</span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="card-footer">
        <span>
          {ereignisse.length} {ereignisse.length === 1 ? 'Eintrag' : 'Einträge'} · {neu} nicht
          triagiert · {inTriage} in Triage
        </span>
      </p>
    </section>
  );
}
