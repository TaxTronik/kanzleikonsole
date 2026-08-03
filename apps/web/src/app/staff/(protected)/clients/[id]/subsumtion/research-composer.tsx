'use client';

// =============================================================================
// Rechercheauftrag an n8n (anonymisiert): Sachverhalts-Auswahl, Prompt-Vorlagen,
// anonymisierte Vorschau, Senden. Modal im Body-Portal.
//
// Aus marking-panel.tsx herausgeloest (mechanisch, identische Props).
// =============================================================================

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookmarkPlus, Eye, Loader2, Save, Send, Trash2, Webhook, X } from 'lucide-react';
import {
  previewResearchAction,
  sendResearchAction,
  listPromptTemplatesAction,
  createPromptTemplateAction,
  deletePromptTemplateAction,
} from './research-actions';
import type { PromptTemplateDTO } from '@/server/risk';
import { useDialogA11y } from '@/components/ui/modal';

export function ResearchComposer(props: {
  clientId: string;
  analysisId: string;
  markingId?: string | null;
  pending: boolean;
  start: (cb: () => void) => void;
  onDone: (r: { ok: boolean; error?: string }) => void;
  onClose: () => void;
}) {
  // Standard ist immer ein eigener, auf die Recherche reduzierter Sachverhalt.
  // Der vollständige Hauptsachverhalt wird nur nach bewusster Auswahl gesendet.
  const isCase = !props.markingId;
  const [sachverhalt, setSachverhalt] = useState<'custom' | 'excerpt' | 'full'>('custom');
  const [title, setTitle] = useState('');
  const [snippet, setSnippet] = useState('');
  const [prompt, setPrompt] = useState('');
  const [preview, setPreview] = useState<{
    text: string;
    prompt: string | null;
    hits: number;
  } | null>(null);
  const [finalText, setFinalText] = useState('');
  const [finalPrompt, setFinalPrompt] = useState<string | null>(null);
  // Portal-SSR-Guard: das Modal rendert in document.body (Client-only).
  const [mounted, setMounted] = useState(false);

  // Prompt-Vorlagen (kanzleiweit)
  const [templates, setTemplates] = useState<PromptTemplateDTO[]>([]);
  const [selectedTpl, setSelectedTpl] = useState('');
  const [showSave, setShowSave] = useState(false);
  const [tplTitle, setTplTitle] = useState('');

  useEffect(() => {
    let active = true;
    listPromptTemplatesAction({ clientId: props.clientId }).then((r) => {
      if (active && r.ok) setTemplates(r.templates);
    });
    return () => {
      active = false;
    };
  }, [props.clientId]);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Jede Änderung der Eingaben macht eine bestehende Vorschau ungültig → schließen
  // (sonst zeigte/sendete die Box veralteten Text, z. B. den SV nach Toggle auf „nur Prompt").
  function resetPreview() {
    setPreview(null);
    setFinalText('');
    setFinalPrompt(null);
  }

  function applyTemplate(id: string) {
    setSelectedTpl(id);
    const t = templates.find((x) => x.id === id);
    if (t) setPrompt(t.body);
    resetPreview();
  }
  function saveTemplate() {
    if (!tplTitle.trim() || !prompt.trim()) return;
    props.start(async () => {
      const r = await createPromptTemplateAction({
        clientId: props.clientId,
        title: tplTitle.trim(),
        body: prompt.trim(),
      });
      if (!r.ok) {
        props.onDone(r);
        return;
      }
      setTemplates((prev) => [...prev, r.template].sort((a, b) => a.title.localeCompare(b.title)));
      setSelectedTpl(r.template.id);
      setShowSave(false);
      setTplTitle('');
    });
  }
  function deleteTemplate() {
    if (!selectedTpl || !window.confirm('Diese Prompt-Vorlage löschen?')) return;
    const id = selectedTpl;
    props.start(async () => {
      const r = await deletePromptTemplateAction({ clientId: props.clientId, id });
      if (!r.ok) {
        props.onDone(r);
        return;
      }
      setTemplates((prev) => prev.filter((x) => x.id !== id));
      setSelectedTpl('');
    });
  }

  const baseInput = () => ({
    clientId: props.clientId,
    analysisId: props.analysisId,
    markingId: props.markingId ?? null,
    title: title.trim() || null,
    sachverhalt,
    snippets: sachverhalt === 'custom' && snippet.trim() ? [snippet.trim()] : [],
    prompt: prompt.trim() || null,
  });

  function doPreview() {
    props.start(async () => {
      const r = await previewResearchAction(baseInput());
      if (!r.ok) {
        props.onDone(r);
        return;
      }
      setPreview({
        text: r.anonymizedText,
        prompt: r.anonymizedPrompt,
        hits: r.heuristicHits.length,
      });
      setFinalText(r.anonymizedText);
      setFinalPrompt(r.anonymizedPrompt);
    });
  }
  function doSend() {
    props.start(async () => {
      const r = await sendResearchAction({ ...baseInput(), finalText, finalPrompt });
      props.onDone(r.ok ? { ok: true } : r);
      if (r.ok) setPreview(null);
    });
  }

  const field = 'w-full rounded border border-default bg-surface px-3 py-2 text-sm';
  const dialogRef = useDialogA11y(props.onClose);

  const modal = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={props.onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Rechercheauftrag an n8n"
        className="relative z-10 w-full max-w-2xl max-h-[90vh] overflow-y-auto card p-5 space-y-3 shadow-xl"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-primary inline-flex items-center gap-1">
            <Webhook className="h-4 w-4" /> Rechercheauftrag an n8n (anonymisiert)
          </p>
          <button
            type="button"
            onClick={props.onClose}
            className="text-disabled hover:text-secondary"
            title="Schließen"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="block text-xs">
          <span className="text-muted">Titel der Recherche</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="Leer lassen für „Recherche vom [Datum], [Uhrzeit]“"
            className={'mt-0.5 ' + field}
          />
        </label>

        <label className="block text-xs">
          <span className="text-muted">Grundlage der Anfrage</span>
          <select
            value={sachverhalt}
            onChange={(e) => {
              setSachverhalt(e.target.value as 'custom' | 'excerpt' | 'full');
              resetPreview();
            }}
            className={'mt-0.5 ' + field}
          >
            <option value="custom">
              Eigener Recherche-Sachverhalt — vollständigen Sachverhalt nicht senden
            </option>
            {!isCase && <option value="excerpt">Auszug um die Fundstelle</option>}
            <option value="full">Vollständiger Sachverhalt</option>
          </select>
        </label>
        {sachverhalt === 'full' && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Der gesamte Sachverhalt wird anonymisiert — bitte die Vorschau besonders sorgfältig
            prüfen.
          </p>
        )}

        {sachverhalt === 'custom' && (
          <label className="block text-xs">
            <span className="text-muted">Sachverhalt für diese Recherche</span>
            <textarea
              value={snippet}
              onChange={(e) => {
                setSnippet(e.target.value);
                resetPreview();
              }}
              rows={5}
              placeholder="Nur die für diese Recherche erforderlichen Fakten eingeben …"
              className={'mt-0.5 ' + field}
            />
            <span className="mt-1 block text-disabled">
              Dieser Text ersetzt den vollständigen Sachverhalt und wird anonymisiert übermittelt.
            </span>
          </label>
        )}

        {/* Prompt-Vorlagen + Auftrag/Notizen */}
        <div className="space-y-1.5">
          <p className="text-xs text-muted">Rechercheauftrag, Notizen und Hinweise</p>
          <div className="flex items-center gap-2">
            <select
              value={selectedTpl}
              onChange={(e) => applyTemplate(e.target.value)}
              className={'flex-1 ' + field}
              title="Gespeicherte Prompt-Vorlage wählen"
            >
              <option value="">— Prompt-Vorlage wählen —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            {selectedTpl && (
              <button
                type="button"
                onClick={deleteTemplate}
                disabled={props.pending}
                className="text-red-600 hover:text-red-700 p-1.5"
                title="Gewählte Vorlage löschen"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowSave((s) => !s)}
              disabled={!prompt.trim()}
              className="btn-secondary text-xs whitespace-nowrap"
              title="Aktuellen Prompt als kanzleiweite Vorlage speichern"
            >
              <BookmarkPlus className="h-3.5 w-3.5" /> Als Vorlage
            </button>
          </div>
          {showSave && (
            <div className="flex items-center gap-2">
              <input
                value={tplTitle}
                onChange={(e) => setTplTitle(e.target.value)}
                placeholder="Titel der Vorlage (z. B. „Verrechnungspreis-Angemessenheit“)"
                className={'flex-1 ' + field}
              />
              <button
                type="button"
                onClick={saveTemplate}
                disabled={props.pending || !tplTitle.trim() || !prompt.trim()}
                className="btn-primary text-xs whitespace-nowrap"
              >
                <Save className="h-3.5 w-3.5" /> Speichern
              </button>
            </div>
          )}
          <textarea
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              setSelectedTpl('');
              resetPreview();
            }}
            rows={5}
            placeholder="Konkrete Recherchefrage sowie optionale Notizen und Hinweise …"
            className={field}
          />
        </div>

        {!preview ? (
          <button
            type="button"
            onClick={doPreview}
            disabled={props.pending || (sachverhalt === 'custom' && !snippet.trim())}
            className="btn-secondary text-sm w-full justify-center"
          >
            {props.pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Eye className="h-4 w-4" />
            )}{' '}
            Anonymisierte Vorschau
          </button>
        ) : (
          <div className="space-y-1.5">
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Vorschau — diese anonymisierten Felder gehen getrennt an n8n.{' '}
              {preview.hits > 0
                ? `${preview.hits} heuristische Schwärzung(en) — bitte prüfen.`
                : 'Editierbar.'}
            </p>
            <textarea
              value={finalText}
              onChange={(e) => setFinalText(e.target.value)}
              rows={14}
              className={field + ' font-mono'}
            />
            {finalPrompt !== null && (
              <label className="block text-xs">
                <span className="text-muted">Anonymisierter Auftrag, Notizen und Hinweise</span>
                <textarea
                  value={finalPrompt}
                  onChange={(e) => setFinalPrompt(e.target.value)}
                  rows={5}
                  className={'mt-0.5 ' + field + ' font-mono'}
                />
              </label>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={doSend}
                disabled={props.pending || !finalText.trim()}
                className="btn-primary text-sm flex-1 justify-center"
              >
                <Send className="h-4 w-4" /> An n8n senden
              </button>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="btn-secondary text-sm"
              >
                Zurück zum Bearbeiten
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
  // In ein Body-Portal rendern, damit das fixed-Overlay den ECHTEN Viewport
  // abdeckt — nicht einen transformierten/contained Vorfahren (sonst verrutscht
  // das Modal und der Backdrop deckt die Sidebar nicht). Muster: DocumentUploadButton.
  return mounted ? createPortal(modal, document.body) : null;
}
