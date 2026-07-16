'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { fmtDateTimeShort } from '@/lib/fmt';
import {
  submitCheckForReviewAction,
  verifyCheckAction,
  rejectCheckAction,
  type ActionResult,
} from './actions';
import { useGwgEditState } from './edit-state-context';

/**
 * GwG-Decision-Buttons (Verifizieren / Ablehnen) mit useActionState. Zeigt
 * Server-Fehler inline an, statt die Page in einen Runtime-Error zu kippen
 * (z. B. wenn der eingeloggte ADMIN nicht Berufsträger für diesen Mandanten
 * ist — das soll als sichtbare Meldung erscheinen, nicht als 500).
 */
export function GwgDecisionForms({
  checkId,
  clientId,
  status,
  reviewSubmittedAt,
  canVerify,
  reviewSnapshotHash,
}: {
  checkId: string;
  clientId: string;
  status: 'DRAFT' | 'IN_REVIEW';
  reviewSubmittedAt: string | null;
  canVerify: boolean;
  reviewSnapshotHash: string | null;
}) {
  const router = useRouter();
  const { status: liveStatus, markInReview, markVerified, markRejected } = useGwgEditState(status);
  const [submitState, submitAction, submitPending] = useActionState<ActionResult | null, FormData>(
    submitCheckForReviewAction,
    null,
  );
  const [verifyState, verifyAction, verifyPending] = useActionState<ActionResult | null, FormData>(
    verifyCheckAction,
    null,
  );
  const [rejectState, rejectAction, rejectPending] = useActionState<ActionResult | null, FormData>(
    rejectCheckAction,
    null,
  );

  // useActionState liefert den Erfolg vor bzw. unabhaengig vom RSC-Refresh.
  // Dadurch wechselt Badge und Entscheidungsbereich sofort auf IN_REVIEW. Die
  // servergebundene Freigabe bleibt gesperrt, bis Hash und Props nachgezogen sind.
  useEffect(() => {
    if (submitState?.ok) markInReview();
  }, [markInReview, submitState]);

  // Verify/Reject: sofortiger optimistischer Flip + expliziter router.refresh()
  // AUSSERHALB der Form-Transition. Ohne beides hing die UI komplett am
  // RSC-Payload der Action — blieb dessen Anwendung stecken (bekanntes
  // Next-Verhalten bei revalidatePath in Server Actions), sah der Nutzer trotz
  // erfolgreicher Verifikation minutenlang keine Änderung.
  useEffect(() => {
    if (!verifyState?.ok) return;
    markVerified();
    router.refresh();
  }, [markVerified, router, verifyState]);
  useEffect(() => {
    if (!rejectState?.ok) return;
    markRejected();
    router.refresh();
  }, [markRejected, rejectState, router]);

  const error = submitState?.error ?? verifyState?.error ?? rejectState?.error ?? null;

  if (liveStatus === 'VERIFIED' || liveStatus === 'REJECTED') {
    return (
      <div
        className={
          liveStatus === 'VERIFIED'
            ? 'rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100'
            : 'rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-100'
        }
        role="status"
      >
        {liveStatus === 'VERIFIED'
          ? 'GwG-Prüfung verifiziert — der Mandant wurde aktiviert. Die Ansicht wird aktualisiert…'
          : 'GwG-Prüfung abgelehnt. Die Ansicht wird aktualisiert…'}
      </div>
    );
  }

  if (liveStatus === 'DRAFT') {
    return (
      <>
        <p className="text-sm text-muted mb-3">
          Speichern Sie zunächst alle Angaben und Nachweise. Mit der Übergabe wird der aktuelle
          Stand geprüft, protokolliert und dem zugeordneten Berufsträger vorgelegt.
        </p>
        <form action={submitAction}>
          <input type="hidden" name="checkId" value={checkId} />
          <input type="hidden" name="clientId" value={clientId} />
          <button type="submit" className="btn-primary" disabled={submitPending}>
            <ShieldCheck className="h-4 w-4" />
            {submitPending ? 'Prüft Vollständigkeit…' : 'Zur Freigabe einreichen'}
          </button>
        </form>
        {error && <p className="alert-error-sm mt-3">{error}</p>}
      </>
    );
  }

  return (
    <>
      <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
        Zur Freigabe eingereicht
        {reviewSubmittedAt ? ` am ${fmtDateTimeShort(new Date(reviewSubmittedAt))}` : ''}.
      </div>
      {!canVerify && (
        <p className="text-sm text-muted">
          Der zugeordnete Berufsträger erhält die Entscheidung. Sie können die vorbereiteten Daten
          bis dahin weiter einsehen; Änderungen nehmen die Übergabe wieder zurück.
        </p>
      )}
      {canVerify &&
        (status === 'IN_REVIEW' && reviewSnapshotHash ? (
          /* Bestätigungstext oben in voller Breite; darunter EINE Zeile mit
             Verifizieren-Button, Ablehnungsgrund und Ablehnen-Button auf
             gleicher Höhe. Die Checkbox gehört per form-Attribut weiterhin zum
             Verify-Formular (inkl. required-Validierung). */
          <div className="max-w-3xl space-y-3">
            <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
              <input
                type="checkbox"
                name="professionalAttestation"
                value="confirmed"
                required
                form="gwg-verify-form"
                className="mt-1"
              />
              <span>
                Ich habe den vollständigen GwG-Prüfsnapshot einschließlich Risikoanalyse,
                wirtschaftlich Berechtigten, gesetzlicher Vertretung, eindeutiger Ausweiszuordnung
                und sämtlicher Nachweise persönlich geprüft und verantworte die Freigabe.
                <span className="mt-1 block text-xs opacity-80">
                  Die Bestätigung wird zusammen mit dem exakten Datenstand revisionssicher
                  protokolliert.
                </span>
              </span>
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <form id="gwg-verify-form" action={verifyAction} className="shrink-0">
                <input type="hidden" name="checkId" value={checkId} />
                <input type="hidden" name="clientId" value={clientId} />
                <input type="hidden" name="reviewSnapshotHash" value={reviewSnapshotHash ?? ''} />
                <button type="submit" className="btn-primary" disabled={verifyPending}>
                  <ShieldCheck className="h-4 w-4" />
                  {verifyPending ? 'Verifiziere…' : 'Verifizieren und Mandant aktivieren'}
                </button>
              </form>
              <form action={rejectAction} className="flex min-w-64 flex-1 items-center gap-2">
                <input type="hidden" name="checkId" value={checkId} />
                <input type="hidden" name="clientId" value={clientId} />
                <input
                  name="reason"
                  type="text"
                  className="input flex-1"
                  placeholder="Ablehnungsgrund (Pflicht)"
                  required
                  minLength={1}
                  maxLength={2000}
                />
                <button
                  type="submit"
                  className="btn-secondary text-red-700 border-red-300 hover:bg-red-50"
                  disabled={rejectPending}
                >
                  {rejectPending ? 'Lehne ab…' : 'Ablehnen'}
                </button>
              </form>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted" aria-live="polite">
            Die gebundene Prüfansicht wird aktualisiert…
          </p>
        ))}
      {error && <p className="alert-error-sm mt-3">{error}</p>}
    </>
  );
}
