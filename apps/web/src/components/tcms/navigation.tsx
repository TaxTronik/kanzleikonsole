'use client';

// =============================================================================
// Unternavigation des Tax-CMS-Bereichs eines Mandanten (TCMS Stufe 3, aus der
// Demo components/tcms/tabs.tsx). Steht im Layout
// /staff/clients/[id]/tcms/layout.tsx; der aktive Eintrag folgt dem Pfad auf
// dem Client (Layouts rendern bei Navigation zwischen Unterseiten nicht neu).
// Ohne Status-Punkte: die bräuchten in jedem Layout einen TCMS-Aufruf.
// =============================================================================

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { aktiverTcmsBereich, tcmsBereichHref, TCMS_MANDANT_BEREICHE } from './bereiche';

export function TcmsMandantNavigation({ basis }: { basis: string }) {
  const pfad = usePathname() ?? '';
  const stand = useSearchParams()?.get('stand') ?? null;
  const aktiv = aktiverTcmsBereich(basis, pfad);
  return (
    <nav aria-label="Bereiche des Tax-CMS" className="mb-6 overflow-x-auto">
      <ul className="flex gap-2 pb-1 min-w-max">
        {TCMS_MANDANT_BEREICHE.map((bereich) => {
          const istAktiv = aktiv?.pfad === bereich.pfad;
          return (
            <li key={bereich.pfad}>
              <Link
                href={tcmsBereichHref(basis, bereich.pfad, stand)}
                className={`${istAktiv ? 'btn-primary' : 'btn-secondary'} text-xs py-1`}
                aria-current={istAktiv ? 'page' : undefined}
              >
                {bereich.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
