'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Check,
  Undo2,
  Copy,
  CornerDownRight,
  MessageSquare,
  Paperclip,
  Users,
  Quote,
  Send,
} from 'lucide-react';
import { fmtDateShort, fmtDateTimeShort } from '@/lib/fmt';
import { PRIORITY_BADGE, PRIORITY_LABEL } from '@/lib/reminder-priority';
import { DocumentUploadButton } from '@/components/document-upload-button';
import {
  markReminderDoneAction,
  reopenReminderAction,
  cloneReminderAction,
  addReminderNoteAction,
  setReminderAssigneesAction,
} from '../../clients/[id]/reminders/actions';
import type { ReminderDetail } from '@/server/reminders/detail';
import { splitByMentions } from '@/lib/reminder-mentions';
import { MentionTextarea } from './mention-textarea';

/** Vorschlag für die Frist einer Folgestufe: zwei Wochen. */
function inZweiWochen(): string {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString().slice(0, 10);
}

export function ReminderDetailView({
  detail,
  currentStaffId,
  canSteer,
  staffOptions,
}: {
  detail: ReminderDetail;
  currentStaffId: string;
  /** Anlegende Person oder Admin/Partner — darf umverteilen. */
  canSteer: boolean;
  staffOptions: Array<{ id: string; fullName: string }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [showAssign, setShowAssign] = useState(false);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? 'Aktion fehlgeschlagen.');
      else router.refresh();
    });
  }

  const badge = PRIORITY_BADGE[detail.priority];
  const erledigt = detail.doneAt !== null;

  return (
    <div className="space-y-4">
      {error && <p className="alert-error-sm">{error}</p>}

      {/* -------------------------------------------------- Kopf + Aktionen */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          {badge && (
            <span className={`${badge} text-[11px]`}>{PRIORITY_LABEL[detail.priority]}</span>
          )}
          <span className={erledigt ? 'badge-gray text-[11px]' : 'badge-brand text-[11px]'}>
            {erledigt ? `erledigt ${fmtDateShort(new Date(detail.doneAt!))}` : 'offen'}
          </span>
          <span className="text-xs text-muted">
            fällig {fmtDateShort(new Date(detail.dueDate))}
          </span>
          <span className="text-xs text-disabled">
            · angelegt von {detail.createdByName ?? 'unbekannt'}
          </span>
        </div>

        {(detail.begriff || detail.normAnker.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {detail.begriff && <span className="badge-yellow text-[11px]">{detail.begriff}</span>}
            {detail.normAnker.map((n) => (
              <span key={n} className="badge-gray text-[11px] font-mono">
                {n}
              </span>
            ))}
          </div>
        )}
        {detail.fundstelle && (
          <blockquote className="flex gap-1.5 rounded border-l-2 border-strong bg-surface-raised px-2 py-1 text-xs text-secondary italic">
            <Quote className="h-3 w-3 shrink-0 mt-0.5 text-disabled" />
            <span className="min-w-0 break-words">{detail.fundstelle}</span>
          </blockquote>
        )}
        {detail.auftrag && (
          <p className="text-sm text-secondary whitespace-pre-wrap">{detail.auftrag}</p>
        )}
        {detail.researchAnalysisId && detail.researchMarkingId && detail.clientId && (
          <Link
            href={`/staff/clients/${detail.clientId}/subsumtion/${detail.researchAnalysisId}?marking=${detail.researchMarkingId}`}
            className="text-xs text-brand-600 hover:underline inline-block"
          >
            Markierung im Subsumtions-Space öffnen
          </Link>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {erledigt ? (
            <button
              type="button"
              onClick={() => run(() => reopenReminderAction({ id: detail.id }))}
              disabled={pending}
              className="btn-secondary text-xs"
            >
              <Undo2 className="h-3.5 w-3.5" /> Zurückholen
            </button>
          ) : (
            <button
              type="button"
              onClick={() => run(() => markReminderDoneAction({ id: detail.id }))}
              disabled={pending}
              className="btn-primary text-xs"
            >
              <Check className="h-3.5 w-3.5" /> Erledigt
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowFollowUp((v) => !v)}
            className="btn-secondary text-xs"
            title="Neue Aufgabe mit Verweis auf diese — z. B. eine Rückfrage zum Ergebnis"
          >
            <CornerDownRight className="h-3.5 w-3.5" /> Nachfassen
          </button>
          <button
            type="button"
            onClick={() =>
              run(() =>
                cloneReminderAction({
                  id: detail.id,
                  alsNachfrage: false,
                  dueDate: inZweiWochen(),
                }),
              )
            }
            disabled={pending}
            className="btn-secondary text-xs"
            title="Dieselbe Aufgabe erneut aufsetzen (ohne Verweis)"
          >
            <Copy className="h-3.5 w-3.5" /> Klonen
          </button>
          {canSteer && (
            <button
              type="button"
              onClick={() => setShowAssign((v) => !v)}
              className="btn-secondary text-xs"
            >
              <Users className="h-3.5 w-3.5" /> Zuständige ändern
            </button>
          )}
        </div>

        {showFollowUp && (
          <FollowUpForm
            reminderId={detail.id}
            staffOptions={staffOptions}
            vorbelegung={detail.assignees.map((a) => a.staffId)}
            pending={pending}
            onDone={() => {
              setShowFollowUp(false);
              router.refresh();
            }}
            onError={setError}
          />
        )}
        {showAssign && canSteer && (
          <AssigneeForm
            reminderId={detail.id}
            staffOptions={staffOptions}
            aktuell={detail.assignees.map((a) => a.staffId)}
            pending={pending}
            onDone={() => {
              setShowAssign(false);
              router.refresh();
            }}
            onError={setError}
          />
        )}
      </div>

      {/* -------------------------------------------------------- Zuständige */}
      <div className="card p-4">
        <h2 className="text-sm font-medium text-primary mb-2 inline-flex items-center gap-2">
          <Users className="h-4 w-4 text-disabled" /> Zuständig ({detail.assignees.length})
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {detail.assignees.map((a) => (
            <span
              key={a.staffId}
              className={
                a.staffId === currentStaffId ? 'badge-brand text-[11px]' : 'badge-gray text-[11px]'
              }
            >
              {a.fullName}
              {a.staffId === currentStaffId && ' (du)'}
            </span>
          ))}
        </div>
        <p className="text-[11px] text-disabled mt-2">
          Eine Aufgabe für alle — wer sie abhakt, erledigt sie für die ganze Gruppe.
        </p>
      </div>

      {/* -------------------------------------------------------------- Kette */}
      {(detail.vorgaenger.length > 0 || detail.folgestufen.length > 0) && (
        <div className="card p-4 space-y-2">
          <h2 className="text-sm font-medium text-primary inline-flex items-center gap-2">
            <CornerDownRight className="h-4 w-4 text-disabled" /> Verlauf
          </h2>
          <ol className="space-y-1">
            {detail.vorgaenger.map((v) => (
              <KettenZeile key={v.id} glied={v} />
            ))}
            <li className="text-sm text-primary font-medium pl-3 border-l-2 border-brand-500">
              {detail.subject} <span className="text-xs text-muted">· diese Stufe</span>
            </li>
            {detail.folgestufen.map((f) => (
              <KettenZeile key={f.id} glied={f} />
            ))}
          </ol>
        </div>
      )}

      {/* ------------------------------------------------------------ Anhänge */}
      <div className="card p-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-primary inline-flex items-center gap-2">
            <Paperclip className="h-4 w-4 text-disabled" /> Anhänge ({detail.attachments.length})
          </h2>
          <DocumentUploadButton
            {...(detail.clientId ? { clientId: detail.clientId } : {})}
            reminderId={detail.id}
            buttonLabel="Datei anhängen"
            buttonClassName="btn-secondary text-xs py-1"
            onUploaded={() => router.refresh()}
          />
        </div>
        {detail.attachments.length === 0 ? (
          <p className="text-xs text-disabled">Noch keine Datei angehängt.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {detail.attachments.map((d) => (
              <li key={d.id} className="py-1.5 flex items-center gap-2 text-sm">
                <Paperclip className="h-3.5 w-3.5 text-disabled shrink-0" />
                <span className="flex-1 min-w-0 truncate text-primary">{d.title}</span>
                <span className="text-[11px] text-disabled shrink-0">
                  {d.uploadedByName} · {fmtDateShort(new Date(d.createdAt))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --------------------------------------------------- Vereinter Verlauf */}
      <div className="card p-4 space-y-3">
        <h2 className="text-sm font-medium text-primary inline-flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-disabled" /> Verlauf (
          {detail.discussion.length + detail.attachments.length})
        </h2>
        <VerlaufFeed
          discussion={detail.discussion}
          attachments={detail.attachments}
          staffOptions={staffOptions}
        />
        <div className="flex items-start gap-2">
          <MentionTextarea
            value={note}
            onChange={setNote}
            staffOptions={staffOptions}
            rows={2}
            maxLength={5000}
            placeholder="Kurze Rückfrage oder Zwischenstand — mit @ Personen gezielt ansprechen."
            className="input text-sm"
          />
          <button
            type="button"
            disabled={pending || !note.trim()}
            onClick={() =>
              run(async () => {
                const r = await addReminderNoteAction({ id: detail.id, body: note });
                if (r.ok) setNote('');
                return r;
              })
            }
            className="btn-primary text-xs shrink-0"
          >
            <Send className="h-3.5 w-3.5" /> Senden
          </button>
        </div>
      </div>
    </div>
  );
}

function KettenZeile({
  glied,
}: {
  glied: { id: string; subject: string; dueDate: string; doneAt: string | null };
}) {
  return (
    <li className="pl-3 border-l-2 border-border-subtle">
      <Link
        href={`/staff/reminders/${glied.id}`}
        className="text-sm text-secondary hover:underline"
      >
        {glied.subject}
      </Link>
      <span className="text-[11px] text-disabled ml-2">
        {glied.doneAt ? `erledigt ${fmtDateShort(new Date(glied.doneAt))}` : 'offen'} · fällig{' '}
        {fmtDateShort(new Date(glied.dueDate))}
      </span>
    </li>
  );
}

/** „Nachfrage zu …" — neue Stufe mit Verweis auf diese. */
function FollowUpForm(props: {
  reminderId: string;
  staffOptions: Array<{ id: string; fullName: string }>;
  vorbelegung: string[];
  pending: boolean;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const [due, setDue] = useState(inZweiWochen());
  const [staffIds, setStaffIds] = useState<string[]>(props.vorbelegung);
  const [text, setText] = useState('');
  const [busy, start] = useTransition();

  return (
    <div className="rounded-md border border-default bg-surface-raised p-3 space-y-2">
      <p className="text-xs font-medium text-secondary">Nachfrage stellen (neue Stufe)</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">
          <span className="text-muted">Fällig</span>
          <input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="input text-sm w-full mt-0.5"
          />
        </label>
        <StaffPicker
          label="Zuständig"
          options={props.staffOptions}
          value={staffIds}
          onChange={setStaffIds}
        />
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        placeholder="Was genau ist offen?"
        className="input text-sm w-full"
      />
      <button
        type="button"
        disabled={props.pending || busy || !due}
        onClick={() =>
          start(async () => {
            const r = await cloneReminderAction({
              id: props.reminderId,
              alsNachfrage: true,
              dueDate: due,
              notes: text.trim() || null,
              assigneeStaffIds: staffIds,
            });
            if (r.ok) props.onDone();
            else props.onError(r.error ?? 'Nachfrage konnte nicht angelegt werden.');
          })
        }
        className="btn-primary text-xs"
      >
        <CornerDownRight className="h-3.5 w-3.5" /> Nachfrage anlegen
      </button>
    </div>
  );
}

function AssigneeForm(props: {
  reminderId: string;
  staffOptions: Array<{ id: string; fullName: string }>;
  aktuell: string[];
  pending: boolean;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const [staffIds, setStaffIds] = useState<string[]>(props.aktuell);
  const [busy, start] = useTransition();
  return (
    <div className="rounded-md border border-default bg-surface-raised p-3 space-y-2">
      <StaffPicker
        label="Zuständige"
        options={props.staffOptions}
        value={staffIds}
        onChange={setStaffIds}
      />
      <button
        type="button"
        disabled={props.pending || busy || staffIds.length === 0}
        onClick={() =>
          start(async () => {
            const r = await setReminderAssigneesAction({ id: props.reminderId, staffIds });
            if (r.ok) props.onDone();
            else props.onError(r.error ?? 'Zuweisung fehlgeschlagen.');
          })
        }
        className="btn-primary text-xs"
      >
        Übernehmen
      </button>
    </div>
  );
}

/** Mehrfachauswahl von Mitarbeitenden — Kästchen statt Multiselect-Liste. */
export function StaffPicker({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ id: string; fullName: string }>;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <div className="text-xs">
      <span className="text-muted">{label}</span>
      <div className="mt-0.5 max-h-32 overflow-auto rounded border border-default bg-surface p-1.5 space-y-0.5">
        {options.map((s) => (
          <label key={s.id} className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={value.includes(s.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, s.id] : value.filter((id) => id !== s.id))
              }
              className="rounded border-strong text-brand-600"
            />
            <span className="text-secondary">{s.fullName}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Vereinter Verlauf: Wortmeldungen und Datei-Uploads, chronologisch gemischt.
 * Vorher standen Rückfragen und Anhänge in getrennten Karten — wer wissen
 * wollte, was zuletzt passiert ist, musste beide vergleichen.
 */
function VerlaufFeed({
  discussion,
  attachments,
  staffOptions,
}: {
  discussion: ReminderDetail['discussion'];
  attachments: ReminderDetail['attachments'];
  staffOptions: Array<{ id: string; fullName: string }>;
}) {
  const eintraege = [
    ...discussion.map((n) => ({
      key: `note-${n.id}`,
      createdAt: n.createdAt,
      wer: n.staffName,
      art: 'note' as const,
      text: n.body,
    })),
    ...attachments.map((d) => ({
      key: `file-${d.id}`,
      createdAt: d.createdAt,
      wer: d.uploadedByName,
      art: 'upload' as const,
      text: d.title,
    })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (eintraege.length === 0) {
    return <p className="text-xs text-disabled">Noch keine Rückfragen oder Dateien.</p>;
  }

  return (
    <ul className="space-y-2">
      {eintraege.map((e) => (
        <li key={e.key} className="rounded bg-surface-raised px-3 py-2">
          <p className="text-[11px] text-muted inline-flex items-center gap-1">
            {e.art === 'upload' && <Paperclip className="h-3 w-3" />}
            {e.wer} · {fmtDateTimeShort(new Date(e.createdAt))}
          </p>
          {e.art === 'note' ? (
            <p className="text-sm text-secondary whitespace-pre-wrap mt-0.5">
              {splitByMentions(e.text, staffOptions).map((seg, i) =>
                seg.mention ? (
                  <span key={i} className="text-brand-600 font-medium">
                    {seg.text}
                  </span>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )}
            </p>
          ) : (
            <p className="text-sm text-secondary mt-0.5">
              Datei angehängt: <span className="text-primary">{e.text}</span>
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
