'use client';

import { useRef, useState } from 'react';
import { Building2, Check, ChevronDown } from 'lucide-react';
import type { PortalProfileOption } from '@/server/auth/portal-profiles';
import { switchPortalProfileAction } from './profile-actions';

interface PortalProfileSwitcherProps {
  currentContactId: string;
  profiles: PortalProfileOption[];
}

export function PortalProfileSwitcher({ currentContactId, profiles }: PortalProfileSwitcherProps) {
  const switchingRef = useRef(false);
  const [switching, setSwitching] = useState(false);

  if (profiles.length < 2) return null;

  return (
    <details className="group relative mt-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-secondary transition-colors hover:bg-gray-100 dark:hover:bg-gray-800">
        <Building2 className="h-3.5 w-3.5" />
        Profil wechseln
        <span
          className="inline-flex min-w-5 items-center justify-center rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-bold text-on-brand"
          aria-label={`${profiles.length} verfügbare Mandantenprofile`}
        >
          {profiles.length}
        </span>
        <ChevronDown className="ml-auto h-3.5 w-3.5 transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute left-0 z-40 mt-1 w-64 overflow-hidden rounded-lg border border-default bg-white shadow-lg dark:bg-gray-900">
        <p className="border-b border-default px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Mandantenprofil öffnen
        </p>
        <div className="max-h-72 overflow-y-auto p-1" aria-busy={switching}>
          {profiles.map((profile) => {
            const current = profile.contactId === currentContactId;
            return (
              <form
                key={profile.contactId}
                action={switchPortalProfileAction}
                onSubmit={(event) => {
                  if (switchingRef.current) {
                    event.preventDefault();
                    return;
                  }
                  switchingRef.current = true;
                  setSwitching(true);
                }}
              >
                <input type="hidden" name="contactId" value={profile.contactId} />
                <button
                  type="submit"
                  disabled={current || switching}
                  aria-current={current ? 'page' : undefined}
                  className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                    current
                      ? 'cursor-default bg-surface-raised ring-1 ring-inset ring-brand-500/40'
                      : // hover:bg-gray-100 ist via @theme auf surface-raised gemappt —
                        // hover:bg-surface-raised wäre wirkungslos, weil die Klasse eine
                        // handgeschriebene Utility ohne generierte hover:-Variante ist.
                        'cursor-pointer hover:bg-gray-100'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-primary">
                      {profile.clientName}
                    </span>
                    <span className="block truncate text-xs text-muted">{profile.contactName}</span>
                  </span>
                  {current && <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />}
                </button>
              </form>
            );
          })}
        </div>
      </div>
    </details>
  );
}
