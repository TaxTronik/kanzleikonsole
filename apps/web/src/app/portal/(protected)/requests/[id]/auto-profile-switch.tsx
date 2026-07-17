'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { Building2, Loader2, TriangleAlert } from 'lucide-react';
import { switchPortalProfileAction } from '../../profile-actions';

/**
 * Automatischer Profilwechsel für Deeplinks (z. B. Anforderungs-Mail), die zu
 * einem anderen Mandantenprofil derselben Person gehören. Rendert als
 * Vollbild-Overlay (auch mobil gut lesbar), zeigt den Warnhinweis kurz an und
 * submittet dann das Switch-Formular — die Action validiert das Ziel
 * fail-closed (resolvePortalProfileSwitchTx) und leitet per returnTo direkt
 * auf die Anforderung.
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
    const timer = setTimeout(() => formRef.current?.requestSubmit(), 1_500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="profile-switch-title"
    >
      <div className="card w-full max-w-md p-6 shadow-xl">
        <p
          id="profile-switch-title"
          className="flex items-start gap-2 text-sm font-semibold text-primary"
        >
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          Achtung — das Profil wird gewechselt, um die Anforderung aufzurufen.
        </p>
        <p className="mt-2 text-sm text-secondary">
          Die Anforderung gehört zum Mandantenprofil „{clientName}“. Sie werden automatisch als{' '}
          {contactName} angemeldet …
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <form ref={formRef} action={switchPortalProfileAction}>
            <input type="hidden" name="contactId" value={contactId} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <button type="submit" className="btn-primary text-sm">
              <Building2 className="h-4 w-4" />
              Jetzt zu „{clientName}“ wechseln
            </button>
          </form>
          <Link href="/portal/dashboard" className="text-xs text-muted hover:underline">
            Abbrechen — zum Dashboard
          </Link>
        </div>
        <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Wechsel wird vorbereitet …
        </p>
      </div>
    </div>
  );
}
