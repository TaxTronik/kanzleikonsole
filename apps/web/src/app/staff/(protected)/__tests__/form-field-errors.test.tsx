// =============================================================================
// Feldfehler in den Formularen aus Review C7: Benutzer, Telefonnotizen,
// Dienstleister, Mandant bearbeiten, ELSTER und Wiedervorlagen. Mit einem
// Action-Ergebnis mit `fieldErrors` zeigen sie die Zusammenfassung (Sprung zum
// Feld) und den Fehler am Feld: `aria-invalid`, `aria-describedby` → Text.
//
// Ohne DOM-Testumgebung liefert ein Double von useActionState das Ergebnis der
// letzten Übermittlung; aufklappbare Formulare (Wiedervorlagen, Cockpit-
// Telefonzettel) werden über ihren `useState(false)`-Schalter geöffnet.
// =============================================================================

import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ state: null as unknown, openForms: false }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useActionState: (_action: unknown, initial: unknown) => [h.state ?? initial, () => {}, false],
    useState: <T,>(initial: T | (() => T)) =>
      actual.useState(h.openForms && initial === false ? (true as T) : initial),
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/app/staff/(protected)/admin/users/actions', () => ({ createUserAction: vi.fn() }));
vi.mock('@/app/staff/(protected)/phone-notes/actions', () => ({
  createPhoneNoteAction: vi.fn(),
}));
vi.mock('@/app/staff/(protected)/service-providers/actions', () => ({
  createServiceProviderAction: vi.fn(),
}));
vi.mock('@/app/staff/(protected)/clients/[id]/edit/actions', () => ({
  saveAdminFieldsAction: vi.fn(),
  saveGwgFieldsAction: vi.fn(),
  setResponsibilitiesAction: vi.fn(),
  setMandateEndAction: vi.fn(),
}));
vi.mock('@/app/staff/(protected)/clients/[id]/elster/actions', () => ({
  kontoabfrageAction: vi.fn(),
}));
vi.mock('@/app/staff/(protected)/clients/[id]/reminders/actions', () => ({
  createReminderAction: vi.fn(),
  markReminderDoneAction: vi.fn(),
  reopenReminderAction: vi.fn(),
  setReminderPriorityAction: vi.fn(),
  submitResearchResultAction: vi.fn(),
  archiveReminderAction: vi.fn(),
}));

import { CreateUserForm } from '../admin/users/create-form';
import { NewPhoneNoteForm } from '../phone-notes/new-form';
import { QuickPhoneNote } from '../clients/[id]/quick-phone-note';
import { NewProviderForm } from '../service-providers/new-form';
import {
  AdminFieldsForm,
  GwgFieldsForm,
  ResponsibilitiesForm,
  StammdatenField,
} from '../clients/[id]/edit/stammdaten-forms';
import { ProvidedFieldError } from '@/components/form-errors';
import { KontoabfrageForm } from '../clients/[id]/elster/kontoabfrage-form';
import { NewReminderForm } from '../reminders/new-reminder-form';
import { RemindersBlock } from '../clients/[id]/reminders/reminders-block';

function failed(fieldErrors: Record<string, string[]>) {
  return {
    ok: false,
    error: 'Bitte prüfen Sie die markierten Angaben.',
    errorCode: 'VALIDATION_ERROR',
    fieldErrors,
  };
}

function render(element: ReactElement, fieldErrors: Record<string, string[]>): string {
  h.state = failed(fieldErrors);
  return renderToStaticMarkup(element);
}

/** Öffnendes Tag des Formularfelds mit diesem `name`. */
function control(html: string, name: string): string {
  const match = html.match(new RegExp(`<(?:input|select|textarea)[^>]*\\bname="${name}"[^>]*>`));
  if (!match) throw new Error(`Feld ${name} fehlt`);
  return match[0];
}

/** Feld trägt aria-invalid und verweist auf einen Fehlertext mit `message`. */
function expectFieldError(html: string, name: string, message: string) {
  const tag = control(html, name);
  expect(tag, name).toContain('aria-invalid="true"');
  const describedBy = tag.match(/aria-describedby="([^"]+)"/)?.[1]?.split(' ') ?? [];
  const errorId = describedBy.find((id) => id.endsWith('-error'));
  expect(errorId, `${name}: aria-describedby`).toBeDefined();
  expect(html).toContain(
    `<div id="${errorId}" class="mt-1 text-sm text-red-700"><p>${message}</p></div>`,
  );
}

/** Zusammenfassung mit Sprunglink zum Feld. */
function expectSummaryLink(html: string, fieldId: string, message: string) {
  expect(html).toContain('Bitte prüfen Sie Ihre Angaben.');
  expect(html).toContain(`<a class="underline" href="#${fieldId}">${message}</a>`);
}

beforeEach(() => {
  h.state = null;
  h.openForms = false;
});

