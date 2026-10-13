// @vitest-environment jsdom
// n8n-Routeneditor: Titel und Vorbelegung sind reine Darstellung des Entwurfs,
// Speichern läuft über das Formular, die Test-URL wird für Fach-Events und
// eigene Workflow-Schritt-Events Pflicht. Render- und Klicktest in jsdom
// (B-08, Welle 15); ersetzt die Quelltextprüfung aus
// presentation-extraction.test.ts.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type FormEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { N8N_EVENT_CATALOG } from '@taxtronik/n8n-shared';

import { EMPTY_ROUTE, RouteEditorSection, type RouteDraft } from '../route-editor-section';

const h = vi.hoisted(() => ({
  setRouteDraft: vi.fn(),
  setCustomEvent: vi.fn(),
  onSaveRoute: vi.fn(),
}));

function Harness({ initial }: { initial: RouteDraft }) {
  const [routeDraft, setRouteDraftState] = useState(initial);
  const [customEvent, setCustomEventState] = useState('');
  return (
    <RouteEditorSection
      endpoints={[]}
      connectionActive
      events={N8N_EVENT_CATALOG}
      routeDraft={routeDraft}
      setRouteDraft={(next) => {
        h.setRouteDraft(next);
        setRouteDraftState(next);
      }}
      customEvent={customEvent}
      setCustomEvent={(next) => {
        h.setCustomEvent(next);
        setCustomEventState(next);
      }}
      routeResult={null}
      testResult={{}}
      busy={false}
      saving={false}
      onSaveRoute={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        h.onSaveRoute(routeDraft);
      }}
      onEditRoute={vi.fn()}
      onDeleteRoute={vi.fn()}
      onTestRoute={vi.fn()}
      onToggleRoute={vi.fn()}
    />
  );
}

function testUrlInput(): HTMLInputElement {
  return screen.getByLabelText(/^Separate Test-URL/) as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('n8n-Routeneditor', () => {
  it('benennt den Editor nach dem Entwurf, ohne beim Rendern den Entwurf zu ändern', () => {
    const { unmount } = render(<Harness initial={{ ...EMPTY_ROUTE, id: 'endpoint-1' }} />);
    expect(screen.getByRole('dialog', { name: 'Route bearbeiten' })).toBeTruthy();
    unmount();

    const discovered = render(
      <Harness
        initial={{ ...EMPTY_ROUTE, workflowId: 'wf-9', workflowName: 'TaxTronik Mandanten' }}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Erkannte Route übernehmen' });
    expect(within(dialog).getByText(/Aus der Webhook-Erkennung übernommen/)).toBeTruthy();
    discovered.unmount();

    // Auch ein nur benannter oder nur mit URL vorbefüllter Entwurf öffnet den Editor.
    for (const initial of [
      { ...EMPTY_ROUTE, name: 'Mein Workflow' },
      { ...EMPTY_ROUTE, productionUrl: 'https://n8n.kanzlei.example/webhook/x' },
    ]) {
      const view = render(<Harness initial={initial} />);
      expect(screen.getByRole('dialog', { name: 'Eigene Workflow-Route hinzufügen' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Neue leere Route' })).toBeTruthy();
      view.unmount();
    }
    expect(h.setRouteDraft).not.toHaveBeenCalled();
    expect(h.setCustomEvent).not.toHaveBeenCalled();
  });

  it('öffnet einen leeren Editor nur auf Wunsch und speichert über das Formular', () => {
    render(<Harness initial={EMPTY_ROUTE} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Route anlegen' }));
    const dialog = screen.getByRole('dialog', { name: 'Eigene Workflow-Route hinzufügen' });
    expect(within(dialog).queryByRole('button', { name: 'Neue leere Route' })).toBeNull();

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Mein Workflow' } });
    fireEvent.submit(dialog.querySelector('form#n8n-route-editor')!);
    expect(h.onSaveRoute).toHaveBeenCalledWith(expect.objectContaining({ name: 'Mein Workflow' }));
  });

  it('verlangt die Test-URL für Fach-Events und eigene Schritt-Events, nicht für den Ping', () => {
    const ping = render(
      <Harness initial={{ ...EMPTY_ROUTE, name: 'Ping', events: ['taxtronik.ping'] }} />,
    );
    expect(testUrlInput().required).toBe(false);
    expect(screen.getByText(/\(optional für reinen Verbindungstest\)/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^Weiteres Workflow-Schritt-Event/), {
      target: { value: 'workflow.step.freigabe' },
    });
    expect(testUrlInput().required).toBe(true);
    expect(screen.getByText(/\(erforderlich\)/)).toBeTruthy();
    ping.unmount();

    render(<Harness initial={{ ...EMPTY_ROUTE, name: 'Mandanten', events: ['client.created'] }} />);
    expect(testUrlInput().required).toBe(true);
  });

  it('setzt einen vorbefüllten Entwurf auf eine leere Route zurück', () => {
    render(<Harness initial={{ ...EMPTY_ROUTE, workflowId: 'wf-9', workflowName: 'Mandanten' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Neue leere Route' }));
    expect(h.setRouteDraft).toHaveBeenCalledWith(EMPTY_ROUTE);
    expect(h.setCustomEvent).toHaveBeenCalledWith('');
  });
});
