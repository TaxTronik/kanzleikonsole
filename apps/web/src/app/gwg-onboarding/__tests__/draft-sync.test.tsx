// @vitest-environment jsdom
// Fachkatalog: GWG-SELF-ONBOARDING-001
// Zwischenstand im Wizard: Wiederherstellen auf einem anderen Gerät,
// automatisches Speichern mit Revision, Konflikt zwischen zwei Geräten und der
// QR-Code zum Weitermachen auf dem Smartphone.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedOnboardingDraft, OnboardingDraftPayload } from '@/server/gwg-onboarding/draft';

const h = vi.hoisted(() => ({
  save: vi.fn(),
  toDataURL: vi.fn(async () => 'data:image/png;base64,qr'),
}));

vi.mock('../actions', () => ({
  uploadIdImageAction: vi.fn(),
  discardOnboardingUploadAction: vi.fn(),
  submitOnboardingAction: vi.fn(),
  loadOnboardingIdentitySourceAction: vi.fn(),
  saveOnboardingDraftAction: h.save,
}));
vi.mock('@/components/gwg/identity-capture', () => ({ IdentityCapture: () => null }));
vi.mock('qrcode', () => ({ default: { toDataURL: h.toDataURL } }));

import { OnboardingWizard } from '../wizard';
import { buildDraftPayload } from '../draft-sync';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const CLIENT = {
  id: 'client-1',
  name: 'Muster GmbH',
  kind: 'JURPERS' as const,
  street: 'Hauptstr. 1',
  postalCode: '36304',
  city: 'Alsfeld',
  countryIso: 'DE',
};

function savedPayload(overrides: Partial<OnboardingDraftPayload> = {}): OnboardingDraftPayload {
  return {
    version: 1,
    step: 2,
    reached: 2,
    master: {
      companyName: 'Muster GmbH & Co. KG',
      street: 'Neue Str. 5',
      postalCode: '36304',
      city: 'Alsfeld',
      countryIso: 'DE',
    },
    owners: [
      {
        id: 'owner-7',
        fullName: 'Erika Beispiel',
        birthDate: '1985-03-04',
        birthPlace: 'Köln',
        nationality: 'DE',
        street: 'Neue Str. 5',
        postalCode: '36304',
        city: 'Alsfeld',
        countryIso: 'DE',
        sharePercent: '100%',
        isPep: false,
        idType: 'PERSONALAUSWEIS',
        idNumber: 'L01X00T47',
        idIssuedBy: 'Stadt Köln',
        idIssueDate: '2024-05-02',
        idExpiryDate: '2034-05-01',
        idFront: { documentId: uuid(1), fileName: 'vorne.jpg' },
        idBack: { documentId: uuid(2), fileName: 'hinten.jpg' },
        identityApplied: ['idIssuedBy'],
      },
    ],
    representatives: [],
    extraDocuments: [],
    noRegisterEntry: false,
    ...overrides,
  };
}

function saved(overrides: Partial<OnboardingDraftPayload> = {}): LoadedOnboardingDraft {
  return { revision: 3, updatedAt: '2026-10-22T08:15:00.000Z', payload: savedPayload(overrides) };
}

function renderWizard(savedDraft: LoadedOnboardingDraft | null) {
  return render(
    <OnboardingWizard
      token="token-1"
      inviteName="Max Muster"
      client={CLIENT}
      initialDraft={null}
      savedDraft={savedDraft}
      noticeBody="Datenschutzhinweise der Kanzlei"
      noticeVersion={1}
      consentOptions={[]}
      consentDisplayRevision="rev-1"
    />,
  );
}

