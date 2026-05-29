'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, X, Calendar } from 'lucide-react';
import { acceptAppointmentRequestAction, rejectAppointmentRequestAction } from './actions';
import { fmtDateTimeShort } from '@/lib/fmt';


interface StaffOption { id: string; fullName: string; }

export interface RequestRow {
  id: string;
  subject: string;
  notes: string | null;
  createdAt: string;
  clientName: string;
  contactName: string | null;
  preferredStaffId: string | null;
  slots: Array<{ startsAt: string; endsAt: string }>;
}

export function RequestDecision({
  request,
  staffOptions,
  currentStaffId,
}: {
  request: RequestRow;
  staffOptions: StaffOption[];
  currentStaffId: string;
}) {
  const router = useRouter();
  const [isMutating, startMut] = useTransition();
  const [mode, setMode] = useState<null | 'accept' | 'reject'>(null);
  const [slotIndex, setSlotIndex] = useState(0);
  const [ownerStaffId, setOwnerStaffId] = useState(request.preferredStaffId ?? currentStaffId);
  const [reason, setReason] = useState('');

  function accept() {
    startMut(async () => {
      const res = await acceptAppointmentRequestAction({
        requestId: request.id,
        slotIndex,
        ownerStaffId,
      });
      if (!res.ok) {
        alert(res.error ?? 'Akzeptieren fehlgeschlagen.');
        return;
      }
      router.refresh();
    });
  }

  function reject() {
    startMut(async () => {
      const res = await rejectAppointmentRequestAction({
        requestId: request.id,
        reason: reason || undefined,
      });
      if (!res.ok) {
        alert(res.error ?? 'Ablehnen fehlgeschlagen.');
        return;
      }
      router.refresh();
    });
  }

  return (
    <li className="px-5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-primary">{request.subject}</p>
          <p className="text-xs text-muted">
            {request.clientName}
            {request.contactName && ` · ${request.contactName}`}
            <span className="ml-2 text-disabled">{fmtDateTimeShort(new Date(request.createdAt))}</span>
          </p>
          {request.notes && (
            <p className="text-xs text-secondary dark:text-disabled mt-1 whitespace-pre-wrap line-clamp-3">{request.notes}</p>
          )}
          <ul className="mt-2 space-y-1">
            {request.slots.map((s, i) => (
              <li key={i} className="text-xs flex items-center gap-2">
                <Calendar className="h-3 w-3 text-disabled" />
                <span className="text-secondary">
                  {fmtDateTimeShort(new Date(s.startsAt))} – {fmtDateTimeShort(new Date(s.endsAt))}
                </span>
              </li>
            ))}
          </ul>
        </div>
        {mode === null && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setMode('accept')}
              disabled={isMutating}
              className="btn-primary text-[11px] py-1 inline-flex items-center gap-1"
            >
              <Check className="h-3 w-3" />
              Annehmen
            </button>
            <button
              type="button"
              onClick={() => setMode('reject')}
              disabled={isMutating}
              className="btn-secondary text-[11px] py-1 inline-flex items-center gap-1"
            >
              <X className="h-3 w-3" />
              Ablehnen
            </button>
          </div>
        )}
      </div>

      {mode === 'accept' && (
        <div className="mt-3 p-3 rounded bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs">
              Wunschtermin
              <select
                value={slotIndex}
                onChange={(e) => setSlotIndex(Number(e.target.value))}
                className="input text-xs mt-1"
              >
                {request.slots.map((s, i) => (
                  <option key={i} value={i}>
                    {fmtDateTimeShort(new Date(s.startsAt))}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              Owner
              <select
                value={ownerStaffId}
                onChange={(e) => setOwnerStaffId(e.target.value)}
                className="input text-xs mt-1"
              >
                {staffOptions.map((s) => (
                  <option key={s.id} value={s.id}>{s.fullName}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setMode(null)}
              className="btn-secondary text-[11px] py-1"
              disabled={isMutating}
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={accept}
              disabled={isMutating}
              className="btn-primary text-[11px] py-1"
            >
              {isMutating ? 'Bestätige…' : 'Bestätigen'}
            </button>
          </div>
        </div>
      )}

      {mode === 'reject' && (
        <div className="mt-3 p-3 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 space-y-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Begründung (optional, wird dem Mandanten angezeigt)"
            rows={2}
            maxLength={500}
            className="input text-xs"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setMode(null)}
              className="btn-secondary text-[11px] py-1"
              disabled={isMutating}
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={reject}
              disabled={isMutating}
              className="btn-primary text-[11px] py-1 bg-red-600 hover:bg-red-700"
            >
              {isMutating ? 'Lehne ab…' : 'Ablehnen'}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
