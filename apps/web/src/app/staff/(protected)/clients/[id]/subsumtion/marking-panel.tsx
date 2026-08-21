'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  X,
  Save,
  Send,
  BookPlus,
  Trash2,
  AlertTriangle,
  Webhook,
  CalendarClock,
  ArrowRight,
} from 'lucide-react';
import { updateMarkingAction, deleteMarkingAction, delegateAction } from './actions';
import { pushDefinitionAction } from './norm-actions';
import { NormRefList, KatalogReviewControl } from './norm-ref-editor';
import { ResearchComposer } from './research-composer';
import { ResearchReviewSection } from './research-review';
import { fmtDateShort } from '@/lib/fmt';
import {
  type MarkingDTO,
  type ResearchResultDTO,
  type Flash,
  GOV_LABEL,
  STATUS_LABEL,
  HERKUNFT_LABEL,
  ENGINE_STATUS_LABEL,
  herkunftBadge,
} from './_ui';

function canDefineDelegatedMarking(canWrite: boolean, engineConfigured: boolean): boolean {
  return canWrite && engineConfigured;
}

export function MarkingPanel(props: {
  clientId: string;
  analysisId: string;
  marking: MarkingDTO;
  staffOptions: Array<{ id: string; fullName: string }>;
  engineConfigured: boolean;
  pending: boolean;
  start: (cb: () => void) => void;
  onChanged: () => void;
  onClose: () => void;
  flash: Flash;
  /** Volle Bearbeitungsrechte (Admin/Partner oder zustaendige:r Berufstraeger:in). */
  canWrite?: boolean;
  /** Diese Markierung ist mir zur Recherche zugewiesen. */
  isAssignee?: boolean;
  /** Rechercheergebnisse DIESER Markierung — zur Prüfung an Ort und Stelle. */
  results?: ResearchResultDTO[];
}) {
  const {
    clientId,
    analysisId,
    canWrite = true,
    isAssignee = false,
    results = [],
    marking: m,
    staffOptions,
    engineConfigured,
    pending,
    start,
    onChanged,
    onClose,
    flash,
  } = props;

  // Tatsächlich markierter Text (Fundstelle) — Whitespace geglättet, gekappt.
  // Nur zeigen, wenn er sich vom Begriff unterscheidet (sonst redundant, z. B. wörtlich).
  const fundstelle = m.matchedText.replace(/\s+/g, ' ').trim();
  const showFundstelle = fundstelle.length > 0 && fundstelle !== m.begriff.trim();
  const fundstelleShort = fundstelle.length > 220 ? fundstelle.slice(0, 220) + '…' : fundstelle;

  const [gov, setGov] = useState(m.governanceTyp ?? '');
  const [intens, setIntens] = useState(m.schadensintensitaet ?? '');
  const [wk, setWk] = useState(m.wahrscheinlichkeit ?? '');
  const [kask, setKask] = useState(m.kaskadenreichweite?.toString() ?? '');
  const [kontrolle, setKontrolle] = useState(m.kontrolle ?? '');
  const [status, setStatus] = useState(m.status);
  const [notiz, setNotiz] = useState(m.notiz ?? '');
  const [verantw, setVerantw] = useState(m.verantwortlichId ?? '');
  const [label, setLabel] = useState(m.label ?? '');

  const [showDelegate, setShowDelegate] = useState(false);
  const [showDefine, setShowDefine] = useState(false);
  const [showResearch, setShowResearch] = useState(false);

  function save() {
    start(async () => {
      const r = await updateMarkingAction({
        clientId,
        analysisId,
        markingId: m.id,
        governanceTyp: (gov || null) as 'FP' | 'FF' | 'IN' | null,
        schadensintensitaet: (intens || null) as 'NIEDRIG' | 'MITTEL' | 'HOCH' | null,
        wahrscheinlichkeit: (wk || null) as
          | 'SELTEN'
          | 'MOEGLICH'
          | 'WAHRSCHEINLICH'
          | 'HAEUFIG'
          | null,
        kaskadenreichweite: kask.trim() === '' ? null : Number(kask),
        kontrolle: kontrolle.trim() || null,
        status,
        notiz: notiz.trim() || null,
        verantwortlichId: verantw || null,
        label: label.trim() || null,
      });
      flash(r, 'Gespeichert.');
      if (r.ok) onChanged();
    });
  }

  function remove() {
    if (!window.confirm('Markierung löschen?')) return;
    start(async () => {
      const r = await deleteMarkingAction({ clientId, analysisId, markingId: m.id });
      flash(r, 'Gelöscht.');
      if (r.ok) {
        onClose();
        onChanged();
      }
    });
  }

  return (
    <div className="card p-4 space-y-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-primary break-words">{m.begriff}</p>
          {showFundstelle && (
            <p
              className="text-xs text-secondary mt-1 break-words"
              title={fundstelle.length > 220 ? fundstelle : undefined}
            >
              <span className="text-muted">markiert: </span>
              <span className="italic">„{fundstelleShort}"</span>
            </p>
          )}
          <p className="text-xs text-muted mt-1 flex items-center gap-1 flex-wrap">
            <span className={herkunftBadge(m.herkunft) + ' text-[10px]'}>
              {HERKUNFT_LABEL[m.herkunft]}
            </span>
            {m.engineStatus && (
              <span className="badge-gray text-[10px]">
                {ENGINE_STATUS_LABEL[m.engineStatus] ?? m.engineStatus}
              </span>
            )}
            <span>
              Zeichen {m.start}–{m.end}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-disabled hover:text-secondary shrink-0"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {m.streitig && (
        <p className="text-xs text-red-700 dark:text-red-300 inline-flex items-center gap-1">
          <AlertTriangle className="h-3.5 w-3.5" /> Fachlich umstrittene Stelle (Streit).
        </p>
      )}
      <DelegationStatus
        delegation={m.delegation}
        verantwortlichId={m.verantwortlichId}
        staffOptions={staffOptions}
        canDefine={canDefineDelegatedMarking(canWrite, engineConfigured)}
        onDefine={() => setShowDefine(true)}
      />
      <NormRefList
        clientId={clientId}
        markingId={m.id}
        katalogId={m.begriffId}
        refs={m.normRefs}
        fallback={m.normAnker}
        engineConfigured={engineConfigured}
        pending={pending}
        start={start}
        flash={flash}
        onChanged={onChanged}
      />
      {m.begriffId && m.catalogReviewable && engineConfigured && (
        <KatalogReviewControl
          clientId={clientId}
          katalogId={m.begriffId}
          pending={pending}
          start={start}
          flash={flash}
        />
      )}
      {m.normketten != null && Array.isArray(m.normketten) && m.normketten.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">Normketten (Kaskade)</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-gray-50 dark:bg-gray-900 p-2 text-[11px] whitespace-pre-wrap">
            {JSON.stringify(m.normketten, null, 2)}
          </pre>
        </details>
      )}

      {/* Ohne Schreibrecht sind die Bewertungsfelder inaktiv. `fieldset disabled`
          deckt alle enthaltenen Eingaben ab — der Schutz sitzt ohnehin in den
          Server Actions, das hier verhindert nur die vergebliche Eingabe. */}
      <fieldset disabled={!canWrite} className="contents">
        <div className="grid grid-cols-2 gap-2">
          <Select
            label="Governance"
            value={gov}
            onChange={setGov}
            options={[
              ['', '—'],
              ['FP', GOV_LABEL.FP],
              ['FF', GOV_LABEL.FF],
              ['IN', GOV_LABEL.IN],
            ]}
          />
          <Select
            label="Prüf-Status"
            value={status}
            onChange={(v) => setStatus(v as MarkingDTO['status'])}
            options={(['OFFEN', 'IN_PRUEFUNG', 'KONTROLLIERT', 'AKZEPTIERT'] as const).map((s) => [
              s,
              STATUS_LABEL[s],
            ])}
          />
          <Select
            label="Schadensintensität"
            value={intens}
            onChange={setIntens}
            options={[
              ['', '—'],
              ['NIEDRIG', 'Niedrig'],
              ['MITTEL', 'Mittel'],
              ['HOCH', 'Hoch'],
            ]}
          />
          <Select
            label="Wahrscheinlichkeit"
            value={wk}
            onChange={setWk}
            options={[
              ['', '—'],
              ['SELTEN', 'Selten'],
              ['MOEGLICH', 'Möglich'],
              ['WAHRSCHEINLICH', 'Wahrscheinlich'],
              ['HAEUFIG', 'Häufig'],
            ]}
          />
          <label className="text-xs">
            <span className="text-muted">Kaskadenreichweite</span>
            <input
              type="number"
              min={0}
              max={99}
              value={kask}
              onChange={(e) => setKask(e.target.value)}
              className="mt-0.5 w-full rounded border border-default bg-surface px-2 py-1"
            />
          </label>
          <Select
            label="Verantwortlich"
            value={verantw}
            onChange={setVerantw}
            options={[
              ['', '—'],
              ...staffOptions.map((s) => [s.id, s.fullName] as [string, string]),
            ]}
          />
        </div>

        <label className="block text-xs">
          <span className="text-muted">Label / Kategorie</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="z. B. kritisch, offen, Mandantenfrage"
            className="mt-0.5 w-full rounded border border-default bg-surface px-2 py-1"
          />
        </label>
        <label className="block text-xs">
          <span className="text-muted">Kontrolle / Maßnahme</span>
          <textarea
            value={kontrolle}
            onChange={(e) => setKontrolle(e.target.value)}
            rows={2}
            className="mt-0.5 w-full rounded border border-default bg-surface px-2 py-1"
          />
        </label>
        <label className="block text-xs">
          <span className="text-muted">Notiz</span>
          <textarea
            value={notiz}
            onChange={(e) => setNotiz(e.target.value)}
            rows={2}
            className="mt-0.5 w-full rounded border border-default bg-surface px-2 py-1"
          />
        </label>
      </fieldset>

      {results.length > 0 && (
        <ResearchReviewSection
          results={results}
          clientId={clientId}
          analysisId={analysisId}
          markingId={m.id}
          canReview={canWrite || isAssignee}
          canShelve={canWrite}
          pending={pending}
          start={start}
          onChanged={onChanged}
          flash={flash}
        />
      )}

      <div className="flex flex-wrap gap-2">
        {canWrite && (
          <>
            <button type="button" onClick={save} disabled={pending} className="btn-primary text-xs">
              <Save className="h-3.5 w-3.5" /> Speichern
            </button>
            <DelegateToggleButton
              delegation={m.delegation}
              onClick={() => setShowDelegate((v) => !v)}
            />
          </>
        )}
        {/* Recherche ist die Aufgabe der zugewiesenen Person — der einzige
            schreibende Weg, der ihr offensteht. */}
        {(canWrite || isAssignee) && (
          <button
            type="button"
            onClick={() => setShowResearch((v) => !v)}
            className="btn-secondary text-xs"
          >
            <Webhook className="h-3.5 w-3.5" /> An n8n
          </button>
        )}
        {canWrite && (
          <>
            <button
              type="button"
              onClick={() => setShowDefine((v) => !v)}
              disabled={!engineConfigured}
              className="btn-secondary text-xs"
            >
              <BookPlus className="h-3.5 w-3.5" /> Definieren
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={pending}
              className="text-red-700 hover:text-red-800 text-xs inline-flex items-center gap-1"
            >
              <Trash2 className="h-3.5 w-3.5" /> Löschen
            </button>
          </>
        )}
        {!canWrite && !isAssignee && (
          <span className="text-xs text-muted">
            Leseansicht — Bearbeitung durch zuständige Berufsträger.
          </span>
        )}
      </div>

      <DelegateFormSlot
        show={showDelegate}
        delegation={m.delegation}
        clientId={clientId}
        analysisId={analysisId}
        markingId={m.id}
        staffOptions={staffOptions}
        pending={pending}
        start={start}
        onDone={(r) => {
          flash(r, 'An Mitarbeiter zugewiesen — Wiedervorlage angelegt.');
          if (r.ok) {
            setShowDelegate(false);
            onChanged();
          }
        }}
      />
      {showResearch && (
        <ResearchComposer
          clientId={clientId}
          analysisId={analysisId}
          markingId={m.id}
          pending={pending}
          start={start}
          onClose={() => setShowResearch(false)}
          onDone={(r) => {
            flash(r, 'Anonymisierter Auftrag an n8n gesendet.');
            if (r.ok) setShowResearch(false);
          }}
        />
      )}
      {showDefine && (
        <DefineForm
          clientId={clientId}
          analysisId={analysisId}
          markingId={m.id}
          begriff={m.begriff}
          normAnker={m.normAnker}
          pending={pending}
          start={start}
          onDone={(r) => {
            flash(r, 'Definition an den Katalog übergeben.');
            if (r.ok) {
              setShowDefine(false);
              onChanged();
            }
          }}
        />
      )}
    </div>
  );
}

