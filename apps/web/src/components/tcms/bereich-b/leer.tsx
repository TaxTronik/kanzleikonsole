// Leere Zustände der Seiten des Bereichs B (TCMS Stufe 3): Mandant noch nicht
// im Tax-CMS (Kontext 404) bzw. noch kein Programm. Ob eingerichtet werden
// darf, sagt das Rechte-Kennzeichen des Dienstes (wie im Cockpit).
import Link from 'next/link';
import { ArrowRight, ShieldCheck, type LucideIcon } from 'lucide-react';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import { TcmsLeer } from '../leer';

export function NichtImTcms({ basis }: { basis: string }) {
  return (
    <div className="card">
      <TcmsLeer
        icon={ShieldCheck}
        text="Dieser Mandant ist im Tax-CMS noch nicht angelegt. Das Anlegen ist im Cockpit möglich."
      >
        <Link className="btn-secondary" href={basis}>
          Zum Cockpit
        </Link>
      </TcmsLeer>
    </div>
  );
}

export function OhneProgramm({
  basis,
  bearbeiten,
  icon = ShieldCheck,
}: {
  basis: string;
  bearbeiten: boolean;
  icon?: LucideIcon;
}) {
  return (
    <div className="card">
      <TcmsLeer icon={icon} text="Für diesen Mandanten ist noch kein Tax-CMS eingerichtet.">
        {bearbeiten ? (
          <Link className="btn-primary" href={`${basis}/einrichtung`}>
            <ArrowRight className="h-4 w-4" aria-hidden="true" /> Tax-CMS einrichten
          </Link>
        ) : (
          <span className="text-sm text-muted">{TCMS_KEIN_RECHT.BEARBEITEN}</span>
        )}
      </TcmsLeer>
    </div>
  );
}
