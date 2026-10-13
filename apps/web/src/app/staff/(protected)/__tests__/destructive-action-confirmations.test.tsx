// @vitest-environment jsdom
// Destruktive Staff-Aktionen als Render- und Verhaltenstest (B-08, Welle 15)
// statt Quelltextprüfung: Vollmacht widerrufen und versenden, Portal-Kontakt
// anonymisieren, Recherche archivieren bzw. endgültig löschen. Geprüft wird,
// dass erst die ausdrückliche Bestätigung im Gefahrendialog die Action
// auslöst und abgelehnte Ergebnisse sichtbar bleiben (Review-Befund F-01).
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';

const h = vi.hoisted(() => ({
  revokePoa: vi.fn(),
  sendPoa: vi.fn(),
  anonymize: vi.fn(),
  archiveResult: vi.fn(),
  deleteResult: vi.fn(),
  refresh: vi.fn(),
  row: null as unknown,
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  useRouter: () => ({ refresh: h.refresh, push: vi.fn() }),
}));
vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['ADMIN'] },
  })),
}));
vi.mock('@/server/settings/module-page', () => ({ requireModulePage: vi.fn(async () => ({})) }));
vi.mock('@/server/auth/rbac', () => ({
  canAccessClientTx: vi.fn(async () => true),
  isStaffAdmin: () => true,
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      powerOfAttorney: { findUnique: vi.fn(async () => h.row) },
      dsgvoRequest: { findUnique: vi.fn(async () => h.row) },
    }),
  ),
}));
vi.mock('@/components/document-preview', () => ({ DocumentPreviewButton: () => null }));
vi.mock('../poa/actions', () => ({
  revokePoaAction: h.revokePoa,
  sendForSignatureAction: h.sendPoa,
}));
vi.mock('../admin/dsgvo/actions', () => ({
  anonymizeContactAction: h.anonymize,
  updateStatusAction: vi.fn(),
  exportContactDataAction: vi.fn(),
}));
vi.mock('../clients/[id]/subsumtion/research-actions', () => ({
  archiveResultAction: h.archiveResult,
  deleteResultAction: h.deleteResult,
  assignResultAction: vi.fn(),
  saveResultToShelfAction: vi.fn(),
}));
vi.mock('../clients/[id]/subsumtion/research-composer', () => ({ ResearchComposer: () => null }));

import PoaDetailPage from '../poa/[id]/page';
import { RevokePoaForm, SendPoaForm } from '../poa/[id]/revoke-poa-form';
import DsgvoDetailPage from '../admin/dsgvo/[id]/page';
import { ResearchView } from '../clients/[id]/subsumtion/research-view';
import type { ResearchResultDTO } from '../clients/[id]/subsumtion/_ui';

const DANGER = '!bg-red-600';

function poaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'poa-1',
    clientId: 'client-1',
    client: { id: 'client-1', name: 'Muster GmbH' },
    subject: 'Vollmacht ESt 2025',
    status: 'SENT',
    signerName: 'Max Muster',
    signerEmail: 'max@mandant.example',
    scope: 'Vertretung in Steuersachen',
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validUntil: null,
    documentId: null,
    updatedAt: new Date('2026-10-01T08:00:00.000Z'),
    signedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

function dsgvoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dsgvo-1',
    type: 'ERASURE',
    subjectType: 'CLIENT_CONTACT',
    subjectRefId: 'contact-1',
    subjectName: 'Max Muster',
    subjectEmail: 'max@mandant.example',
    status: 'RECEIVED',
    description: 'Bitte löschen.',
    dueDate: null,
    receivedAt: new Date('2026-10-01T00:00:00.000Z'),
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    notes: null,
    resultDocumentId: null,
    resultPreparedAt: null,
    resultReviewedAt: null,
    resultSha256: null,
    responseSentAt: null,
    responseMethod: null,
    rejectionReason: null,
    ...overrides,
  };
}