function delegationIsOpen(delegation: MarkingDTO['delegation']): boolean {
  return delegation != null && delegation.doneAt == null;
}

function DelegationStatus(props: {
  delegation: MarkingDTO['delegation'];
  verantwortlichId: string | null;
  staffOptions: Array<{ id: string; fullName: string }>;
  canDefine: boolean;
  onDefine: () => void;
}) {
  if (!props.delegation) return null;
  const open = delegationIsOpen(props.delegation);
  const responsibleName = props.staffOptions.find(
    (staff) => staff.id === props.verantwortlichId,
  )?.fullName;
  return (
    <div
      className={
        open
          ? 'rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/25 p-3 text-xs text-amber-950 dark:text-amber-100'
          : 'rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/25 p-3 text-xs text-emerald-950 dark:text-emerald-100'
      }
    >
      <p className="font-medium inline-flex items-center gap-1.5">
        <CalendarClock className="h-3.5 w-3.5" />
        {open ? 'Recherche delegiert — Antwort ausstehend' : 'Delegation erledigt'}
      </p>
      <p className="mt-1 opacity-90">
        {responsibleName ? `Zuständig: ${responsibleName} · ` : ''}
        Fällig am {fmtDateShort(new Date(props.delegation.dueDate))}.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Link
          href={`/staff/reminders/${props.delegation.reminderId}`}
          className="font-medium underline underline-offset-2 inline-flex items-center gap-1"
        >
          Wiedervorlage öffnen <ArrowRight className="h-3 w-3" />
        </Link>
        {props.canDefine && (
          <button
            type="button"
            onClick={props.onDefine}
            className="font-medium underline underline-offset-2"
          >
            Definition direkt anlegen
          </button>
        )}
      </div>
    </div>
  );
}

