import type { ReactNode } from 'react';
// =============================================================================
// Zentraler Zugriffs-Guard für ALLE Mandanten-Detailseiten unter
// /staff/clients/[id]/** (Cockpit, Edit, GwG, BWA, Bescheide, Workflows, …).
//
// Setzt die zentrale `canAccessClient`-Policy (OPEN-Default + Vertraulich-
// Ventil, RESTRICTED-Modus) über `requireClientPageAccess` durch — die
// API-Routen sind separat abgesichert. Bei Verweigerung Redirect auf die
// Mandanten-Liste mit ?denied=1 (dort Hinweis-Banner).
//
// Lädt bewusst NICHTS außer dem Check. Das Layout ist aber NICHT der einzige
// Check: Layouts rendern bei Navigation zwischen Unterseiten nicht erneut, und
// ein gezielt gebauter RSC-Request kann das Layout überspringen. Deshalb ruft
// jede page.tsx darunter denselben Guard selbst (Guard-Test:
// src/__tests__/client-page-authz.test.ts); `cache()` sorgt dafür, dass pro
// Request trotzdem nur einmal geprüft wird. Der Subsumtions-Guard
// (`subsumtion/_guard.ts`) ruft ihn ebenfalls und prüft zusätzlich das
// risk-Modul.
// =============================================================================

import { requireClientPageAccess } from '@/server/auth/client-page-access';

export default async function ClientDetailLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireClientPageAccess(id);

  return children;
}
