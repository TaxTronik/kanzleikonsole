import type { ReactNode } from 'react';
// =============================================================================
// Zentraler Zugriffs-Guard für ALLE Mandanten-Detailseiten unter
// /staff/clients/[id]/** (Cockpit, Edit, GwG, BWA, Bescheide, Workflows, …).
//
// Setzt die zentrale `canAccessClient`-Policy (OPEN-Default + Vertraulich-
// Ventil, RESTRICTED-Modus) auf Page-Ebene durch — die API-Routen sind
// separat abgesichert. Bei Verweigerung Redirect auf die Mandanten-Liste
// mit ?denied=1 (dort Hinweis-Banner).
//
// Lädt bewusst NICHTS außer dem Check. Das Layout rendert neu, sobald sich
// `[id]` ändert; Navigation zwischen Unterseiten DESSELBEN Mandanten läuft
// ohne erneuten Check — der Zugriff ist pro Mandant konstant, das ist ok.
// Der Subsumtions-Guard (`subsumtion/_guard.ts`) bleibt zusätzlich bestehen
// (prüft auch das risk-Modul); die Zugriffs-Prüfung dort ist damit redundant,
// aber harmlos.
// =============================================================================

import { redirect } from 'next/navigation';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClient } from '@/server/auth/rbac';

export default async function ClientDetailLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { id } = await params;
  if (!(await canAccessClient(session, id))) redirect('/staff/clients?denied=1');

  return children;
}