function DelegateToggleButton(props: {
  delegation: MarkingDTO['delegation'];
  onClick: () => void;
}) {
  if (delegationIsOpen(props.delegation)) return null;
  return (
    <button type="button" onClick={props.onClick} className="btn-secondary text-xs">
      <Send className="h-3.5 w-3.5" /> Zuweisen
    </button>
  );
}

function DelegateFormSlot(
  props: Parameters<typeof DelegateForm>[0] & {
    show: boolean;
    delegation: MarkingDTO['delegation'];
  },
) {
  if (!props.show || delegationIsOpen(props.delegation)) return null;
  const { show: _show, delegation: _delegation, ...delegateProps } = props;
  return <DelegateForm {...delegateProps} />;
}

export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="text-xs">
      <span className="text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full rounded border border-default bg-surface px-2 py-1"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function DelegateForm(props: {
  clientId: string;
  analysisId: string;
  markingId: string;
  staffOptions: Array<{ id: string; fullName: string }>;
  pending: boolean;
  start: (cb: () => void) => void;
  onDone: (r: { ok: boolean; error?: string }) => void;
}) {
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const [notes, setNotes] = useState('');
  function submit() {
    if (!assignee) {
      props.onDone({ ok: false, error: 'Bitte einen Mitarbeiter wählen.' });
      return;
    }
    props.start(async () => {
      const r = await delegateAction({
        clientId: props.clientId,
        analysisId: props.analysisId,
        markingId: props.markingId,
        assigneeStaffId: assignee,
        dueDate: due || undefined,
        notes: notes || undefined,
      });
      props.onDone(r);
    });
  }
  return (
    <div className="rounded-md border border-default p-2 space-y-2 bg-gray-50/50 dark:bg-gray-900/30">
      <p className="text-xs font-medium text-secondary">Recherche delegieren (Wiedervorlage)</p>
      <select
        value={assignee}
        onChange={(e) => setAssignee(e.target.value)}
        className="w-full rounded border border-default bg-surface px-2 py-1 text-xs"
      >
        <option value="">Mitarbeiter wählen …</option>
        {props.staffOptions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.fullName}
          </option>
        ))}
      </select>
      <input
        type="date"
        value={due}
        onChange={(e) => setDue(e.target.value)}
        className="w-full rounded border border-default bg-surface px-2 py-1 text-xs"
      />
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        placeholder="Zusatz (optional)"
        className="w-full rounded border border-default bg-surface px-2 py-1 text-xs"
      />
      <button
        type="button"
        onClick={submit}
        disabled={props.pending}
        className="btn-primary text-xs w-full justify-center"
      >
        <Send className="h-3.5 w-3.5" /> Delegieren
      </button>
    </div>
  );
}

