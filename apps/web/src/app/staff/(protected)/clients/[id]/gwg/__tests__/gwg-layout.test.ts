// @vitest-environment jsdom
// GwG: interaktive Komponentenverträge als Render- und Verhaltenstest (B-08,
// Welle 15) statt Quelltextprüfung. Die Seitenstruktur prüft weiterhin
// page-render.test.tsx per SSR. Der Dateiname bleibt, weil die Regeln ihn als
// test_ref führen; daher createElement statt JSX.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentitySubjectOption } from '@/server/gwg/identity-subject';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateIdDocuments: vi.fn(),
  selectCurrent: vi.fn(),
  confirmMessages: [] as string[],
}));

// Stabiles Router-Objekt wie in Next (Effekte hängen von seiner Identität ab).
const router = { refresh: h.refresh };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../id-document-actions', () => ({
  updateIdDocumentsAction: h.updateIdDocuments,
  extendIdentityDocumentSetAction: vi.fn(),
  selectCurrentIdentityDocumentSetAction: h.selectCurrent,
  removeGwgEvidenceLinkAction: vi.fn(),
  addIdDocumentAction: vi.fn(),
  searchUnlinkedGwgDocumentsAction: vi.fn(async () => ({ ok: true, documents: [] })),
}));
vi.mock('../owner-actions', () => ({ addBeneficialOwnerRoleAction: vi.fn() }));
vi.mock('../add-id-doc-form', () => ({
  AddIdDocumentForm: () => createElement('div', { 'data-testid': 'replacement-form' }),
}));
vi.mock('@/components/document-preview', () => ({ DocumentPreviewButton: () => null }));
vi.mock('@/components/document-upload-button', () => ({ DocumentUploadButton: () => null }));
vi.mock('@/components/gwg/saved-identity-views', () => ({ SavedIdentityViews: () => null }));
vi.mock('@/components/ui/modal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/modal')>()),
  // Bestätigung angenommen: Formular wird normal abgeschickt.
  confirmFormSubmission: (_event: unknown, message: string) => {
    h.confirmMessages.push(message);
  },
}));

import { IdentityDocumentReview, type IdentityReviewGroup } from '../identity-document-review';
import { AddBeneficialOwnerRoleForm } from '../add-beneficial-owner-role-form';

const CHECK_ID = 'check-1';
const CLIENT_ID = 'client-1';
const SUBJECT: IdentitySubjectOption = {
  key: 'NATURAL_CLIENT:client-1',
  id: 'client-1',
  kind: 'NATURAL_CLIENT',
  name: 'Max Muster',
  roles: ['MANDANT'],
} as IdentitySubjectOption;

function group(setId: string, overrides: Partial<IdentityReviewGroup> = {}): IdentityReviewGroup {
  return {
    key: `set:${setId}`,
    documentSetId: setId,
    subjectKey: SUBJECT.key,
    revision: `rev-${setId}`,
    documents: [
      {
        id: `doc-${setId}`,
        gwgCheckId: CHECK_ID,
        documentSetId: setId,
        documentId: `file-${setId}`,
        type: 'PERSONALAUSWEIS',
        ownerName: 'Max Muster',
        number: 'L01X00T47',
        issuedBy: 'Stadt Alsfeld',
        issueDate: '2021-01-15',
        expiryDate: '2031-01-14',
        verifiedAt: null,
        naturalClientSubjectId: 'client-1',
        beneficialOwnerSubjectId: null,
        representativeSubjectId: null,
        identityAssignmentConfirmedAt: null,
        identityAssignmentConfirmedBy: null,
        notes: null,
        viewports: [],
        document: { id: `file-${setId}`, title: 'Ausweis.pdf', createdAt: '2026-10-01T08:00:00Z' },
      },
    ],
    ...overrides,
  };
}

