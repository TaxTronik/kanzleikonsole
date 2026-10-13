// @vitest-environment jsdom
// Fachkatalog: RISK-EXTERNAL-ANONYMIZATION-001
//
// Subsumtions-Workspace: vier Ansichten über die URL, Recherche-Hub nur in der
// Recherche-Ansicht sichtbar, Fall-Recherche (anonymisierter Auftrag) über den
// Composer, Bearbeitbarkeit aus Archivstatus und Schreibrecht. Render- und
// Klicktest in jsdom (B-08, Welle 15); ersetzt die Quelltextprüfung aus
// presentation-extraction.test.ts. Die Kindkomponenten sind Attrappen, die
// ihre Props protokollieren.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { forwardRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisDTO } from '../_ui';

const h = vi.hoisted(() => ({
  router: { refresh: vi.fn() },
  documentProps: [] as Array<{ canEdit: boolean }>,
  composerProps: [] as Array<{ analysisId: string; markingId: string | null }>,
}));

vi.mock('next/navigation', () => ({ useRouter: () => h.router }));
vi.mock('@/components/ui/modal', () => ({ confirmDialog: vi.fn() }));
vi.mock('../actions', () => ({
  requestLlmAction: vi.fn(),
  archiveAnalysisAction: vi.fn(),
  reformatAnalysisAction: vi.fn(),
  reanalyzeAction: vi.fn(),
  setAnalysisVertraulichAction: vi.fn(),
}));
vi.mock('../use-subsumtion-llm', () => ({
  useSubsumtionLlm: () => ({
    llm: null,
    pollLlm: false,
    llmJobState: null,
    llmWorkerAvailable: true,
    llmFailed: false,
    setLlmFailed: vi.fn(),
    highlightLlm: false,
    setHighlightLlm: vi.fn(),
    beginLlmRun: vi.fn(),
    stopLlmRun: vi.fn(),
  }),
}));
vi.mock('../subsumtion-review-controls', () => ({
  SubsumtionReviewControls: ({ onToggleCaseResearch }: { onToggleCaseResearch: () => void }) => (
    <button type="button" onClick={onToggleCaseResearch}>
      Fall recherchieren
    </button>
  ),
  SubsumtionLlmFeedback: () => null,
}));
vi.mock('../research-view', () => ({
  ResearchView: () => <p>Recherche-Hub</p>,
}));
vi.mock('../research-composer', () => ({
  ResearchComposer: (props: { analysisId: string; markingId: string | null }) => {
    h.composerProps.push(props);
    return <p>Fall-Composer</p>;
  },
}));
vi.mock('../subsumtion-document', () => ({
  SubsumtionDocument: forwardRef(function SubsumtionDocument(props: { canEdit: boolean }, _ref) {
    h.documentProps.push(props);
    return <p>Sachverhalt</p>;
  }),
}));
vi.mock('../subsumtion-compose', () => ({ SubsumtionCompose: () => null }));
vi.mock('../subsumtion-selection-panel', () => ({ SubsumtionSelectionPanel: () => null }));
vi.mock('../marking-list', () => ({ MarkingList: () => null }));
vi.mock('../stats-bar', () => ({ StatsBar: () => null }));
vi.mock('../disclaimer-banner', () => ({ DisclaimerBanner: () => null }));
vi.mock('../herkunft-legende', () => ({ HerkunftLegende: () => null }));

import { SubsumtionWorkspace } from '../subsumtion-workspace';

const ANALYSIS: AnalysisDTO = {
  id: 'analysis-1',
  sourceText: 'Der Mandant vermietet eine Wohnung.',
  title: 'Vermietung',
  textHash: 'hash-1',
  sourceDoc: null,
  vertraulich: false,
  verdeckt: false,
  llmEnrichedAt: null,
  archivedAt: null,
  markings: [],
} as unknown as AnalysisDTO;

function renderWorkspace(overrides: { archivedAt?: string | null; canWrite?: boolean } = {}) {
  return render(
    <SubsumtionWorkspace
      clientId="client-1"
      staffOptions={[]}
      clientDocuments={[]}
      engineConfigured
      canWrite={overrides.canWrite ?? true}
      initial={{ ...ANALYSIS, archivedAt: overrides.archivedAt ?? null }}
      aufgaben={<p>Aufgaben-Inhalt</p>}
      aktenregal={<p>Aktenregal-Inhalt</p>}
    />,
  );
}

/** Nächster Container, der per CSS-Klasse ein- oder ausgeblendet wird. */
function hidden(text: string): boolean {
  return screen.getByText(text).closest('.hidden') !== null;
}

function active(name: RegExp): boolean {
  return screen.getByRole('button', { name }).classList.contains('bg-brand-600');
}

beforeEach(() => {
  h.documentProps.length = 0;
  h.composerProps.length = 0;
  window.history.replaceState(null, '', '/staff/clients/client-1/subsumtion/analysis-1');
});

describe('RISK-EXTERNAL-ANONYMIZATION-001: Workspace mit vier Ansichten', () => {
  it('schaltet Subsumtion, Recherche, Aufgaben und Aktenregal über die URL um', () => {
    renderWorkspace();
    expect(active(/^Subsumtion$/)).toBe(true);
    expect(hidden('Sachverhalt')).toBe(false);
    expect(hidden('Recherche-Hub')).toBe(true);
    expect(hidden('Aufgaben-Inhalt')).toBe(true);
    expect(hidden('Aktenregal-Inhalt')).toBe(true);

    for (const [name, content, param] of [
      [/Recherche/, 'Recherche-Hub', 'recherche'],
      [/Aufgaben/, 'Aufgaben-Inhalt', 'aufgaben'],
      [/Aktenregal/, 'Aktenregal-Inhalt', 'aktenregal'],
    ] as const) {
      act(() => {
        fireEvent.click(screen.getByRole('button', { name }));
      });
      expect(new URL(window.location.href).searchParams.get('view')).toBe(param);
      expect(active(name)).toBe(true);
      expect(active(/^Subsumtion$/)).toBe(false);
      expect(hidden(content)).toBe(false);
      expect(hidden('Sachverhalt')).toBe(true);
    }

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /^Subsumtion$/ }));
    });
    expect(new URL(window.location.href).searchParams.has('view')).toBe(false);
    expect(hidden('Sachverhalt')).toBe(false);
    expect(hidden('Recherche-Hub')).toBe(true);
  });

  it('öffnet die Fall-Recherche als anonymisierten Auftrag ohne Markierungsbezug', () => {
    renderWorkspace();
    expect(screen.queryByText('Fall-Composer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fall recherchieren' }));
    expect(screen.getByText('Fall-Composer')).toBeTruthy();
    expect(h.composerProps.at(-1)).toMatchObject({ analysisId: 'analysis-1', markingId: null });
  });

  it('bearbeitet nur nicht archivierte Analysen mit Schreibrecht', () => {
    const editable = renderWorkspace();
    expect(h.documentProps.at(-1)!.canEdit).toBe(true);
    editable.unmount();

    const archived = renderWorkspace({ archivedAt: '2026-10-01T08:00:00.000Z' });
    expect(h.documentProps.at(-1)!.canEdit).toBe(false);
    archived.unmount();

    renderWorkspace({ canWrite: false });
    expect(h.documentProps.at(-1)!.canEdit).toBe(false);
  });
});