describe('Feldfehler in den C7-Formularen', () => {
  it('Benutzer anlegen', () => {
    const html = render(<CreateUserForm canAssignAdmin />, {
      email: ['Bitte eine gültige E-Mail-Adresse angeben.'],
      confirmPassword: ['Die Passwörter stimmen nicht überein.'],
    });
    expectFieldError(html, 'email', 'Bitte eine gültige E-Mail-Adresse angeben.');
    expectFieldError(html, 'confirmPassword', 'Die Passwörter stimmen nicht überein.');
    expectSummaryLink(html, 'user-email', 'Bitte eine gültige E-Mail-Adresse angeben.');
    expect(control(html, 'fullName')).not.toContain('aria-invalid');
  });

  it('Telefonnotiz (Seite und Mandanten-Cockpit)', () => {
    const page = render(<NewPhoneNoteForm staff={[]} currentStaffId="staff-1" callers={[]} />, {
      subject: ['Pflichtfeld.'],
      body: ['Höchstens 5.000 Zeichen.'],
    });
    expectFieldError(page, 'subject', 'Pflichtfeld.');
    expectFieldError(page, 'body', 'Höchstens 5.000 Zeichen.');
    expectSummaryLink(page, 'subject', 'Pflichtfeld.');

    h.openForms = true;
    const cockpit = render(
      <QuickPhoneNote clientId="client-1" contacts={[]} staff={[]} currentStaffId="staff-1" />,
      { callerName: ['Pflichtfeld.'] },
    );
    expectFieldError(cockpit, 'callerName', 'Pflichtfeld.');
    expectSummaryLink(cockpit, 'qpn-caller', 'Pflichtfeld.');
    expect(cockpit).toContain('id="qpn-callerName-error"');
  });

  it('Dienstleister anlegen', () => {
    const html = render(<NewProviderForm />, {
      contactEmail: ['Bitte eine gültige E-Mail-Adresse angeben.'],
      contractFromDate: ['Bitte ein gültiges Datum angeben.'],
    });
    expectFieldError(html, 'contactEmail', 'Bitte eine gültige E-Mail-Adresse angeben.');
    expectFieldError(html, 'contractFromDate', 'Bitte ein gültiges Datum angeben.');
    expectSummaryLink(html, 'sp-from', 'Bitte ein gültiges Datum angeben.');
  });

  it('Mandant bearbeiten: Felder aus der Server-Component lesen die Fehler des Formulars', () => {
    const admin = render(
      <AdminFieldsForm clientId="client-1">
        <StammdatenField label="Rechnungs-E-Mail" name="invoiceEmail" defaultValue="" />
        <select name="priority" id="client-priority" />
        <ProvidedFieldError name="priority" />
      </AdminFieldsForm>,
      {
        invoiceEmail: ['Bitte eine gültige E-Mail-Adresse angeben.'],
        priority: ['Ungültige Auswahl.'],
      },
    );
    expectFieldError(admin, 'invoiceEmail', 'Bitte eine gültige E-Mail-Adresse angeben.');
    expect(admin).toContain('<label class="label-sm" for="client-invoiceEmail">');
    expect(admin).toContain('<div id="field-priority-error" class="mt-1 text-sm text-red-700">');
    expectSummaryLink(admin, 'client-priority', 'Ungültige Auswahl.');

    const gwg = render(
      <GwgFieldsForm clientId="client-1">
        <StammdatenField label="Land (ISO 2)" name="countryIso" defaultValue="DEU" />
      </GwgFieldsForm>,
      { countryIso: ['Genau 2 Zeichen.'] },
    );
    expectFieldError(gwg, 'countryIso', 'Genau 2 Zeichen.');
    expectSummaryLink(gwg, 'client-countryIso', 'Genau 2 Zeichen.');

    const responsibilities = render(
      <ResponsibilitiesForm clientId="client-1">
        <ProvidedFieldError name="berufstraegerIds" />
      </ResponsibilitiesForm>,
      { berufstraegerIds: ['Ungültige Auswahl.'] },
    );
    expect(responsibilities).toContain('id="field-berufstraegerIds-error"');
  });

  it('ELSTER-Kontoabfrage', () => {
    const html = render(
      <KontoabfrageForm
        clientId="client-1"
        registrations={[{ id: 'reg-1', label: 'ESt', numberElster: '123', isPrimary: true }]}
      />,
      { jahr: ['Bitte ein vierstelliges Jahr angeben.'], pin: ['Pflichtfeld.'] },
    );
    expectFieldError(html, 'jahr', 'Bitte ein vierstelliges Jahr angeben.');
    expectFieldError(html, 'pin', 'Pflichtfeld.');
    // Der bestehende Hinweis bleibt mit dem Feld verknüpft.
    expect(control(html, 'pin')).toContain(
      'aria-describedby="elster-kontoabfrage-pin-hint field-pin-error"',
    );
    expectSummaryLink(html, 'elster-kontoabfrage-jahr', 'Bitte ein vierstelliges Jahr angeben.');
  });

  it('Wiedervorlagen (Übersicht und Mandanten-Cockpit)', () => {
    h.openForms = true;
    const overview = render(<NewReminderForm staffOptions={[]} />, {
      dueDate: ['Bitte ein gültiges Datum angeben.'],
      subject: ['Höchstens 200 Zeichen.'],
    });
    expectFieldError(overview, 'dueDate', 'Bitte ein gültiges Datum angeben.');
    expectFieldError(overview, 'subject', 'Höchstens 200 Zeichen.');
    expectSummaryLink(overview, 'new-reminder-subject', 'Höchstens 200 Zeichen.');

    const cockpit = render(
      <RemindersBlock clientId="client-1" initial={[]} staffOptions={[]} currentStaffId="s-1" />,
      { subject: ['Pflichtfeld.'] },
    );
    expectFieldError(cockpit, 'subject', 'Pflichtfeld.');
    expectSummaryLink(cockpit, 'client-reminder-subject', 'Pflichtfeld.');
  });

  it('zeigt ohne Fehler weder Zusammenfassung noch Feldmarkierung', () => {
    const html = renderToStaticMarkup(<NewProviderForm />);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('aria-invalid');
  });
});
