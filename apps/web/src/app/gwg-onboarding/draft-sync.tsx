'use client';

// =============================================================================
// GWG-SELF-ONBOARDING-001: Zwischenstand im Wizard. Der Formularstand wird kurz
// nach jeder Änderung gespeichert und beim Öffnen des Links – auf jedem Gerät –
// wiederhergestellt. Datenschutz-Bestätigung und Einwilligungen werden nicht
// gespeichert: Ein wiederhergestellter Stand beginnt höchstens beim Schritt
// „Datenschutz“, damit nie ohne frische Erklärung übermittelt wird.
// =============================================================================

import { useEffect, useState } from 'react';
import { Loader, Smartphone, X } from 'lucide-react';
import type { LoadedInviteDraft } from '@/server/gwg-onboarding/service';
import type { LoadedOnboardingDraft, OnboardingDraftPayload } from '@/server/gwg-onboarding/draft';
import { saveOnboardingDraftAction } from './actions';
import {
  ONBOARDING_STEPS,
  emptyOwner,
  emptyRepresentative,
  reservePersonIds,
  type BeneficialOwner,
  type EntityEvidenceDocument,
  type OnboardingClientKind,
  type OnboardingIdentityFile,
  type Representative,
} from './wizard-steps';

const PRIVACY_STEP = ONBOARDING_STEPS.findIndex((entry) => entry.key === 'privacy');

export interface WizardMasterData {
  companyName: string;
  street: string;
  postalCode: string;
  city: string;
  countryIso: string;
}

/** Ausgangsstand: gespeicherter Zwischenstand vor dem Prüfentwurf der Kanzlei. */
export function initialWizardState(input: {
  savedDraft: LoadedOnboardingDraft | null | undefined;
  initialDraft: LoadedInviteDraft | null;
  client: {
    name: string;
    kind: OnboardingClientKind;
    street: string | null;
    postalCode: string | null;
    city: string | null;
    countryIso: string | null;
  };
  inviteName: string;
}) {
  const saved = input.savedDraft?.payload;
  if (saved) {
    reservePersonIds([...saved.owners, ...saved.representatives].map((person) => person.id));
    return {
      step: Math.min(saved.step, PRIVACY_STEP),
      reached: Math.min(saved.reached, PRIVACY_STEP),
      master: saved.master as WizardMasterData,
      owners: (saved.owners.length
        ? saved.owners
        : [emptyOwner(input.inviteName)]) as BeneficialOwner[],
      representatives: saved.representatives as Representative[],
      extraDocs: saved.extraDocuments as EntityEvidenceDocument[],
      noRegisterEntry: saved.noRegisterEntry,
    };
  }
  const { initialDraft, client, inviteName } = input;
  return {
    step: 0,
    reached: 0,
    master: {
      companyName: client.name,
      street: client.street ?? '',
      postalCode: client.postalCode ?? '',
      city: client.city ?? '',
      countryIso: client.countryIso ?? 'DE',
    },
    owners: initialDraft?.owners.length
      ? initialDraft.owners.map((owner) => ({ ...owner }) as BeneficialOwner)
      : [emptyOwner(inviteName)],
    representatives: initialDraft
      ? initialDraft.representatives.map(
          (representative) => ({ ...representative }) as Representative,
        )
      : client.kind === 'NATPERS'
        ? []
        : [emptyRepresentative(inviteName)],
    extraDocs: initialDraft?.extraDocuments.map((document) => ({ ...document })) ?? [],
    noRegisterEntry: initialDraft?.noRegisterEntry ?? null,
  };
}

/** Nur Angaben und Dateiverweise; lokale Dateien und Vorschaubilder bleiben im Browser. */
function draftFile(file: OnboardingIdentityFile | null) {
  if (!file) return null;
  return {
    documentId: file.documentId,
    fileName: file.fileName,
    ...(file.versionId && { versionId: file.versionId }),
    ...(file.viewport && { viewport: file.viewport }),
  };
}

export function buildDraftPayload(state: {
  step: number;
  reached: number;
  master: WizardMasterData;
  owners: BeneficialOwner[];
  representatives: Representative[];
  extraDocs: EntityEvidenceDocument[];
  noRegisterEntry: boolean | null;
}): OnboardingDraftPayload {
  return {
    version: 1,
    step: state.step,
    reached: state.reached,
    master: state.master,
    owners: state.owners.map((owner) => ({
      ...owner,
      idFront: draftFile(owner.idFront),
      idBack: draftFile(owner.idBack),
    })),
    representatives: state.representatives.map((representative) => ({
      ...representative,
      idFront: draftFile(representative.idFront),
      idBack: draftFile(representative.idBack),
    })),
    extraDocuments: state.extraDocs.map(({ documentId, fileName, type }) => ({
      documentId,
      fileName,
      type,
    })),
    noRegisterEntry: state.noRegisterEntry,
  };
}

export type DraftSyncStatus = 'restored' | 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

/**
 * Speichert den Stand 1,5 s nach der letzten Änderung (nach einem Fehler erst
 * nach 10 s). Hat ein anderes Gerät inzwischen gespeichert, wird nichts mehr
 * überschrieben, bis der Mandant neu lädt.
 */