function DefineForm(props: {
  clientId: string;
  analysisId: string;
  markingId: string;
  begriff: string;
  normAnker: string[];
  pending: boolean;
  start: (cb: () => void) => void;
  onDone: (r: { ok: boolean; error?: string }) => void;
}) {
  const [begriff, setBegriff] = useState(props.begriff);
  const [definition, setDefinition] = useState('');
  function submit() {
    if (!definition.trim()) {
      props.onDone({ ok: false, error: 'Bitte eine Definition eingeben.' });
      return;
    }
    props.start(async () => {
      const r = await pushDefinitionAction({
        clientId: props.clientId,
        analysisId: props.analysisId,
        markingId: props.markingId,
        begriff: begriff.trim(),
        definition: definition.trim(),
        normAnker: props.normAnker,
      });
      props.onDone(r);
    });
  }
  return (
    <div className="rounded-md border border-default p-2 space-y-2 bg-gray-50/50 dark:bg-gray-900/30">
      <p className="text-xs font-medium text-secondary">Begriff in den Katalog definieren</p>
      <input
        value={begriff}
        onChange={(e) => setBegriff(e.target.value)}
        className="w-full rounded border border-default bg-surface px-2 py-1 text-xs"
      />
      <textarea
        value={definition}
        onChange={(e) => setDefinition(e.target.value)}
        rows={3}
        placeholder="Definition / Subsumtion …"
        className="w-full rounded border border-default bg-surface px-2 py-1 text-xs"
      />
      <button
        type="button"
        onClick={submit}
        disabled={props.pending}
        className="btn-primary text-xs w-full justify-center"
      >
        <BookPlus className="h-3.5 w-3.5" /> An Katalog senden
      </button>
    </div>
  );
}
