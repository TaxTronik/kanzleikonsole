// =============================================================================
// GET /portal/tcms/aufgaben/:id/anlagen/:nachweisId — Anlage einer
// Kontrollaufgabe im Portal (TCMS Stufe 3, Bereich D).
//
//   1. Einstieg als erster Aufruf (Sitzung, Modul, Dienst, Akteur; Mandant nur
//      aus der Sitzung) – ÜBERGANG über server/tcms/abruf/einstieg.ts mit der
//      Schnittstelle von server/tcms/route.ts (Bereich C); beim
//      Zusammenführen nach app/api/portal/tcms/aufgaben/[id]/anlagen/
//      [nachweisId]/route.ts verschieben und den Import umstellen. Danach das
//      Lese-Limit des Portals.
//   2. `portalAnlageLesen`: Sichtbarkeit prüft das Tax-CMS (404 ohne
//      Existenzhinweis); der Verweis muss zu genau dieser Aufgabe gehören.
//   3. Auslieferung über die Dokumentauslieferung der kanzleikonsole mit den
//      Portalregeln (DOC-PORTAL-SHARING-001: Sitzungsmandant, freigegeben,
//      nicht gelöscht, sauber) und Abgleich von SHA-256 und Größe; sonst
//      zurück zur Aufgabe mit festem Hinweis.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { DurchfuehrungIdSchema, ENDPUNKTE, NachweisIdSchema } from '@taxtronik/tcms-contract';
import { relativeRedirect } from '@/server/http/relative-redirect';
import { checkPortalReadLimit } from '@/server/rate-limit';
import { tcmsVerweisAusliefern } from '@/server/tcms/abruf/auslieferung';
import {
  TCMS_ROUTE_KOPF,
  tcmsPortalRoute,
  tcmsRouteAntwort,
  tcmsRouteLesen,
} from '@/server/tcms/abruf/einstieg';

const Anfrage = z.object({ durchfuehrungId: DurchfuehrungIdSchema, nachweisId: NachweisIdSchema });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; nachweisId: string }> },
): Promise<Response> {
  const roh = await params;
  const route = await tcmsPortalRoute();
  if (!route.ok) return route.antwort;

  const limit = await checkPortalReadLimit(route.session.user.contactId);
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Zu viele Abrufe. Bitte später erneut versuchen.' },
      { status: 429, headers: { ...TCMS_ROUTE_KOPF, 'Retry-After': String(limit.retryAfter) } },
    );
  }
  const anfrage = Anfrage.safeParse({ durchfuehrungId: roh.id, nachweisId: roh.nachweisId });
  if (!anfrage.success) return tcmsRouteAntwort('NICHT_GEFUNDEN');

  const gelesen = await tcmsRouteLesen(route, ENDPUNKTE.portalAnlageLesen, {
    params: { nachweisId: anfrage.data.nachweisId },
  });
  if (!gelesen.ok) return gelesen.antwort;
  if (gelesen.daten.durchfuehrungId !== anfrage.data.durchfuehrungId) {
    return tcmsRouteAntwort('NICHT_GEFUNDEN');
  }

  const ergebnis = await tcmsVerweisAusliefern(
    request,
    { flaeche: 'PORTAL', session: route.session, mandantId: route.mandantId },
    gelesen.daten.nachweis,
  );
  if (ergebnis.art === 'AUSGELIEFERT') return ergebnis.antwort;
  const hinweis = ergebnis.art === 'ABWEICHUNG' ? 'abweichend' : 'nicht-verfuegbar';
  return relativeRedirect(
    `/portal/tcms/aufgaben/${encodeURIComponent(anfrage.data.durchfuehrungId)}?anlage=${hinweis}`,
  );
}
