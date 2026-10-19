// =============================================================================
// GET /staff/clients/:id/tcms/ereignisse/anlage?e=<ereignisId>&h=<sha256> —
// Anlage einer Portal-Meldung für die Kanzlei (TCMS Stufe 3, Bereich D; aus
// der Demo …/ereignisse/anlage/route.ts, dort nur Demo-Ablage).
//
//   1. Einstieg als erster Aufruf (Sitzung, Mandantenzugriff, Modul, Dienst,
//      Akteur) – ÜBERGANG über server/tcms/abruf/einstieg.ts mit der
//      Schnittstelle von server/tcms/route.ts (Bereich C); beim Zusammenführen
//      nach app/api/staff/clients/[id]/tcms/ereignisse/anlage/route.ts
//      verschieben und den Import umstellen.
//   2. `ereignisAnlageLesen`: Das Tax-CMS prüft Rechte und Mandantenbezug und
//      liefert den Verweis aus dem Meldungs-Audit (404 ohne Existenzhinweis).
//   3. Auslieferung über die Dokumentauslieferung der kanzleikonsole mit
//      Abgleich von SHA-256 und Größe (server/tcms/abruf/auslieferung.ts).
//      Abweichung oder nicht verfügbar → zurück zur Triage mit festem
//      Hinweis, keine Bytes.
// =============================================================================

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ENDPUNKTE, ObjektIdSchema, Sha256Schema } from '@taxtronik/tcms-contract';
import { relativeRedirect } from '@/server/http/relative-redirect';
import { tcmsVerweisAusliefern } from '@/server/tcms/abruf/auslieferung';
import { tcmsMandantRoute, tcmsRouteAntwort, tcmsRouteLesen } from '@/server/tcms/abruf/einstieg';

const Anfrage = z.object({ ereignisId: ObjektIdSchema, sha256: Sha256Schema });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const route = await tcmsMandantRoute(id);
  if (!route.ok) return route.antwort;

  const anfrage = Anfrage.safeParse({
    ereignisId: request.nextUrl.searchParams.get('e'),
    sha256: request.nextUrl.searchParams.get('h'),
  });
  if (!anfrage.success) return tcmsRouteAntwort('NICHT_GEFUNDEN');
  const verweis = await tcmsRouteLesen(route, ENDPUNKTE.ereignisAnlageLesen, {
    params: anfrage.data,
  });
  if (!verweis.ok) return verweis.antwort;
  if (verweis.daten.sha256 !== anfrage.data.sha256) return tcmsRouteAntwort('NICHT_GEFUNDEN');

  const ergebnis = await tcmsVerweisAusliefern(
    request,
    { flaeche: 'KANZLEI', session: route.session, mandantId: route.mandantId },
    verweis.daten,
  );
  if (ergebnis.art === 'AUSGELIEFERT') return ergebnis.antwort;
  const hinweis = ergebnis.art === 'ABWEICHUNG' ? 'abweichend' : 'nicht-verfuegbar';
  return relativeRedirect(
    `/staff/clients/${encodeURIComponent(route.mandantId)}/tcms/ereignisse?e=${encodeURIComponent(anfrage.data.ereignisId)}&anlage=${hinweis}`,
  );
}
