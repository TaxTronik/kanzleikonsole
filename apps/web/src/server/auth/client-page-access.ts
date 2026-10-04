// =============================================================================
// Seiten-Guard für ALLE Mandanten-Detailseiten unter /staff/clients/[id]/**.
//
// Setzt die zentrale `canAccessClient`-Policy (OPEN-Default + Vertraulich-
// Ventil, RESTRICTED-Modus) in jeder Seite selbst durch, nicht nur im
// Segment-Layout: Layouts rendern bei Navigation zwischen Unterseiten nicht
// erneut, und ein gezielt gebauter RSC-Request kann das Layout überspringen.
// RLS trennt nur nach Tenant, nicht nach Vertraulichkeit.
//
// `cache()` dedupliziert pro Request und Mandant: Layout und Seite rufen den
// Guard beide, geprüft wird nur einmal. Bei Verweigerung Redirect auf die
// Mandanten-Liste mit ?denied=1 (dort Hinweis-Banner), wie bisher im Layout.
// Liefert die Session, damit die Seite sie weiterverwenden kann.
// =============================================================================

import { cache } from 'react';
import { redirect } from 'next/navigation';
import { canAccessClient } from './rbac';
import { requireStaffPage } from './staff-page';
import type { StaffSession } from './staff';

export const requireClientPageAccess = cache(async (clientId: string): Promise<StaffSession> => {
  const session = await requireStaffPage();
  if (!(await canAccessClient(session, clientId))) redirect('/staff/clients?denied=1');
  return session;
});
