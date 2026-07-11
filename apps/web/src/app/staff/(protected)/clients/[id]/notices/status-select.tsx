'use client';

import { useState, useTransition } from 'react';
import { updateNoticeStatusAction } from './actions';

type DecisionInstruction = 'VALID' | 'MISSING_OR_INVALID';

type NoticeEvidence = {
  appealFiledAt: string | null;
  appealFiledComplete: boolean;
  appealResolvedAt: string | null;
  decisionReceivedAt: string | null;
  decisionComplete: boolean;
  decisionInstruction: DecisionInstruction;
  klageFiledAt: string | null;
  klageFiledComplete: boolean;
};

const STATUS_LABELS: Record<string, string> = {
  NEU: 'Neu',
  GEPRUEFT: 'Geprüft',
  EINSPRUCH: 'Einspruch eingelegt',
  ABGEHOLFEN: 'Abgeholfen',
  TEILABHILFE: 'Teilabhilfe',
  ZURUECKGEWIESEN: 'Zurückgewiesen',
  KLAGE: 'Klage erhoben',
  RECHTSKRAEFTIG: 'Rechtskräftig',
};

/**
 * Quick-Action im Bescheid-Postfach: Status-Transition über ein kompaktes
 * Select (nur die jeweils erlaubten Folge-Status). Ab GEPRUEFT erscheint der
 * Bescheid im Mandantenportal.
 */
