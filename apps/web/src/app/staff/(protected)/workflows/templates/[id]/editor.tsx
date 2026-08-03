'use client';

import { useState, useTransition } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { saveTemplateAction } from '../../actions';
import { SortableList, DragHandle } from '@/components/sortable-list';
import { fmtTimeMedium } from '@/lib/fmt';
import {
  DOCUMENT_CLASSIFICATIONS,
  KIND_LABELS,
  KIND_DESCRIPTIONS,
  defaultConfigFor,
} from '@/lib/workflow-step-kinds';

type StepKind =
  | 'TASK'
  | 'DOCUMENT_UPLOAD'
  | 'CLIENT_REQUEST'
  | 'CLIENT_FORM'
  | 'CLIENT_EMAIL'
  | 'N8N_TRIGGER';

interface StepDraft {
  title: string;
  description: string;
  dueAfterDays: number | null;
  skillId: string;
  kind: StepKind;
  config: Record<string, unknown>;
  n8nEvent: string;
}

interface Skill {
  id: string;
  label: string;
}
interface FormTpl {
  id: string;
  name: string;
}
interface NamedTpl {
  id: string;
  name: string;
  category: string | null;
}

const ALL_KINDS: StepKind[] = [
  'TASK',
  'DOCUMENT_UPLOAD',
  'CLIENT_REQUEST',
  'CLIENT_FORM',
  'CLIENT_EMAIL',
  'N8N_TRIGGER',
];

function emptyStep(): StepDraft {
  return {
    title: '',
    description: '',
    dueAfterDays: null,
    skillId: '',
    kind: 'TASK',
    config: {},
    n8nEvent: '',
  };
}

