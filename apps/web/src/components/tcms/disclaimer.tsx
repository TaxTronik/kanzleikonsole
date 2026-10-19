// =============================================================================
// Pflicht-Framing des Tax-CMS (TCMS Stufe 3, aus der Demo
// components/ui/disclaimer.tsx): Das Werkzeug strukturiert und belegt; über
// Angemessenheit und Wirksamkeit urteilt es nicht (Fachkatalog
// TCMS-DIENST-001, Ausschluss TCMS-EFFECTIVENESS-001). Text aus der Domain.
// =============================================================================

import { ShieldAlert } from 'lucide-react';
import { HINWEIS_PFLICHTFRAMING } from '@taxtronik/tcms-domain';

export function TcmsPflichthinweis() {
  const [kopf, ...rest] = HINWEIS_PFLICHTFRAMING.split('. ');
  return (
    <div className="alert-warning flex items-start gap-3" role="note">
      <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5" aria-hidden="true" />
      <p>
        <strong>{kopf}.</strong> {rest.join('. ')}
      </p>
    </div>
  );
}