export function useDraftSync(input: {
  token: string;
  savedDraft: LoadedOnboardingDraft | null | undefined;
  payload: OnboardingDraftPayload;
  active: boolean;
}) {
  const serialized = JSON.stringify(input.payload);
  const [base, setBase] = useState(() => ({
    revision: input.savedDraft?.revision ?? 0,
    serialized,
    savedAt: input.savedDraft?.updatedAt ?? null,
  }));
  const [status, setStatus] = useState<DraftSyncStatus>(input.savedDraft ? 'restored' : 'idle');
  const dirty = serialized !== base.serialized;
  const { token, active } = input;
  useEffect(() => {
    if (!active || !dirty || status === 'conflict' || status === 'saving') return;
    const timer = window.setTimeout(
      async () => {
        setStatus('saving');
        try {
          const result = await saveOnboardingDraftAction({
            token,
            revision: base.revision,
            payload: JSON.parse(serialized) as OnboardingDraftPayload,
          });
          if (result.ok) {
            setBase({ revision: result.revision, serialized, savedAt: result.updatedAt });
            setStatus('saved');
          } else setStatus('conflict' in result && result.conflict ? 'conflict' : 'error');
        } catch {
          setStatus('error');
        }
      },
      status === 'error' ? 10_000 : 1_500,
    );
    return () => window.clearTimeout(timer);
  }, [active, dirty, status, serialized, token, base.revision]);
  // Eine noch nicht gespeicherte Änderung nie als „gespeichert“ anzeigen.
  const shown = dirty && (status === 'restored' || status === 'saved' || status === 'idle');
  return {
    status: shown ? 'saving' : status,
    savedAt: base.savedAt,
    unsaved: dirty || status === 'conflict',
  };
}

function clock(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Kurze Rückmeldung zum Zwischenstand; bei einem Konflikt mit Neu-Laden. */
export function DraftStatus({
  status,
  savedAt,
}: {
  status: DraftSyncStatus;
  savedAt: string | null;
}) {
  if (status === 'conflict') {
    return (
      <div
        role="alert"
        className="w-full rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
      >
        Ihre Angaben wurden inzwischen auf einem anderen Gerät geändert. Bitte laden Sie die Seite
        neu, um den aktuellen Stand zu sehen; Eingaben, die hier noch nicht gespeichert waren, gehen
        dabei verloren.{' '}
        <button
          type="button"
          className="font-medium underline"
          onClick={() => window.location.reload()}
        >
          Neu laden
        </button>
      </div>
    );
  }
  const text = {
    restored: 'Ihr gespeicherter Zwischenstand wurde geladen',
    idle: 'Ihre Angaben werden automatisch zwischengespeichert.',
    saving: 'Wird gespeichert …',
    saved: 'Zwischenstand gespeichert',
    error: 'Zwischenstand konnte gerade nicht gespeichert werden – wir versuchen es gleich erneut.',
  }[status];
  return (
    <p role="status" className="text-xs text-muted">
      {text}
      {(status === 'restored' || status === 'saved') && savedAt && (
        // Uhrzeit in der Zeitzone des Geräts; Server und Browser dürfen abweichen.
        <span suppressHydrationWarning> · {clock(savedAt)}</span>
      )}
    </p>
  );
}

/**
 * Am Rechner einen QR-Code mit dem Link dieser Einladung zeigen, um auf dem
 * Smartphone weiterzumachen (z. B. für die Ausweisfotos). Der Code enthält den
 * persönlichen Link; er wird erst auf Wunsch erzeugt.
 */
export function ContinueOnPhone() {
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  async function show() {
    setOpen(true);
    const QRCode = (await import('qrcode')).default;
    setQr(
      await QRCode.toDataURL(window.location.href, {
        margin: 1,
        width: 220,
        errorCorrectionLevel: 'M',
      }),
    );
  }
  if (!open)
    return (
      <button
        type="button"
        className="btn-secondary text-sm max-sm:hidden pointer-coarse:hidden"
        onClick={() => void show()}
      >
        <Smartphone className="h-4 w-4" /> Auf dem Smartphone fortsetzen
      </button>
    );
  return (
    <div className="card w-full space-y-3 p-4 max-sm:hidden pointer-coarse:hidden">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold text-primary">Auf dem Smartphone fortsetzen</h2>
        <button
          type="button"
          className="text-muted hover:text-primary"
          aria-label="QR-Code schließen"
          onClick={() => {
            setOpen(false);
            setQr(null);
          }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        {qr ? (
          // Lokal erzeugtes Bild (data:-URL); kein Bildoptimierer.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qr}
            alt="QR-Code mit dem Link zu Ihrer Einladung"
            width={220}
            height={220}
            className="rounded border border-default bg-white"
          />
        ) : (
          <Loader className="h-6 w-6 animate-spin text-muted" aria-label="QR-Code wird erzeugt" />
        )}
        <div className="min-w-0 flex-1 space-y-2 text-sm text-secondary">
          <p>
            Scannen Sie den Code mit der Kamera Ihres Smartphones. Dort sehen Sie Ihren
            gespeicherten Stand und können die Ausweisfotos direkt aufnehmen.
          </p>
          <p className="text-xs text-muted">
            Der Code enthält Ihren persönlichen Einladungslink – bitte nur selbst scannen und nicht
            weitergeben.
          </p>
        </div>
      </div>
    </div>
  );
}