export function TemplateEditor({
  templateId,
  initialDescription,
  initialDefaultSkillId,
  initialSteps,
  skills,
  formTemplates,
  requestTemplates,
  emailTemplates,
}: {
  templateId: string;
  initialDescription: string;
  initialDefaultSkillId: string;
  initialSteps: StepDraft[];
  skills: Skill[];
  formTemplates: FormTpl[];
  requestTemplates: NamedTpl[];
  emailTemplates: NamedTpl[];
}) {
  const [description, setDescription] = useState(initialDescription);
  const [defaultSkillId, setDefaultSkillId] = useState(initialDefaultSkillId);
  const [steps, setSteps] = useState<StepDraft[]>(
    initialSteps.length > 0 ? initialSteps : [emptyStep()],
  );
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [isPending, start] = useTransition();

  function update(i: number, patch: Partial<StepDraft>) {
    setSteps((s) => s.map((step, idx) => (idx === i ? { ...step, ...patch } : step)));
  }
  function setConfig(i: number, key: string, value: unknown) {
    setSteps((s) =>
      s.map((step, idx) =>
        idx === i ? { ...step, config: { ...step.config, [key]: value } } : step,
      ),
    );
  }
  function changeKind(i: number, kind: StepKind) {
    setSteps((s) =>
      s.map((step, idx) =>
        idx === i
          ? { ...step, kind, config: defaultConfigFor(kind) as Record<string, unknown> }
          : step,
      ),
    );
  }
  function add() {
    setSteps((s) => [...s, emptyStep()]);
  }
  function remove(i: number) {
    setSteps((s) => s.filter((_, idx) => idx !== i));
  }
  function reorder(from: number, to: number) {
    setSteps((s) => {
      const next = [...s];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  }
  function save() {
    setError(null);
    const cleaned = steps
      .map((s) => ({ ...s, title: s.title.trim() }))
      .filter((s) => s.title.length > 0);
    if (cleaned.length === 0) {
      setError('Mindestens ein Schritt mit Titel erforderlich.');
      return;
    }
    start(async () => {
      const r = await saveTemplateAction({
        templateId,
        description: description.trim() || null,
        defaultSkillId: defaultSkillId || null,
        steps: cleaned.map((s) => ({
          title: s.title,
          description: s.description.trim() || undefined,
          dueAfterDays: s.dueAfterDays,
          skillId: s.skillId || null,
          kind: s.kind,
          config: s.config,
          n8nEvent: s.n8nEvent.trim() || null,
        })),
      });
      if (!r.ok) {
        setError(r.error ?? 'Fehler beim Speichern.');
        return;
      }
      setSavedAt(Date.now());
    });
  }

  return (
    <div className="space-y-6">
      <div className="card p-6 space-y-4">
        <div>
          <label className="label" htmlFor="tpl-desc">
            Beschreibung
          </label>
          <textarea
            id="tpl-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={500}
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor="tpl-default-skill">
            Standard-Tätigkeitsbereich
          </label>
          <select
            id="tpl-default-skill"
            value={defaultSkillId}
            onChange={(e) => setDefaultSkillId(e.target.value)}
            className="input"
          >
            <option value="">— keiner —</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <SortableList
        count={steps.length}
        onReorder={reorder}
        renderItem={(i, handle) => {
          const s = steps[i]!;
          return (
            <div className="card p-4">
              <div className="flex items-start gap-3">
                <div className="flex flex-col items-center pt-1 gap-1">
                  <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-700 text-xs font-bold flex items-center justify-center">
                    {i + 1}
                  </span>
                  <DragHandle handle={handle} />
                </div>
                <div className="flex-1 space-y-3">
                  <input
                    type="text"
                    placeholder={'Titel — z. B. „Belege Q1 anfordern"'}
                    value={s.title}
                    onChange={(e) => update(i, { title: e.target.value })}
                    maxLength={200}
                    className="input font-medium"
                  />
                  <textarea
                    placeholder="Optionale Beschreibung / Hinweis"
                    value={s.description}
                    onChange={(e) => update(i, { description: e.target.value })}
                    rows={2}
                    maxLength={1000}
                    className="input text-sm"
                  />

                  {/* Kind-Picker */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-muted mb-1">Schritt-Typ</label>
                      <select
                        value={s.kind}
                        onChange={(e) => changeKind(i, e.target.value as StepKind)}
                        className="input"
                      >
                        {ALL_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {KIND_LABELS[k]}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-muted mt-1 leading-snug">
                        {KIND_DESCRIPTIONS[s.kind]}
                      </p>
                    </div>
                    <div>
                      <label className="block text-xs text-muted mb-1">Empfohlene Tätigkeit</label>
                      <select
                        value={s.skillId}
                        onChange={(e) => update(i, { skillId: e.target.value })}
                        className="input"
                      >
                        <option value="">— keine —</option>
                        {skills.map((sk) => (
                          <option key={sk.id} value={sk.id}>
                            {sk.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Kind-spezifische Felder */}
                  <KindConfigFields
                    step={s}
                    index={i}
                    setConfig={setConfig}
                    formTemplates={formTemplates}
                    requestTemplates={requestTemplates}
                    emailTemplates={emailTemplates}
                  />

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-muted mb-1">
                        Fällig nach (Tage ab Start)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={365}
                        placeholder="z. B. 7"
                        value={s.dueAfterDays ?? ''}
                        onChange={(e) =>
                          update(i, {
                            dueAfterDays:
                              e.target.value === '' ? null : Math.max(0, Number(e.target.value)),
                          })
                        }
                        className="input"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-muted mb-1">
                        n8n-Event <span className="text-disabled font-normal">(optional)</span>
                      </label>
                      <input
                        type="text"
                        placeholder="z. B. slack-notify"
                        value={s.n8nEvent}
                        onChange={(e) => update(i, { n8nEvent: e.target.value })}
                        maxLength={100}
                        className="input"
                      />
                      <p className="text-[10px] text-disabled mt-1">
                        Wird beim Ausführen als <code>workflow.step.&lt;event&gt;</code> an n8n
                        geschickt.
                      </p>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="text-disabled hover:text-red-700 p-1"
                  title="Schritt entfernen"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          );
        }}
      />

      <div className="flex items-center gap-3">
        <button type="button" onClick={add} className="btn-secondary">
          <Plus className="h-4 w-4" />
          Schritt hinzufügen
        </button>
        <button type="button" onClick={save} disabled={isPending} className="btn-primary">
          {isPending ? 'Speichert…' : 'Vorlage speichern'}
        </button>
        {savedAt && (
          <span className="text-xs text-emerald-700">
            Gespeichert um {fmtTimeMedium(new Date(savedAt))}
          </span>
        )}
      </div>
      {error && <div className="alert-error-sm">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kind-spezifische Konfig-Felder
// ---------------------------------------------------------------------------

function KindConfigFields({
  step,
  index,
  setConfig,
  formTemplates,
  requestTemplates,
  emailTemplates,
}: {
  step: StepDraft;
  index: number;
  setConfig: (i: number, key: string, value: unknown) => void;
  formTemplates: FormTpl[];
  requestTemplates: NamedTpl[];
  emailTemplates: NamedTpl[];
}) {
  const cfg = step.config;
  switch (step.kind) {
    case 'TASK':
      return null;

    case 'DOCUMENT_UPLOAD':
      return (
        <div>
          <label className="block text-xs text-muted mb-1">Erwartete Dokumenten-Klasse</label>
          <select
            value={String(cfg['expectedClassification'] ?? 'GENERAL')}
            onChange={(e) => setConfig(index, 'expectedClassification', e.target.value)}
            className="input"
          >
            {DOCUMENT_CLASSIFICATIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-disabled mt-1">
            GOBD_*-Klassen landen im Object-Lock-Bucket mit typabhängiger 6-, 8- oder 10-jähriger
            Aufbewahrung.
          </p>
        </div>
      );

    case 'CLIENT_REQUEST': {
      const requestTemplateId = String(cfg['requestTemplateId'] ?? '');
      const usingTemplate = Boolean(requestTemplateId);
      return (
        <div className="space-y-2 rounded-md border border-amber-200 dark:border-amber-900/40 bg-amber-50/30 dark:bg-amber-900/10 p-3">
          <div>
            <label className="block text-xs text-muted mb-1">
              Anforderungs-Vorlage <span className="text-disabled">(optional)</span>
            </label>
            <select
              value={requestTemplateId}
              onChange={(e) => setConfig(index, 'requestTemplateId', e.target.value || undefined)}
              className="input text-sm"
            >
              <option value="">— Inline-Felder verwenden —</option>
              {requestTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.category ? `[${t.category}] ` : ''}
                  {t.name}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-disabled mt-1">
              Wenn eine Vorlage gewählt ist, werden Titel/Beschreibung/Priorität zur Laufzeit aus
              der Vorlage gelesen — die Felder unten dienen nur als Fallback.
            </p>
          </div>
          <input
            type="text"
            placeholder='Anforderungs-Titel (z. B. „Belege Q1 hochladen")'
            value={String(cfg['requestTitle'] ?? '')}
            onChange={(e) => setConfig(index, 'requestTitle', e.target.value)}
            maxLength={200}
            className="input"
            disabled={usingTemplate}
          />
          <textarea
            placeholder="Anforderungs-Beschreibung für den Mandanten"
            value={String(cfg['requestDescription'] ?? '')}
            onChange={(e) => setConfig(index, 'requestDescription', e.target.value)}
            rows={2}
            maxLength={5000}
            className="input text-sm"
            disabled={usingTemplate}
          />
          <div className="grid grid-cols-2 gap-3">
            <select
              value={String(cfg['priority'] ?? 'NORMAL')}
              onChange={(e) => setConfig(index, 'priority', e.target.value)}
              className="input text-sm"
              disabled={usingTemplate}
            >
              <option value="LOW">Priorität: Niedrig</option>
              <option value="NORMAL">Priorität: Normal</option>
              <option value="HIGH">Priorität: Hoch</option>
              <option value="URGENT">Priorität: Dringend</option>
            </select>
            <input
              type="number"
              min={0}
              max={365}
              placeholder="Fällig nach Tagen"
              value={cfg['dueAfterDays'] != null ? String(cfg['dueAfterDays']) : ''}
              onChange={(e) =>
                setConfig(
                  index,
                  'dueAfterDays',
                  e.target.value === '' ? undefined : Number(e.target.value),
                )
              }
              className="input text-sm"
              disabled={usingTemplate}
            />
          </div>
        </div>
      );
    }

    case 'CLIENT_FORM':
      return (
        <div className="space-y-2 rounded-md border border-indigo-200 dark:border-indigo-900/40 bg-indigo-50/30 dark:bg-indigo-900/10 p-3">
          <select
            value={String(cfg['formTemplateId'] ?? '')}
            onChange={(e) => setConfig(index, 'formTemplateId', e.target.value)}
            className="input"
          >
            <option value="">— Formular auswählen —</option>
            {formTemplates.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          {formTemplates.length === 0 && (
            <p className="text-xs text-red-700">
              Keine aktiven Formulare. Erst unter „Formulare" eine Vorlage anlegen.
            </p>
          )}
          <input
            type="text"
            placeholder="Titel der erzeugten Anforderung"
            value={String(cfg['requestTitle'] ?? 'Bitte Formular ausfüllen')}
            onChange={(e) => setConfig(index, 'requestTitle', e.target.value)}
            maxLength={200}
            className="input text-sm"
          />
        </div>
      );

    case 'CLIENT_EMAIL': {
      const emailTemplateId = String(cfg['emailTemplateId'] ?? '');
      const usingTemplate = Boolean(emailTemplateId);
      return (
        <div className="space-y-2 rounded-md border border-blue-200 dark:border-blue-900/40 bg-blue-50/30 dark:bg-blue-900/10 p-3">
          <div>
            <label className="block text-xs text-muted mb-1">
              E-Mail-Vorlage <span className="text-disabled">(optional)</span>
            </label>
            <select
              value={emailTemplateId}
              onChange={(e) => setConfig(index, 'emailTemplateId', e.target.value || undefined)}
              className="input text-sm"
            >
              <option value="">— Inline-Text verwenden —</option>
              {emailTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.category ? `[${t.category}] ` : ''}
                  {t.name}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-disabled mt-1">
              Vorlagen werden zur Laufzeit gelesen — Änderungen in der Vorlage gelten sofort für
              alle Workflows. Verwalten unter <em>Admin → E-Mail-Vorlagen</em>.
            </p>
          </div>
          <input
            type="text"
            placeholder="Betreff"
            value={String(cfg['subject'] ?? '')}
            onChange={(e) => setConfig(index, 'subject', e.target.value)}
            maxLength={200}
            className="input text-sm"
            disabled={usingTemplate}
          />
          <textarea
            placeholder="Mail-Text (Markdown — geht an alle aktiven Portal-Kontakte des Mandanten)"
            value={String(cfg['bodyMd'] ?? '')}
            onChange={(e) => setConfig(index, 'bodyMd', e.target.value)}
            rows={5}
            maxLength={10_000}
            className="input text-sm font-mono"
            disabled={usingTemplate}
          />
        </div>
      );
    }

    case 'N8N_TRIGGER':
      return (
        <div className="rounded-md border border-purple-200 dark:border-purple-900/40 bg-purple-50/30 dark:bg-purple-900/10 p-3 text-xs text-purple-900 dark:text-purple-200">
          Dieser Schritt feuert ausschließlich den n8n-Event aus dem Feld unten. Setzen Sie
          „n8n-Event" auf einen Namen, der zu einem Webhook-Knoten in Ihrer n8n-Instanz passt. Tipp:
          derselbe Event kann auch zusätzlich bei anderen Step-Typen gefeuert werden.
        </div>
      );
  }
}
