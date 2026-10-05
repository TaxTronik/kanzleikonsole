// Fachkatalog: WORKFLOW-LIFECYCLE-001.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('../item-row', () => ({ WorkflowItemRow: () => <li /> }));
vi.mock('../cancel-button', () => ({ CancelWorkflowButton: () => <button>Abbrechen</button> }));
vi.mock('../delete-button', () => ({ DeleteWorkflowButton: () => null }));
vi.mock('../pause-restore-buttons', () => ({
  PauseWorkflowButton: () => <button>Pausieren</button>,
  ResumeWorkflowButton: () => <button>Fortsetzen</button>,
  RestoreWorkflowButton: () => null,
}));
vi.mock('../add-step-form', () => ({ AddStepForm: () => null }));
vi.mock('../team-editor', () => ({ TeamEditorButton: () => null }));

import { WorkflowSection } from '../workflow-section';

function instance(pausedUntil: Date | null) {
  return {
    id: 'instance-1',
    name: 'Jahresabschluss 2025',
    status: 'PAUSED',
    pausedUntil,
    startedAt: new Date('2026-09-01T00:00:00Z'),
    startedByStaff: 'staff-1',
    items: [],
    members: [],
  };
}

function render(pausedUntil: Date | null) {
  return renderToStaticMarkup(
    <WorkflowSection
      clientId="client-1"
      instances={[instance(pausedUntil)] as never}
      staffList={[]}
      formTemplates={[]}
      requestTemplates={[]}
      emailTemplates={[]}
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T08:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('F-13 WorkflowSection without render-time resume', () => {
  it('shows an elapsed pause as pending automatic resumption, still resumable by hand', () => {
    const html = render(new Date('2026-10-05T00:00:00Z'));
    expect(html).toContain('Pause abgelaufen – wird automatisch fortgesetzt');
    expect(html).not.toContain('pausiert bis');
    expect(html).toContain('Fortsetzen');
  });

  it('keeps showing a running pause with its date', () => {
    expect(render(new Date('2026-10-20T00:00:00Z'))).toContain('pausiert bis');
    expect(render(null)).not.toContain('Pause abgelaufen');
  });
});
