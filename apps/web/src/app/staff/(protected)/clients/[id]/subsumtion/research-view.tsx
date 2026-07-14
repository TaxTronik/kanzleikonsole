'use client';

// =============================================================================
// Recherche-Hub (3. View im Subsumtions-Workspace).
//
// Eine Sicht pro Sachverhalt: freier Composer (allgemeine Frage, markingId=null),
// Outbound (gesendete Aufträge + Status) und Inbound (Ergebnisse n8n + Mitarbeiter
// mit Zuordnung — wiederverwendet ResearchResultsBlock). Keine Subsumtions-Logik.
// =============================================================================

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Webhook, Send, MessageSquarePlus } from 'lucide-react';
import { ResearchComposer } from './marking-panel';
import { ResearchResultsBlock } from './research-results-block';
import { fmtDateShort } from '@/lib/fmt';
import type { ResearchRequestDTO, ResearchResultDTO, MarkingDTO } from './_ui';

const REQ_STATUS: Record<ResearchRequestDTO['status'], { label: string; cls: string }> = {
  SENT: { label: 'Gesendet', cls: 'badge-yellow' },
  ANSWERED: { label: 'Beantwortet', cls: 'badge-green' },
  FAILED: { label: 'Fehlgeschlagen', cls: 'badge-red' },
};

export function ResearchView(props: {
  clientId: string;
  analysisId: string;
  requests: ResearchRequestDTO[];
  results: ResearchResultDTO[];
  markingsById: Record<string, MarkingDTO>;
  staffOptions: Array<{ id: string; fullName: string }>;
  engineConfigured: boolean;
  pending: boolean;
  start: (cb: () => void) => void;
  onFlash: (r: { ok: boolean; error?: string }, ok?: string) => void;
  /** Sprung in die Subsumtions-Ansicht zur betroffenen Markierung. */
  onSelectMarking: (markingId: string) => void;
}) {
  const router = useRouter();
  const [composing, setComposing] = useState(false);
  const staffById = Object.fromEntries(props.staffOptions.map((s) => [s.id, s.fullName] as const));

  return (
    <div className="space-y-4">
      {/* Freier Composer — allgemeine Frage zum Sachverhalt (markingId = null) */}
      <div className="card p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-primary inline-flex items-center gap-2">
            <Webhook className="h-4 w-4 text-disabled" /> Recherche zum Sachverhalt
          </h2>
          {!composing && (
            <button
              type="button"
              onClick={() => setComposing(true)}
              disabled={!props.engineConfigured}
              className="btn-primary text-xs"
              title={props.engineConfigured ? undefined : 'Engine nicht konfiguriert'}
            >
              <MessageSquarePlus className="h-3.5 w-3.5" /> Neue Recherche-Frage
            </button>
          )}
        </div>
        <p className="text-xs text-muted mt-1">
          Eigene/allgemeine Frage zum Sachverhalt an n8n — anonymisiert, mit editierbarer Vorschau.
          Die Antwort landet unten in der Ablage.
        </p>
        {composing && (
          <div className="mt-3">
            <ResearchComposer
              clientId={props.clientId}
              analysisId={props.analysisId}
              markingId={null}
              pending={props.pending}
              start={props.start}
              onClose={() => setComposing(false)}
              onDone={(r) => {
                props.onFlash(r, 'Anonymisierter Auftrag (ganzer Fall) an n8n gesendet.');
                if (r.ok) {
                  setComposing(false);
                  router.refresh();
                }
              }}
            />
          </div>
        )}
      </div>

      {/* Outbound — gesendete Aufträge + Status */}
      <div className="card p-4">
        <h2 className="text-sm font-medium text-primary mb-3 inline-flex items-center gap-2">
          <Send className="h-4 w-4 text-disabled" /> Gesendete Aufträge
          <span className="badge-gray text-[10px]">{props.requests.length}</span>
        </h2>
        {props.requests.length === 0 ? (
          <p className="text-xs text-muted">Noch keine Rechercheaufträge gesendet.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {props.requests.map((req) => {
              const st = REQ_STATUS[req.status];
              return (
                <li key={req.id} className="py-2.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {req.begriff && req.markingId ? (
                      <button
                        type="button"
                        onClick={() => props.onSelectMarking(req.markingId!)}
                        className="text-sm text-primary hover:underline text-left truncate block max-w-full"
                      >
                        {req.begriff}
                      </button>
                    ) : (
                      <span className="text-sm text-secondary">Ganzer Fall</span>
                    )}
                    {req.prompt && (
                      <p className="text-xs text-muted mt-0.5 line-clamp-2">{req.prompt}</p>
                    )}
                    <p className="text-[11px] text-disabled mt-0.5">
                      {staffById[req.createdById] ?? 'Mitarbeiter'} ·{' '}
                      {fmtDateShort(new Date(req.createdAt))}
                      {req.includeSachverhalt ? ' · mit Sachverhalt' : ''}
                      {req.resultCount > 0 ? ` · ${req.resultCount} Antwort(en)` : ''}
                    </p>
                  </div>
                  <span className={`${st.cls} text-[10px] shrink-0`}>{st.label}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Inbound — Ergebnisse (n8n + Mitarbeiter) + Zuordnung */}
      {props.results.length === 0 ? (
        <div className="card p-4">
          <h2 className="text-sm font-medium text-primary mb-1">Rechercheergebnisse</h2>
          <p className="text-xs text-muted">Noch keine Ergebnisse eingegangen.</p>
        </div>
      ) : (
        <ResearchResultsBlock
          clientId={props.clientId}
          analysisId={props.analysisId}
          results={props.results}
          markingsById={props.markingsById}
          pending={props.pending}
          start={props.start}
          onFlash={props.onFlash}
        />
      )}
    </div>
  );
}
