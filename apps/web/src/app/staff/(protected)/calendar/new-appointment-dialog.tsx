'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { Plus, X } from 'lucide-react';
import { createAppointmentAction, type ActionResult } from './actions';

interface StaffOption {
  id: string;
  fullName: string;
}
interface ClientOption {
  id: string;
  name: string;
}

export function NewAppointmentDialog({
  staffOptions,
  clientOptions,
  currentStaffId,
  defaultStart,
}: {
  staffOptions: StaffOption[];
  clientOptions: ClientOption[];
  currentStaffId: string;
  defaultStart?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createAppointmentAction,
    null,
  );

  // Portal mount erst nach Client-side hydrate
  useEffect(() => setMounted(true), []);

  // Nach erfolgreichem Submit: Dialog schließen + refresh. Bewusst in
  // useEffect, NICHT im Render-Body — im Render-Body würde state.ok bei JEDEM
  // Re-Render erneut router.refresh() feuern (Refresh-Schleife) und das
  // erneute Öffnen des Dialogs sofort wieder schließen.
  useEffect(() => {
    if (state?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [state, router]);

  const nowLocal = (() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  })();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-primary text-xs inline-flex items-center gap-1"
      >
        <Plus className="h-3.5 w-3.5" />
        Neuer Termin
      </button>

      {open &&
        mounted &&
        createPortal(
          <div className="modal-overlay">
            <div className="bg-surface rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
              <div className="px-5 py-3 border-b border-default flex items-center justify-between">
                <h2 className="text-sm font-medium text-primary">Neuer Termin</h2>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="text-disabled hover:text-primary"
                  aria-label="Schließen"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <form action={formAction} className="p-5 space-y-3">
                <div>
                  <label className="label">Titel</label>
                  <input
                    type="text"
                    name="title"
                    required
                    maxLength={200}
                    className="input"
                    placeholder='z. B. „Bilanzbesprechung Müller GmbH"'
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Art</label>
                    <select name="kind" defaultValue="CLIENT_MEETING" className="input">
                      <option value="CLIENT_MEETING">Mandantentermin</option>
                      <option value="INTERNAL">Intern</option>
                      <option value="PRIVATE">Privat / blocken</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">Für (Owner)</label>
                    <select
                      name="ownerStaffId"
                      defaultValue={currentStaffId}
                      required
                      className="input"
                    >
                      {staffOptions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.fullName}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="label">Mandant (optional)</label>
                  <select name="clientId" defaultValue="" className="input">
                    <option value="">— ohne Mandantenbezug —</option>
                    {clientOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Start</label>
                    <input
                      type="datetime-local"
                      name="startsAt"
                      defaultValue={defaultStart ?? nowLocal}
                      required
                      className="input"
                    />
                  </div>
                  <div>
                    <label className="label">Ende</label>
                    <input type="datetime-local" name="endsAt" required className="input" />
                  </div>
                </div>
                <div>
                  <label className="label">Ort (optional)</label>
                  <input
                    type="text"
                    name="location"
                    maxLength={200}
                    className="input"
                    placeholder="Büro, Video-Call, Telefon, …"
                  />
                </div>
                <div>
                  <label className="label">Notizen (optional)</label>
                  <textarea name="notes" rows={3} maxLength={4000} className="input" />
                </div>
                {state && !state.ok && <p className="text-xs text-red-700">{state.error}</p>}
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="btn-secondary text-sm"
                  >
                    Abbrechen
                  </button>
                  <button type="submit" disabled={isPending} className="btn-primary text-sm">
                    {isPending ? 'Speichert…' : 'Anlegen'}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
