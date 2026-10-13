// @vitest-environment jsdom
// Pendelordner und Anlieferungen über die gemeinsame Status-Karte als
// Verhaltenstest (B-08, Welle 15) statt Quelltextprüfung.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  confirm: vi.fn(),
  binder: { update: vi.fn(), remove: vi.fn(), create: vi.fn() },
  handover: { update: vi.fn(), remove: vi.fn(), create: vi.fn() },
  shells: [] as string[],
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('@/components/ui/modal', () => ({ confirmDialog: h.confirm }));
vi.mock('@/server/mail/resend-actions', () => ({ resendMailOutboxAction: vi.fn() }));
vi.mock('../binders/actions', () => ({
  createBinderAction: h.binder.create,
  updateBinderStatusAction: h.binder.update,
  deleteBinderAction: h.binder.remove,
}));
vi.mock('../handovers/actions', () => ({
  createHandoverAction: h.handover.create,
  updateHandoverStatusAction: h.handover.update,
  deleteHandoverAction: h.handover.remove,
}));
// Echte Karte; mitgeschnitten wird nur, welche Fachblöcke sie verwenden.
vi.mock('../status-flow-card', async (importOriginal) => {
  const original = await importOriginal<typeof import('../status-flow-card')>();
  return {
    ...original,
    ClientStatusFlowCard: (props: ComponentProps<typeof original.ClientStatusFlowCard>) => {
      h.shells.push(props.title);
      return original.ClientStatusFlowCard(props);
    },
  };
});

import { BindersBlock } from '../binders/binders-block';
import { HandoversBlock } from '../handovers/handovers-block';

const DAY = 86_400_000;

function binder(id: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: `Ordner ${id}`,
    contents: null,
    status,
    expectedReturnAt: null,
    sentAt: null,
    returnedAt: null,
    ...overrides,
  } as Parameters<typeof BindersBlock>[0]['initial'][number];
}

function handover(id: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: `Anlieferung ${id}`,
    contents: null,
    status,
    receivedAt: '2026-10-01T08:00:00.000Z',
    startedAt: null,
    readyAt: null,
    pickedUpAt: null,
    notifiedContactEmail: null,
    ...overrides,
  } as Parameters<typeof HandoversBlock>[0]['initial'][number];
}

function item(label: string): HTMLElement {
  return screen.getByText(label).closest('li')!;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.shells.length = 0;
  for (const actions of [h.binder, h.handover]) {
    actions.update.mockResolvedValue({ ok: true });
    actions.remove.mockResolvedValue({ ok: true });
  }
});

describe('Status-Karte: gemeinsamer Ablauf', () => {
  it('nutzen Pendelordner und Anlieferungen dieselbe Karte', () => {
    render(<BindersBlock clientId="client-1" initial={[]} />);
    render(<HandoversBlock clientId="client-1" initial={[]} />);
    expect(new Set(h.shells)).toEqual(new Set(['Pendelordner', 'Anlieferungen']));
  });

  it('schaltet den nächsten Status, sperrt währenddessen und lädt danach neu', async () => {
    let finish!: (value: unknown) => void;
    h.binder.update.mockReturnValueOnce(new Promise((done) => (finish = done)));
    render(<BindersBlock clientId="client-1" initial={[binder('b1', 'PREPARED')]} />);
    const advance = within(item('Ordner b1')).getByRole('button', { name: 'Ausgegeben' });
    expect(advance.title).toBe('Status: Ausgegeben');

    await act(async () => {
      fireEvent.click(advance);
    });
    expect(h.binder.update).toHaveBeenCalledExactlyOnceWith({ id: 'b1', status: 'WITH_CLIENT' });
    expect((advance as HTMLButtonElement).disabled).toBe(true);
    expect(h.refresh).not.toHaveBeenCalled();

    await act(async () => finish({ ok: true }));
    expect(h.refresh).toHaveBeenCalledOnce();
    expect((advance as HTMLButtonElement).disabled).toBe(false);
  });

  it('löscht erst nach Bestätigung und lädt danach neu', async () => {
    render(<HandoversBlock clientId="client-1" initial={[handover('h1', 'RECEIVED')]} />);
    const remove = within(item('Anlieferung h1')).getByTitle('Löschen');

    h.confirm.mockResolvedValueOnce(false);
    await act(async () => {
      fireEvent.click(remove);
    });
    expect(h.confirm).toHaveBeenCalledWith('Anlieferung löschen?', {
      title: 'Anlieferung löschen',
      confirmLabel: 'Löschen',
      danger: true,
    });
    expect(h.handover.remove).not.toHaveBeenCalled();

    h.confirm.mockResolvedValueOnce(true);
    await act(async () => {
      fireEvent.click(remove);
    });
    await waitFor(() => expect(h.refresh).toHaveBeenCalledOnce());
    expect(h.handover.remove).toHaveBeenCalledExactlyOnceWith({ id: 'h1' });
  });
});