export function NoticeStatusSelect({
  noticeId,
  currentStatus,
  allowed,
  evidence,
}: {
  noticeId: string;
  currentStatus: string;
  allowed: string[];
  evidence: NoticeEvidence;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [decisionInstruction, setDecisionInstruction] = useState<DecisionInstruction>(
    evidence.decisionInstruction,
  );
  const [legacyAppealFiledDate, setLegacyAppealFiledDate] = useState(evidence.appealFiledAt ?? '');
  const [legacyAppealResolvedDate, setLegacyAppealResolvedDate] = useState(
    evidence.appealResolvedAt ?? '',
  );
  const [legacyDecisionReceivedDate, setLegacyDecisionReceivedDate] = useState(
    evidence.decisionReceivedAt ?? '',
  );
  const [legacyKlageFiledDate, setLegacyKlageFiledDate] = useState(evidence.klageFiledAt ?? '');

  const eventDateLabel: Record<string, string> = {
    EINSPRUCH: 'Einspruch eingelegt am',
    ABGEHOLFEN: 'Abhilfe bekanntgegeben am',
    TEILABHILFE: 'Einspruchsentscheidung bekanntgegeben am',
    ZURUECKGEWIESEN: 'Einspruchsentscheidung bekanntgegeben am',
    KLAGE: 'Klage eingereicht am',
    RECHTSKRAEFTIG: 'Rechtskraft eingetreten am',
  };

  const isAppealChain = [
    'EINSPRUCH',
    'ABGEHOLFEN',
    'TEILABHILFE',
    'ZURUECKGEWIESEN',
    'KLAGE',
  ].includes(currentStatus);
  const needsLegacyAppealFiled = isAppealChain && !evidence.appealFiledComplete;
  const needsLegacyAbhilfe =
    currentStatus === 'ABGEHOLFEN' &&
    selectedStatus === 'RECHTSKRAEFTIG' &&
    !evidence.appealResolvedAt;
  const needsLegacyDecision =
    ['TEILABHILFE', 'ZURUECKGEWIESEN', 'KLAGE'].includes(currentStatus) &&
    !evidence.decisionComplete;
  const needsLegacyKlage =
    currentStatus === 'KLAGE' &&
    selectedStatus === 'RECHTSKRAEFTIG' &&
    !evidence.klageFiledComplete;
  const needsAnyLegacyEvidence =
    needsLegacyAppealFiled || needsLegacyAbhilfe || needsLegacyDecision || needsLegacyKlage;
  const missingRequiredLegacyDate =
    (needsLegacyAppealFiled && !legacyAppealFiledDate) ||
    (needsLegacyAbhilfe && !legacyAppealResolvedDate) ||
    (needsLegacyDecision && !legacyDecisionReceivedDate) ||
    (needsLegacyKlage && !legacyKlageFiledDate);

  function resetForm() {
    setSelectedStatus('');
    setEventDate('');
    setDecisionInstruction(evidence.decisionInstruction);
    setLegacyAppealFiledDate(evidence.appealFiledAt ?? '');
    setLegacyAppealResolvedDate(evidence.appealResolvedAt ?? '');
    setLegacyDecisionReceivedDate(evidence.decisionReceivedAt ?? '');
    setLegacyKlageFiledDate(evidence.klageFiledAt ?? '');
  }

  function submit(status: string, date?: string, instruction?: DecisionInstruction) {
    setError(null);
    start(async () => {
      const r = await updateNoticeStatusAction({
        noticeId,
        status,
        ...(date ? { eventDate: date } : {}),
        ...(instruction ? { decisionLegalRemedyInstruction: instruction } : {}),
        ...(needsAnyLegacyEvidence
          ? {
              legacyEvidence: {
                ...(needsLegacyAppealFiled ? { appealFiledDate: legacyAppealFiledDate } : {}),
                ...(needsLegacyAbhilfe ? { appealResolvedDate: legacyAppealResolvedDate } : {}),
                ...(needsLegacyDecision
                  ? { appealDecisionReceivedDate: legacyDecisionReceivedDate }
                  : {}),
                ...(needsLegacyKlage ? { klageFiledDate: legacyKlageFiledDate } : {}),
              },
            }
          : {}),
      });
      if (!r.ok) {
        setError(r.error ?? 'Fehler beim Statuswechsel.');
        return;
      }
      resetForm();
    });
  }

  if (allowed.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 mt-1">
      <select
        className="input text-xs py-1"
        value={selectedStatus}
        disabled={pending}
        aria-label="Bescheid-Status ändern"
        onChange={(e) => {
          const status = e.target.value;
          setSelectedStatus(status);
          if (!status) return;
          if (eventDateLabel[status]) {
            setEventDate('');
            setError(null);
            return;
          }
          submit(status);
        }}
      >
        <option value="">{pending ? 'Speichere…' : 'Status ändern…'}</option>
        {allowed.map((s) => (
          <option key={s} value={s}>
            → {STATUS_LABELS[s] ?? s}
          </option>
        ))}
      </select>
      {selectedStatus && eventDateLabel[selectedStatus] && (
        <div className="rounded border border-amber-200 bg-amber-50 p-2 space-y-2">
          <label
            className="block text-xs font-medium text-amber-900"
            htmlFor={`notice-event-${noticeId}`}
          >
            {eventDateLabel[selectedStatus]} *
          </label>
          <input
            id={`notice-event-${noticeId}`}
            type="date"
            className="input w-full text-xs py-1"
            value={eventDate}
            disabled={pending}
            onChange={(e) => setEventDate(e.target.value)}
            required
          />
          {(selectedStatus === 'TEILABHILFE' || selectedStatus === 'ZURUECKGEWIESEN') && (
            <div>
              <label
                className="block text-xs font-medium text-amber-900"
                htmlFor={`notice-instruction-${noticeId}`}
              >
                Klage-Rechtsbehelfsbelehrung *
              </label>
              <select
                id={`notice-instruction-${noticeId}`}
                className="input w-full text-xs py-1"
                value={decisionInstruction}
                disabled={pending}
                onChange={(e) =>
                  setDecisionInstruction(e.target.value as 'VALID' | 'MISSING_OR_INVALID')
                }
              >
                <option value="VALID">vorhanden und korrekt</option>
                <option value="MISSING_OR_INVALID">fehlt oder ist unrichtig</option>
              </select>
            </div>
          )}
          {needsAnyLegacyEvidence && (
            <fieldset className="rounded border border-amber-300 bg-white p-2 space-y-2">
              <legend className="px-1 text-xs font-semibold text-amber-950">
                Fehlende Nachweise aus Altbestand bestätigen
              </legend>
              <p className="text-xs text-amber-900">
                Bitte die tatsächlichen Ereignistage aus der Verfahrensakte übernehmen. Es werden
                keine historischen Daten automatisch geschätzt.
              </p>
              {needsLegacyAppealFiled && (
                <label className="block text-xs font-medium text-amber-900">
                  Einspruch tatsächlich eingelegt am *
                  <input
                    type="date"
                    className="input mt-1 w-full text-xs py-1"
                    value={legacyAppealFiledDate}
                    disabled={pending}
                    onChange={(e) => setLegacyAppealFiledDate(e.target.value)}
                    required
                  />
                </label>
              )}
              {needsLegacyAbhilfe && (
                <label className="block text-xs font-medium text-amber-900">
                  Abhilfe tatsächlich bekanntgegeben am *
                  <input
                    type="date"
                    className="input mt-1 w-full text-xs py-1"
                    value={legacyAppealResolvedDate}
                    disabled={pending}
                    onChange={(e) => setLegacyAppealResolvedDate(e.target.value)}
                    required
                  />
                </label>
              )}
              {needsLegacyDecision && (
                <>
                  <label className="block text-xs font-medium text-amber-900">
                    Einspruchsentscheidung tatsächlich bekanntgegeben am *
                    <input
                      type="date"
                      className="input mt-1 w-full text-xs py-1"
                      value={legacyDecisionReceivedDate}
                      disabled={pending}
                      onChange={(e) => setLegacyDecisionReceivedDate(e.target.value)}
                      required
                    />
                  </label>
                  <label className="block text-xs font-medium text-amber-900">
                    Rechtsbehelfsbelehrung der Entscheidung *
                    <select
                      className="input mt-1 w-full text-xs py-1"
                      value={decisionInstruction}
                      disabled={pending}
                      onChange={(e) =>
                        setDecisionInstruction(e.target.value as DecisionInstruction)
                      }
                    >
                      <option value="VALID">vorhanden und korrekt</option>
                      <option value="MISSING_OR_INVALID">fehlt oder ist unrichtig</option>
                    </select>
                  </label>
                </>
              )}
              {needsLegacyKlage && (
                <label className="block text-xs font-medium text-amber-900">
                  Klage tatsächlich eingereicht am *
                  <input
                    type="date"
                    className="input mt-1 w-full text-xs py-1"
                    value={legacyKlageFiledDate}
                    disabled={pending}
                    onChange={(e) => setLegacyKlageFiledDate(e.target.value)}
                    required
                  />
                </label>
              )}
            </fieldset>
          )}
          <div className="flex gap-1">
            <button
              type="button"
              className="btn-primary text-xs py-1 px-2"
              disabled={pending || !eventDate || missingRequiredLegacyDate}
              onClick={() =>
                submit(
                  selectedStatus,
                  eventDate,
                  selectedStatus === 'TEILABHILFE' ||
                    selectedStatus === 'ZURUECKGEWIESEN' ||
                    needsLegacyDecision
                    ? decisionInstruction
                    : undefined,
                )
              }
            >
              Datum bestätigen
            </button>
            <button
              type="button"
              className="btn-secondary text-xs py-1 px-2"
              disabled={pending}
              onClick={() => {
                resetForm();
                setError(null);
              }}
            >
              Abbrechen
            </button>
          </div>
          <p className="text-xs text-amber-800">
            Die Frist wird aus diesem tatsächlichen Datum berechnet, nicht aus dem Zeitpunkt des
            Statuswechsels.
          </p>
        </div>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