function renderReview(groups: IdentityReviewGroup[], disabled = false) {
  return render(
    createElement(IdentityDocumentReview, {
      checkId: CHECK_ID,
      clientId: CLIENT_ID,
      groups,
      subjectOptions: [SUBJECT],
      clientDocuments: [],
      grandfathered: false,
      disabled,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.confirmMessages.length = 0;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe('GwG interaktive Komponentenverträge', () => {
  // Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
  it('zeigt Ausweisdaten zuerst lesend und den Austausch erst im Bearbeitungsmodus', () => {
    const { container } = renderReview([group('set-1')]);
    const number = screen.getByText('Ausweisnummer');
    expect(number.nextElementSibling!.textContent).toBe('L01X00T47');
    const edit = screen.getByRole('button', { name: 'Bearbeiten' });
    const replace = screen.getByRole('button', { name: 'Ausweis ersetzen' });
    expect(number.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(edit.compareDocumentPosition(replace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('replacement-form')).toBeNull();

    fireEvent.click(edit);
    // Im Bearbeitungsmodus: Formular statt Lesedaten, Austausch zugeklappt.
    expect(screen.queryByText('Ausweisnummer')?.closest('dl')).toBeFalsy();
    const replacement = screen.getByTestId('replacement-form').closest('details')!;
    expect(replacement.open).toBe(false);
    expect(container.querySelector('input[name="intent"][value="save"]')).not.toBeNull();
  });

  // Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
  it('öffnet den Austausch direkt aufgeklappt und bietet ihn nicht ohne Zuordnung oder gesperrt an', () => {
    const { unmount } = renderReview([group('set-1')]);
    fireEvent.click(screen.getByRole('button', { name: 'Ausweis ersetzen' }));
    expect(screen.getByTestId('replacement-form').closest('details')!.open).toBe(true);
    unmount();

    const { unmount: unmountUnassigned } = renderReview([group('set-1', { subjectKey: null })]);
    expect(screen.queryByRole('button', { name: 'Ausweis ersetzen' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    expect(screen.queryByTestId('replacement-form')).toBeNull();
    unmountUnassigned();

    renderReview([group('set-1')], true);
    expect(screen.queryByRole('button', { name: 'Bearbeiten' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ausweis ersetzen' })).toBeNull();
  });

  // Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
  it('bestätigt einen vollständigen gültigen Ausweis direkt aus dem Lesemodus', async () => {
    h.updateIdDocuments.mockResolvedValueOnce({
      ok: true,
      verified: true,
      revision: 'rev-set-1-b',
      saved: {
        type: 'PERSONALAUSWEIS',
        number: 'L01X00T47',
        issuedBy: 'Stadt Alsfeld',
        issueDate: '2021-01-15',
        expiryDate: '2031-01-14',
        subjectKey: SUBJECT.key,
        ownerName: 'Max Muster',
      },
    });
    renderReview([group('set-1')]);
    expect(screen.getByText('Prüfung offen')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Als geprüft markieren' }));
    });
    await waitFor(() => expect(h.updateIdDocuments).toHaveBeenCalledOnce());
    const data = Object.fromEntries(h.updateIdDocuments.mock.calls[0]![1] as FormData);
    expect(data).toMatchObject({
      intent: 'confirm',
      documentSetId: 'set-1',
      expectedRevision: 'rev-set-1',
      subjectKey: SUBJECT.key,
      number: 'L01X00T47',
    });
    await waitFor(() => expect(screen.getByText('Angaben bestätigt')).toBeTruthy());
    expect(h.refresh).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Als geprüft markieren' })).toBeNull();
  });

  // Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
  it('bestätigt unvollständige Angaben nicht direkt', () => {
    const incomplete = group('set-1');
    incomplete.documents[0]!.issuedBy = null;
    renderReview([incomplete]);
    expect(screen.queryByRole('button', { name: 'Als geprüft markieren' })).toBeNull();
  });

  // Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
  it('lässt bei einem Doppelbestand bewusst genau einen aktuellen Ausweissatz auswählen', async () => {
    h.selectCurrent.mockResolvedValueOnce({ ok: true });
    renderReview([group('set-1'), group('set-2')]);
    // Kein Direktbestätigen, solange mehrere Sätze konkurrieren.
    expect(screen.queryByRole('button', { name: 'Als geprüft markieren' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Diesen Ausweis als aktuell festlegen' }),
    ).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'Bearbeiten' })[1]!);
    const select = screen.getByRole('button', { name: 'Diesen Ausweis als aktuell festlegen' });
    await act(async () => {
      fireEvent.click(select);
    });
    expect(h.confirmMessages).toEqual([
      'Diesen Ausweissatz als aktuell festlegen? Alle anderen aktiven Ausweise dieser Person werden unter „Alte Ausweise“ abgelegt.',
    ]);
    await waitFor(() => expect(h.selectCurrent).toHaveBeenCalledOnce());
    expect(Object.fromEntries(h.selectCurrent.mock.calls[0]![1] as FormData)).toEqual({
      checkId: CHECK_ID,
      clientId: CLIENT_ID,
      documentSetId: 'set-2',
    });
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
  });

  it('stellt die Anteilsangabe der Doppelrolle mit semantischen Dark-Mode-Flächen dar', () => {
    const { container } = render(
      createElement(AddBeneficialOwnerRoleForm, {
        checkId: CHECK_ID,
        clientId: CLIENT_ID,
        representativeId: 'rep-1',
        personName: 'Max Muster',
      }),
    );
    const form = container.querySelector('form')!;
    expect([...form.classList]).toContain('bg-surface-raised');
    expect(form.outerHTML).not.toContain('bg-brand-50/30');
    const share = screen.getByLabelText('Anteil (%)').parentElement!;
    expect([...share.classList]).toEqual(
      expect.arrayContaining(['border-default', 'bg-surface', 'p-3']),
    );
    expect(screen.getByText(/rollenspezifische Anteil/).className).toContain('text-secondary');
    expect(form.querySelector('svg.lucide-badge-percent')).not.toBeNull();
    expect(within(form).getByRole('button', { name: 'Doppelrolle speichern' })).toBeTruthy();
  });
});
