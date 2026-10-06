import type { ReactNode } from 'react';
// =============================================================================
// Portal-Auth-Layout — Mandanten-Login mit Kanzlei-Branding und Pflicht-Footer über den
// gemeinsamen AuthShell (R-14: Portal und Staff teilen denselben Rahmen).
// =============================================================================

import { AuthShell } from '@/components/auth-shell';

export default function PortalAuthLayout({ children }: { children: ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
