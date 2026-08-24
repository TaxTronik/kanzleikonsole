'use client';

import { useState, useTransition } from 'react';
import { updateNoticeStatusAction } from './actions';
import { NOTICE_STATUS_LABELS } from '@/lib/domain-labels';

type DecisionInstruction = 'VALID' | 'MISSING_OR_INVALID';

type NoticeEvidence = {
  appealFiledAt: string | null;
  appealFiledComplete: boolean;
  appealResolvedAt: string | null;
  partialReliefReceivedAt: string | null;
  partialReliefComplete: boolean;
  decisionReceivedAt: string | null;
  decisionComplete: boolean;
  decisionInstruction: DecisionInstruction;
  klageFiledAt: string | null;
  klageFiledComplete: boolean;
};

type LegacyEvidenceNeeds = {
  appealFiled: boolean;
  abhilfe: boolean;
  partialRelief: boolean;
  decision: boolean;
  klage: boolean;
  any: boolean;
};

function getLegacyEvidenceNeeds(
  currentStatus: string,
  selectedStatus: string,
  evidence: NoticeEvidence,
): LegacyEvidenceNeeds {
  const appealFiled =
    [
      'EINSPRUCH',
      'ABGEHOLFEN',
      'TEILABHILFE',
      'TEILEINSPRUCHSENTSCHEIDUNG',
      'ZURUECKGEWIESEN',
      'KLAGE',
    ].includes(currentStatus) && !evidence.appealFiledComplete;
  const abhilfe =
    currentStatus === 'ABGEHOLFEN' &&
    selectedStatus === 'BESTANDSKRAEFTIG' &&
    !evidence.appealResolvedAt;
  const partialRelief = currentStatus === 'TEILABHILFE' && !evidence.partialReliefComplete;
  const decision =
    ['TEILEINSPRUCHSENTSCHEIDUNG', 'ZURUECKGEWIESEN', 'KLAGE'].includes(currentStatus) &&
    !evidence.decisionComplete;
  const klage =
    currentStatus === 'KLAGE' &&
    selectedStatus === 'BESTANDSKRAEFTIG' &&
    !evidence.klageFiledComplete;
  return {
    appealFiled,
    abhilfe,
    partialRelief,
    decision,
    klage,
    any: [appealFiled, abhilfe, partialRelief, decision, klage].some(Boolean),
  };
}

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
  const [legacyPartialReliefReceivedDate, setLegacyPartialReliefReceivedDate] = useState(
    evidence.partialReliefReceivedAt ?? '',
  );
  const [legacyDecisionReceivedDate, setLegacyDecisionReceivedDate] = useState(
    evidence.decisionReceivedAt ?? '',
  );
  const [legacyKlageFiledDate, setLegacyKlageFiledDate] = useState(evidence.klageFiledAt ?? '');
  const [legalFinalReason, setLegalFinalReason] = useState('');

  const eventDateLabel: Record<string, string> = {
    EINSPRUCH: 'Einspruch eingelegt am',
    ABGEHOLFEN: 'Abhilfe bekanntgegeben am',
    TEILABHILFE: 'Teilabhilfebescheid bekanntgegeben am',
    TEILEINSPRUCHSENTSCHEIDUNG: 'Teil-Einspruchsentscheidung bekanntgegeben am',
    ZURUECKGEWIESEN: 'Einspruchsentscheidung bekanntgegeben am',
    KLAGE: 'Klage eingereicht am',
    BESTANDSKRAEFTIG: 'Bestandskraft fachlich festgestellt am',
  };

  const legacyNeeds = getLegacyEvidenceNeeds(currentStatus, selectedStatus, evidence);
  const needsLegacyAppealFiled = legacyNeeds.appealFiled;
  const needsLegacyAbhilfe = legacyNeeds.abhilfe;
  const needsLegacyPartialRelief = legacyNeeds.partialRelief;
  const needsLegacyDecision = legacyNeeds.decision;
  const needsLegacyKlage = legacyNeeds.klage;
  const needsAnyLegacyEvidence = legacyNeeds.any;
  const missingRequiredLegacyDate = [
    [needsLegacyAppealFiled, legacyAppealFiledDate],
    [needsLegacyAbhilfe, legacyAppealResolvedDate],
    [needsLegacyPartialRelief, legacyPartialReliefReceivedDate],
    [needsLegacyDecision, legacyDecisionReceivedDate],
    [needsLegacyKlage, legacyKlageFiledDate],
  ].some(([needed, date]) => needed && !date);

  function resetForm() {
    setSelectedStatus('');
    setEventDate('');
    setDecisionInstruction(evidence.decisionInstruction);
    setLegacyAppealFiledDate(evidence.appealFiledAt ?? '');
    setLegacyAppealResolvedDate(evidence.appealResolvedAt ?? '');
    setLegacyPartialReliefReceivedDate(evidence.partialReliefReceivedAt ?? '');
    setLegacyDecisionReceivedDate(evidence.decisionReceivedAt ?? '');
    setLegacyKlageFiledDate(evidence.klageFiledAt ?? '');
    setLegalFinalReason('');
  }

  function submit(status: string, date?: string, instruction?: DecisionInstruction) {
    setError(null);
    start(async () => {
      const r = await updateNoticeStatusAction({
        noticeId,
        status,
        ...(date ? { eventDate: date } : {}),
        ...(instruction ? { decisionLegalRemedyInstruction: instruction } : {}),
        ...(status === 'BESTANDSKRAEFTIG' ? { legalFinalReason } : {}),
        ...(needsAnyLegacyEvidence
          ? {
              legacyEvidence: {
                ...(needsLegacyAppealFiled ? { appealFiledDate: legacyAppealFiledDate } : {}),
                ...(needsLegacyAbhilfe ? { appealResolvedDate: legacyAppealResolvedDate } : {}),
                ...(needsLegacyPartialRelief
                  ? { partialReliefReceivedDate: legacyPartialReliefReceivedDate }
                  : {}),
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
            → {NOTICE_STATUS_LABELS[s] ?? s}
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
          {['TEILEINSPRUCHSENTSCHEIDUNG', 'ZURUECKGEWIESEN'].includes(selectedStatus) && (
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
          {selectedStatus === 'BESTANDSKRAEFTIG' && (
            <label className="block text-xs font-medium text-amber-900">
              Fachliche Abschlussbegründung *
              <textarea
                className="input mt-1 w-full text-xs py-1"
                rows={3}
                minLength={10}
                maxLength={2000}
                value={legalFinalReason}
                disabled={pending}
                onChange={(e) => setLegalFinalReason(e.target.value)}
                placeholder="Fristablauf, Aktenprüfung und bewusste Abschlussentscheidung dokumentieren"
                required
              />
            </label>
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
              {needsLegacyPartialRelief && (
                <label className="block text-xs font-medium text-amber-900">
                  Teilabhilfebescheid tatsächlich bekanntgegeben am *
                  <input
                    type="date"
                    className="input mt-1 w-full text-xs py-1"
                    value={legacyPartialReliefReceivedDate}
                    disabled={pending}
                    onChange={(e) => setLegacyPartialReliefReceivedDate(e.target.value)}
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
              disabled={
                pending ||
                !eventDate ||
                missingRequiredLegacyDate ||
                (selectedStatus === 'BESTANDSKRAEFTIG' && legalFinalReason.trim().length < 10)
              }
              onClick={() =>
                submit(
                  selectedStatus,
                  eventDate,
                  ['TEILEINSPRUCHSENTSCHEIDUNG', 'ZURUECKGEWIESEN'].includes(selectedStatus) ||
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
          {selectedStatus === 'TEILABHILFE' ? (
            <p className="text-xs text-amber-800">
              Der Teilabhilfebescheid wird im laufenden Einspruchsverfahren dokumentiert. Allein
              daraus entsteht keine Klagefrist.
            </p>
          ) : selectedStatus === 'TEILEINSPRUCHSENTSCHEIDUNG' ? (
            <p className="text-xs text-amber-800">
              Die Klagefrist gilt nur für den in der Teil-Einspruchsentscheidung entschiedenen Teil;
              der übrige Einspruch kann weiter anhängig sein.
            </p>
          ) : (
            <p className="text-xs text-amber-800">
              Die Frist wird aus diesem tatsächlichen Datum berechnet, nicht aus dem Zeitpunkt des
              Statuswechsels.
            </p>
          )}
        </div>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