describe('Pendelordner: fachliche Texte und Bestätigungen', () => {
  it('zeigt Leerzustand, Überfälligkeit, erwartete Rückgabe und Abschlüsse', () => {
    const { unmount } = render(<BindersBlock clientId="client-1" initial={[]} />);
    expect(screen.getByText('Keine aktiven Pendelordner.')).toBeTruthy();
    unmount();

    render(
      <BindersBlock
        clientId="client-1"
        initial={[
          binder('b1', 'WITH_CLIENT', {
            expectedReturnAt: new Date(Date.now() - 3 * DAY).toISOString(),
          }),
          binder('b2', 'COMPLETED', { returnedAt: '2026-09-01T00:00:00.000Z' }),
        ]}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Pendelordner (1)' })).toBeTruthy();
    expect(within(item('Ordner b1')).getByText('überfällig')).toBeTruthy();
    expect(within(item('Ordner b1')).getByText(/^erwartet /).className).toContain('text-red-700');
    expect(screen.getByText('1 abgeschlossen')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Neu' }));
    expect(screen.getByTitle('Erwartete Rückgabe').getAttribute('name')).toBe('expectedReturnAt');
  });

  it('bestätigt das Löschen mit fachlicher Rückfrage', async () => {
    h.confirm.mockResolvedValueOnce(true);
    render(<BindersBlock clientId="client-1" initial={[binder('b1', 'PREPARED')]} />);
    await act(async () => {
      fireEvent.click(within(item('Ordner b1')).getByTitle('Löschen'));
    });
    expect(h.confirm).toHaveBeenCalledWith('Pendelordner löschen?', {
      title: 'Pendelordner löschen',
      confirmLabel: 'Löschen',
      danger: true,
    });
    await waitFor(() => expect(h.binder.remove).toHaveBeenCalledWith({ id: 'b1' }));
  });
});

describe('Anlieferungen: fachliche Texte und Bestätigungen', () => {
  it('fragt vor der Abholbereit-Meldung nach, weil der Mandant eine E-Mail erhält', async () => {
    render(<HandoversBlock clientId="client-1" initial={[handover('h1', 'IN_PROGRESS')]} />);
    h.confirm.mockResolvedValueOnce(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Abholbereit melden' }));
    });
    expect(h.confirm).toHaveBeenCalledWith(
      '„Anlieferung h1" als abholbereit melden? Der Mandant wird per E-Mail informiert.',
      { title: 'Abholbereitschaft melden', confirmLabel: 'Melden' },
    );
    expect(h.handover.update).not.toHaveBeenCalled();

    h.confirm.mockResolvedValueOnce(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Abholbereit melden' }));
    });
    await waitFor(() =>
      expect(h.handover.update).toHaveBeenCalledWith({ id: 'h1', status: 'READY' }),
    );
  });

  it('schaltet andere Übergänge ohne Rückfrage und zeigt den benachrichtigten Kontakt', async () => {
    const { unmount } = render(<HandoversBlock clientId="client-1" initial={[]} />);
    expect(screen.getByText('Keine offenen Anlieferungen.')).toBeTruthy();
    unmount();

    render(
      <HandoversBlock
        clientId="client-1"
        initial={[
          handover('h1', 'RECEIVED'),
          handover('h2', 'READY', {
            readyAt: '2026-10-02T08:00:00.000Z',
            notifiedContactEmail: 'max@mandant.example',
          }),
        ]}
      />,
    );
    expect(within(item('Anlieferung h2')).getByText('· max@mandant.example')).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(item('Anlieferung h1')).getByRole('button', { name: 'Bearbeiten' }));
    });
    expect(h.confirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(h.handover.update).toHaveBeenCalledWith({ id: 'h1', status: 'IN_PROGRESS' }),
    );
  });
});