function result(overrides: Partial<ResearchResultDTO> = {}): ResearchResultDTO {
  return {
    id: 'result-1',
    title: 'Abzugsfähigkeit Arbeitszimmer',
    requestId: null,
    requestTitle: null,
    body: 'Ergebnis',
    status: 'NEU',
    markingId: null,
    shelfDocumentId: null,
    archivedAt: null,
    source: 'n8n',
    receivedAt: '2026-10-01T08:00:00.000Z',
    suggestions: [],
    ...overrides,
  };
}

function confirmButton(dialog: HTMLElement, name: string): HTMLButtonElement {
  return within(dialog).getByRole('button', { name }) as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.row = null;
});

describe('Vollmacht widerrufen', () => {
  it('bietet auf der Detailseite Versand und Widerruf nur über die eigenen Steuerelemente an', async () => {
    h.row = poaRow();
    await renderServer(PoaDetailPage({ params: Promise.resolve({ id: 'poa-1' }) }));
    expect(screen.getByRole('button', { name: 'Erneut senden' })).toBeTruthy();
    const reason = screen.getByLabelText('Widerrufsgrund');
    // Kein Formular, das den Widerruf ohne Bestätigung direkt abschickt.
    expect(reason.closest('form')).toBeNull();
    fireEvent.change(reason, { target: { value: 'Mandat beendet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Widerrufen' }));
    expect(screen.getByRole('dialog', { name: 'Vollmacht widerrufen' })).toBeTruthy();
    expect(h.revokePoa).not.toHaveBeenCalled();
  });

  it('verlangt einen Grund mit beschriftetem Feld und AO-Hinweis', () => {
    render(<RevokePoaForm poaId="poa-1" subject="Vollmacht ESt 2025" />);
    const reason = screen.getByLabelText('Widerrufsgrund') as HTMLInputElement;
    const button = screen.getByRole('button', { name: 'Widerrufen' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(reason, { target: { value: '   ' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(reason, { target: { value: ' Mandat beendet ' } });
    expect(button.disabled).toBe(false);

    const hint = document.getElementById(reason.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toContain('§ 80 Abs. 1 Satz 3 AO');
    expect(hint.textContent).toContain('§ 80a Abs. 1 Satz 4 AO');
    expect(hint.textContent).not.toContain('§ 80 Abs. 1 S. 4 AO');
  });

  it('widerruft erst nach Bestätigung im Gefahrendialog und meldet Erfolg nur bei ok', async () => {
    render(<RevokePoaForm poaId="poa-1" subject="Vollmacht ESt 2025" />);
    fireEvent.change(screen.getByLabelText('Widerrufsgrund'), {
      target: { value: ' Mandat beendet ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Widerrufen' }));
    const dialog = screen.getByRole('dialog', { name: 'Vollmacht widerrufen' });
    expect(dialog.textContent).toContain('„Vollmacht ESt 2025“ wirklich widerrufen?');
    expect(dialog.textContent).toContain('Grund: Mandat beendet');
    const confirm = confirmButton(dialog, 'Verbindlich widerrufen');
    expect(confirm.className).toContain(DANGER);

    h.revokePoa.mockResolvedValueOnce({ ok: false, error: 'Vollmacht ist gesperrt.' });
    fireEvent.click(confirm);
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Vollmacht ist gesperrt.');
    const [previous, formData] = h.revokePoa.mock.calls[0]!;
    expect(previous).toBeNull();
    expect(Object.fromEntries(formData as FormData)).toEqual({
      poaId: 'poa-1',
      reason: 'Mandat beendet',
    });

    h.revokePoa.mockResolvedValueOnce({ ok: false });
    fireEvent.click(confirmButton(dialog, 'Verbindlich widerrufen'));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toBe(
        'Die Vollmacht konnte nicht widerrufen werden.',
      ),
    );

    h.revokePoa.mockRejectedValueOnce(new Error('Verbindung unterbrochen'));
    fireEvent.click(confirmButton(dialog, 'Verbindlich widerrufen'));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toBe('Verbindung unterbrochen'),
    );

    h.revokePoa.mockResolvedValueOnce({ ok: true });
    fireEvent.click(confirmButton(dialog, 'Verbindlich widerrufen'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('Vollmacht versenden', () => {
  async function send() {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Zur Unterschrift senden' }));
    });
  }

  it('übergibt Vollmacht und Stand an die Action und hält Fehler sichtbar', async () => {
    render(<SendPoaForm poaId="poa-1" isResend={false} expectedUpdatedAt="2026-10-01T08:00:00Z" />);
    h.sendPoa.mockResolvedValueOnce({ ok: false, error: 'E-Mail-Versand fehlgeschlagen.' });
    await send();
    expect((await screen.findByRole('alert')).textContent).toBe('E-Mail-Versand fehlgeschlagen.');
    expect(Object.fromEntries(h.sendPoa.mock.calls[0]![0] as FormData)).toEqual({
      poaId: 'poa-1',
      expectedUpdatedAt: '2026-10-01T08:00:00Z',
    });

    h.sendPoa.mockRejectedValueOnce(new Error('Verbindung unterbrochen'));
    await send();
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Verbindung unterbrochen'),
    );

    h.sendPoa.mockRejectedValueOnce('kaputt');
    await send();
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'Die Vollmacht konnte nicht versendet werden.',
      ),
    );
  });

  it('sperrt den Button während des Versands', async () => {
    let resolve!: (value: unknown) => void;
    h.sendPoa.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    render(<SendPoaForm poaId="poa-1" isResend expectedUpdatedAt="2026-10-01T08:00:00Z" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Erneut senden' }));
    });
    const pending = screen.getByRole('button', { name: 'Versende…' }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    await act(async () => resolve({ ok: true }));
    expect(
      (screen.getByRole('button', { name: 'Erneut senden' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Portal-Kontakt anonymisieren (DSGVO)', () => {
  async function renderPage(overrides: Record<string, unknown> = {}) {
    h.row = dsgvoRow(overrides);
    return renderServer(DsgvoDetailPage({ params: Promise.resolve({ id: 'dsgvo-1' }) }));
  }

  it('öffnet für Löschanträge nur einen Bestätigungsdialog statt direkt zu anonymisieren', async () => {
    await renderPage();
    const button = screen.getByRole('button', { name: 'Portal-Kontakt jetzt anonymisieren' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.closest('form')).toBeNull();
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Portal-Kontakt anonymisieren' });
    expect(dialog.textContent).toContain('„Max Muster“ wirklich anonymisieren?');
    expect(dialog.textContent).toContain('Dieser Teilschritt lässt sich nicht rückgängig machen');
    expect(confirmButton(dialog, 'Verbindlich anonymisieren').className).toContain(DANGER);
    expect(h.anonymize).not.toHaveBeenCalled();
  });

  it('bietet die Anonymisierung außerhalb offener Löschanträge nicht an', async () => {
    await renderPage({ type: 'ACCESS' });
    expect(screen.queryByRole('button', { name: 'Portal-Kontakt jetzt anonymisieren' })).toBeNull();
  });

  it('meldet Erfolg nur bei bestätigtem Ergebnis und lädt dann neu', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Portal-Kontakt jetzt anonymisieren' }));
    const dialog = screen.getByRole('dialog', { name: 'Portal-Kontakt anonymisieren' });

    h.anonymize.mockResolvedValueOnce({ ok: false, error: 'Kontakt nicht gefunden.' });
    fireEvent.click(confirmButton(dialog, 'Verbindlich anonymisieren'));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Kontakt nicht gefunden.');
    const [previous, formData] = h.anonymize.mock.calls[0]!;
    expect(previous).toBeNull();
    expect(Object.fromEntries(formData as FormData)).toEqual({ contactId: 'contact-1' });

    for (const outcome of [{ ok: false }, new Error('Netz weg')]) {
      if (outcome instanceof Error) h.anonymize.mockRejectedValueOnce(outcome);
      else h.anonymize.mockResolvedValueOnce(outcome);
      fireEvent.click(confirmButton(dialog, 'Verbindlich anonymisieren'));
      await waitFor(() =>
        expect(h.anonymize).toHaveBeenCalledTimes(outcome instanceof Error ? 3 : 2),
      );
      await waitFor(() =>
        expect(within(dialog).getByRole('alert').textContent).toBe(
          'Der Portal-Kontakt konnte nicht anonymisiert werden.',
        ),
      );
    }
    expect(h.refresh).not.toHaveBeenCalled();

    h.anonymize.mockResolvedValueOnce({ ok: true });
    fireEvent.click(confirmButton(dialog, 'Verbindlich anonymisieren'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.refresh).toHaveBeenCalledOnce();
  });
});

describe('Recherche archivieren und löschen', () => {
  function renderView(archivedResults: ResearchResultDTO[] = []) {
    const start = vi.fn((callback: () => void) => callback());
    const onFlash = vi.fn();
    render(
      <ResearchView
        clientId="client-1"
        analysisId="analysis-1"
        requests={[]}
        results={[result()]}
        archivedResults={archivedResults}
        markingsById={{}}
        staffOptions={[]}
        engineConfigured
        pending={false}
        start={start}
        onFlash={onFlash}
        onSelectMarking={vi.fn()}
      />,
    );
    return { onFlash };
  }

  it('trennt reversibles Archivieren vom endgültigen Löschen', async () => {
    h.archiveResult.mockResolvedValue({ ok: true });
    const { onFlash } = renderView();
    const item = screen.getByText('Abzugsfähigkeit Arbeitszimmer').closest('li')!;
    expect(within(item).queryByRole('button', { name: /verwerfen/i })).toBeNull();

    fireEvent.click(within(item).getByRole('button', { name: 'Archivieren' }));
    await waitFor(() =>
      expect(h.archiveResult).toHaveBeenCalledWith({ resultId: 'result-1', archived: true }),
    );
    expect(onFlash).toHaveBeenCalledWith({ ok: true }, 'Recherche archiviert.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(h.deleteResult).not.toHaveBeenCalled();
  });

  it('löscht erst nach Bestätigung im Gefahrendialog', async () => {
    const { onFlash } = renderView();
    const item = screen.getByText('Abzugsfähigkeit Arbeitszimmer').closest('li')!;
    fireEvent.click(within(item).getByRole('button', { name: 'Löschen' }));
    expect(h.deleteResult).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: 'Recherche löschen' });
    expect(dialog.textContent).toContain('„Abzugsfähigkeit Arbeitszimmer“ wirklich');
    expect(dialog.textContent).toContain(
      'Ein bereits erzeugtes Dokument im Aktenregal bleibt bestehen',
    );
    expect(dialog.textContent).toContain('nicht rückgängig gemacht werden');
    const confirm = confirmButton(dialog, 'Löschen');
    expect(confirm.className).toContain(DANGER);

    h.deleteResult.mockResolvedValueOnce({ ok: false, error: 'Recherche gesperrt.' });
    fireEvent.click(confirm);
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Recherche gesperrt.');
    expect(h.refresh).not.toHaveBeenCalled();

    h.deleteResult.mockResolvedValueOnce({ ok: true });
    fireEvent.click(confirmButton(dialog, 'Löschen'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.deleteResult).toHaveBeenLastCalledWith({ resultId: 'result-1' });
    expect(onFlash).toHaveBeenCalledWith({ ok: true }, 'Recherche endgültig gelöscht.');
    expect(h.refresh).toHaveBeenCalledOnce();
  });
});
