'use client';

import { useState, useTransition } from 'react';
import { Send, Copy, Check, X } from 'lucide-react';
import { sendInviteAction, cancelInviteAction } from './invite-actions';
import { fmtDateTimeShort } from '@/lib/fmt';
import { GWG_INVITE_STATUS_LABELS } from '@/lib/domain-labels';

interface Contact {
  fullName: string;
  email: string;
}

interface Invite {
  id: string;
  inviteName: string;
  inviteEmail: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  submittedAt: string | null;
}

export function InviteSection({
  clientId,
  clientName,
  gwgCheckId,
  disabledReason,
  contacts,
  invites,
}: {
  clientId: string;
  clientName: string;
  gwgCheckId?: string;
  disabledReason?: string;
  contacts: Contact[];
  invites: Invite[];
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(contacts[0]?.fullName ?? '');
  const [email, setEmail] = useState(contacts[0]?.email ?? '');
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function pickContact(c: Contact) {
    setName(c.fullName);
    setEmail(c.email);
  }

  function send() {
    setError(null);
    setCreatedLink(null);
    if (!name.trim() || !email.trim()) {
      setError('Name und E-Mail sind erforderlich.');
      return;
    }
    start(async () => {
      const r = await sendInviteAction({
        clientId,
        inviteName: name.trim(),
        inviteEmail: email.trim(),
        gwgCheckId,
        expectedLatestInviteId: invites[0]?.id ?? null,
      });
      if (!r.ok) {
        setError(r.error ?? 'Fehler.');
        return;
      }
      setCreatedLink(r.link ?? null);
    });
  }

  function cancel(id: string) {
    if (!confirm('Einladung zurückziehen? Der Link wird sofort ungültig.')) return;
    start(async () => {
      await cancelInviteAction({ id });
    });
  }

  async function copyLink() {
    if (!createdLink) return;
    try {
      await navigator.clipboard.writeText(createdLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  const activeInvites = invites.filter((i) => i.status === 'PENDING' || i.status === 'STARTED');
  const otherInvites = invites.filter((i) => !(i.status === 'PENDING' || i.status === 'STARTED'));

  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-default flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-primary flex items-center gap-2">
            <Send className="h-4 w-4 text-brand-600" />
            Mandant zur GwG-Identifizierung einladen
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Mandant füllt Stammdaten + Ausweis-Fotos selbst aus, ohne Login.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="btn-secondary text-xs"
          disabled={Boolean(disabledReason)}
          title={disabledReason}
        >
          {open ? 'Schließen' : '+ Einladung senden'}
        </button>
      </div>

      {disabledReason && <div className="px-6 py-3 text-xs text-muted">{disabledReason}</div>}

      {open && (
        <div className="px-6 py-4 border-b border-default bg-subtle space-y-3">
          {contacts.length > 0 && (
            <div>
              <p className="text-xs text-muted mb-2">Bekannte Ansprechpartner:</p>
              <div className="flex flex-wrap gap-2">
                {contacts.map((c) => (
                  <button
                    key={c.email}
                    type="button"
                    onClick={() => pickContact(c)}
                    className="text-xs px-2 py-1 rounded bg-surface border border-default hover:bg-gray-100"
                  >
                    {c.fullName} <span className="text-disabled">· {c.email}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input"
                maxLength={200}
              />
            </div>
            <div>
              <label className="label">E-Mail</label>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                className="input"
                maxLength={255}
              />
            </div>
          </div>
          <p className="text-xs text-muted">
            Mandant: <strong>{clientName}</strong> · Einladung gilt 14 Tage.
          </p>
          {error && <div className="alert-error-sm">{error}</div>}
          {createdLink && (
            <div className="rounded-md bg-green-50 p-3 space-y-2">
              <p className="text-sm text-green-800">
                Einladung erstellt. Mandant erhält gleich eine Mail mit dem Link. Sie können den
                Link aber auch manuell weiterleiten:
              </p>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={createdLink}
                  className="input text-xs font-mono bg-surface"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button type="button" onClick={copyLink} className="btn-secondary text-xs">
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? 'kopiert' : 'kopieren'}
                </button>
              </div>
            </div>
          )}
          <div className="flex justify-end">
            <button type="button" onClick={send} disabled={isPending} className="btn-primary">
              {isPending ? 'Sendet…' : 'Einladung versenden'}
            </button>
          </div>
        </div>
      )}

      {invites.length === 0 ? null : (
        <div className="divide-y divide-border-subtle">
          {activeInvites.map((i) => (
            <div key={i.id} className="px-6 py-3 flex items-center justify-between text-sm">
              <div>
                <p className="font-medium text-primary">{i.inviteName}</p>
                <p className="text-xs text-muted">
                  {i.inviteEmail} · gültig bis {fmtDateTimeShort(new Date(i.expiresAt))}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className={i.status === 'STARTED' ? 'badge-yellow' : 'badge-gray'}>
                  {GWG_INVITE_STATUS_LABELS[i.status]}
                </span>
                <button
                  type="button"
                  onClick={() => cancel(i.id)}
                  className="text-xs text-red-700 hover:underline inline-flex items-center gap-1"
                  disabled={isPending}
                >
                  <X className="h-3 w-3" /> Zurückziehen
                </button>
              </div>
            </div>
          ))}
          {otherInvites.length > 0 && (
            <details className="px-6 py-3 text-xs text-muted">
              <summary className="cursor-pointer">{otherInvites.length} ältere Einladungen</summary>
              <ul className="mt-2 space-y-1">
                {otherInvites.map((i) => (
                  <li key={i.id} className="flex items-center justify-between">
                    <span>
                      {i.inviteName} · {i.inviteEmail}
                    </span>
                    <span>
                      {GWG_INVITE_STATUS_LABELS[i.status]}
                      {i.submittedAt && ` · ${fmtDateTimeShort(new Date(i.submittedAt))}`}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
