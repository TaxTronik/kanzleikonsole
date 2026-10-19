// =============================================================================
// GET /api/staff/clients/:id/tcms/nachweise/:nachweisId — Datei eines
// Nachweises einer Kontrolldurchführung (TCMS Stufe 3, Bereich C;
// TCMS-NACHWEIS-001). Einstieg tcmsMandantRoute (Leitfaden
// docs/development/tcms-oberflaechen.md, Abschnitt 11); die Bytes liefert die
// Dokumentauslieferung der kanzleikonsole nach SHA-256-Abgleich mit dem
// Verweis des Tax-CMS.
// =============================================================================

import type { NextRequest } from 'next/server';
import { nachweisAusliefern } from '@/server/tcms/durchfuehrung/nachweis-download';
import { tcmsMandantRoute } from '@/server/tcms/route';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; nachweisId: string }> },
) {
  const { id, nachweisId } = await params;
  const route = await tcmsMandantRoute(id);
  if (!route.ok) return route.antwort;
  return nachweisAusliefern(req, route, nachweisId);
}