const stepHeading = (name: string) => screen.getByRole('heading', { level: 2, name });
const leave = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
/** Debounce des Autosave ablaufen lassen und die Antwort abwarten. */
async function flushSave(ms = 1_600) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never;
  URL.createObjectURL = vi.fn(() => 'blob:vorschau');
  URL.revokeObjectURL = vi.fn();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: false });
  h.save.mockImplementation(async (input: { revision: number }) => ({
    ok: true,
    revision: input.revision + 1,
    updatedAt: '2026-10-22T09:00:00.000Z',
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GwG-Onboarding – Zwischenstand wiederherstellen', () => {
  it('setzt auf einem anderen Gerät beim gespeicherten Schritt mit allen Angaben fort', () => {
    renderWizard(saved());
    expect(stepHeading('Rechtsträgernachweise')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      'Ihr gespeicherter Zwischenstand wurde geladen',
    );
    // Zurück zu Personen und Stammdaten: der gespeicherte Stand, nicht der Kanzlei-Stand.
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    expect(screen.getByText('Erika Beispiel')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    expect(screen.getByRole('textbox', { name: /Firma/ })).toHaveProperty(
      'value',
      'Muster GmbH & Co. KG',
    );
    expect(screen.getByRole('textbox', { name: /Straße/ })).toHaveProperty('value', 'Neue Str. 5');
  });

  it('beginnt höchstens beim Datenschutz, weil die Erklärung nie gespeichert wird', () => {
    renderWizard(saved({ step: 4, reached: 4 }));
    expect(stepHeading('Datenschutz')).toBeTruthy();
    expect(
      screen.getByRole('checkbox', {
        name: 'Ich habe die Datenschutzhinweise zur Kenntnis genommen.',
      }),
    ).toHaveProperty('checked', false);
  });

  it('fragt beim Verlassen nicht nach, solange alles gespeichert ist', () => {
    renderWizard(saved());
    expect(leave()).toBe(false);
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe('GwG-Onboarding – automatisch speichern', () => {
  it('speichert kurz nach einer Änderung auf der gelesenen Revision und baut darauf auf', async () => {
    renderWizard(saved());
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Ort/ }), {
      target: { value: 'Fulda' },
    });
    expect(leave()).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
    // Bis zum Speichern nie „gespeichert“ anzeigen.
    expect(screen.getByRole('status').textContent).toBe('Wird gespeichert …');

    await flushSave();
    expect(h.save).toHaveBeenCalledTimes(1);
    const first = h.save.mock.calls[0]![0] as {
      token: string;
      revision: number;
      payload: OnboardingDraftPayload;
    };
    expect(first.token).toBe('token-1');
    expect(first.revision).toBe(3);
    expect(first.payload).toMatchObject({ step: 0, reached: 2, master: { city: 'Fulda' } });
    expect(first.payload.owners[0]).toMatchObject({
      id: 'owner-7',
      idFront: { documentId: uuid(1), fileName: 'vorne.jpg' },
      identityApplied: ['idIssuedBy'],
    });
    expect(screen.getByRole('status').textContent).toContain('Zwischenstand gespeichert');
    expect(leave()).toBe(false);

    fireEvent.change(screen.getByRole('textbox', { name: /Ort/ }), {
      target: { value: 'Kassel' },
    });
    await flushSave();
    expect(h.save).toHaveBeenCalledTimes(2);
    expect((h.save.mock.calls[1]![0] as { revision: number }).revision).toBe(4);
  });

  it('legt ohne Zwischenstand mit Revision 0 an', async () => {
    renderWizard(null);
    expect(screen.getByRole('status').textContent).toContain('automatisch zwischengespeichert');
    expect(leave()).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: /Ort/ }), {
      target: { value: 'Fulda' },
    });
    await flushSave();
    expect((h.save.mock.calls[0]![0] as { revision: number }).revision).toBe(0);
  });

  it('überschreibt nichts, wenn ein anderes Gerät inzwischen gespeichert hat', async () => {
    h.save.mockResolvedValue({ ok: false, conflict: true, revision: 5 });
    renderWizard(saved());
    const registerStatus = screen.getByRole('combobox', {
      name: 'Registerstatus des Rechtsträgers',
    });
    fireEvent.change(registerStatus, { target: { value: 'NO_REGISTER' } });
    await flushSave();
    expect(screen.getByRole('alert').textContent).toContain('auf einem anderen Gerät geändert');
    expect(screen.getByRole('button', { name: 'Neu laden' })).toBeTruthy();
    expect(leave()).toBe(true);

    fireEvent.change(registerStatus, { target: { value: 'REGISTERED' } });
    await flushSave(20_000);
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('versucht es nach einem Fehler später erneut', async () => {
    h.save.mockResolvedValueOnce({
      ok: false,
      error: 'Zwischenstand konnte nicht gespeichert werden.',
    });
    renderWizard(null);
    fireEvent.change(screen.getByRole('textbox', { name: /Ort/ }), {
      target: { value: 'Fulda' },
    });
    await flushSave();
    expect(screen.getByRole('status').textContent).toContain('konnte gerade nicht gespeichert');
    await flushSave(5_000);
    expect(h.save).toHaveBeenCalledTimes(1);
    await flushSave(5_100);
    expect(h.save).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status').textContent).toContain('Zwischenstand gespeichert');
  });
});

describe('GwG-Onboarding – Gerätewechsel', () => {
  it('zeigt auf Wunsch einen QR-Code mit dem Link dieser Seite', async () => {
    vi.useRealTimers();
    renderWizard(null);
    expect(h.toDataURL).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Auf dem Smartphone fortsetzen' }));
    const image = await screen.findByRole('img', { name: /QR-Code/ });
    expect(image.getAttribute('src')).toBe('data:image/png;base64,qr');
    expect(h.toDataURL).toHaveBeenCalledWith(window.location.href, expect.anything());
    expect(screen.getByText(/nur selbst scannen/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'QR-Code schließen' }));
    expect(screen.queryByRole('img', { name: /QR-Code/ })).toBeNull();
  });

  it('speichert nur Angaben und Dateiverweise, keine lokalen Dateien oder Vorschaubilder', () => {
    const payload = buildDraftPayload({
      step: 1,
      reached: 1,
      master: savedPayload().master,
      owners: [
        {
          ...savedPayload().owners[0]!,
          idFront: {
            documentId: uuid(1),
            fileName: 'vorne.jpg',
            versionId: uuid(101),
            localFile: new File(['x'], 'vorne.jpg'),
            previewUrl: 'blob:vorschau',
          },
          idBack: null,
        },
      ],
      representatives: [],
      extraDocs: [],
      noRegisterEntry: null,
    });
    expect(payload.owners[0]!.idFront).toEqual({
      documentId: uuid(1),
      fileName: 'vorne.jpg',
      versionId: uuid(101),
    });
    expect(JSON.stringify(payload)).not.toContain('blob:');
  });
});
