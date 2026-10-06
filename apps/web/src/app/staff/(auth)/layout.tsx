import type { ReactNode } from 'react';
// =============================================================================
// Staff-Auth-Layout — Login mit Kanzlei-Branding und Pflicht-Footer über den
// gemeinsamen AuthShell (R-14: Portal und Staff teilen denselben Rahmen).
// =============================================================================

import { AuthShell } from '@/components/auth-shell';

export default function StaffAuthLayout({ children }: { children: ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
