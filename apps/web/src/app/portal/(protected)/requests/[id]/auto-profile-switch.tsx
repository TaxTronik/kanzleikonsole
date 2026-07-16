'use client';

import { useEffect, useRef } from 'react';
import { Building2, TriangleAlert } from 'lucide-react';
import { switchPortalProfileAction } from '../../profile-actions';

/**
 * Automatischer Profilwechsel für Deeplinks (z. B. Anforderungs-Mail), die zu
 * einem anderen Mandantenprofil derselben Person gehören. Zeigt den
 * Warnhinweis kurz an und submittet dann das Switch-Formular — die Action
 * validiert das Ziel fail-closed (resolvePortalProfileSwitchTx) und leitet
 * per returnTo direkt auf die Anforderung.
 */
export function AutoProfileSwitch({
  contactId,
  clientName,
  contactName,
  returnTo,
}: {
  contactId: string;
  clientName: string;
  contactName: string;
  returnTo: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    // Kurze Verzögerung, damit der Hinweis lesbar ist, bevor gewechselt wird.
    const timer = setTimeout(() => formRef.current?.requestSubmit(), 1_200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
      <p className="flex items-start gap-2 font-medium">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        Achtung — das Profil wird gewechselt, um die Anforderung aufzurufen.
      </p>
      <p className="mt-1 text-xs opacity-90">
        Die Anforderung gehört zum Mandantenprofil „{clientName}“. Sie werden automatisch als{' '}
        {contactName} angemeldet …
      </p>
      <form ref={formRef} action={switchPortalProfileAction} className="mt-3">
        <input type="hidden" name="contactId" value={contactId} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <button type="submit" className="btn-primary text-xs">
          <Building2 className="h-3.5 w-3.5" />
          Jetzt zu „{clientName}“ wechseln
        </button>
      </form>
    </div>
  );
}
