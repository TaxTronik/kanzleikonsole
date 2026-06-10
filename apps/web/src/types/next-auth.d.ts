// =============================================================================
// next-auth Module-Augmentation — gemeinsame Definition für beide Surfaces
//
// Wir haben zwei Auth-Surfaces (staff + portal) im selben Prozess. Wenn jede
// Datei ihr eigenes `declare module 'next-auth'` mitbringt, mergen die
// Interfaces zu einem unmöglichen Shape (alle Felder beider Surfaces als
// required). Stattdessen: alle Felder optional auf Session.user — die echte
// Narrowing passiert in den Wrapper-Typen `StaffSession` und `PortalSession`,
// die `staffAuth()` bzw. `portalAuth()` zurückgeben.
// =============================================================================

import 'next-auth';
import 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user: {
      // Gemeinsame Basis
      id: string;
      email: string;
      name: string;
      fullName: string;
      tenantId: string;
      // Staff-Surface
      staffId?: string;
      roles?: string[];
      permissions?: string[];
      // Portal-Surface
      contactId?: string;
      clientId?: string;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    tenantId?: string;
    fullName?: string;
    staffId?: string;
    roles?: string[];
    permissions?: string[];
    contactId?: string;
    clientId?: string;
  }
}
