import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const files = {
  requests: readFileSync(
    new URL('../../app/staff/(protected)/clients/[id]/requests/new/form.tsx', import.meta.url),
    'utf8',
  ),
  contacts: readFileSync(new URL('../client-contacts-panel.tsx', import.meta.url), 'utf8'),
  staffAppointments: readFileSync(
    new URL('../../app/staff/(protected)/calendar/new-appointment-dialog.tsx', import.meta.url),
    'utf8',
  ),
  portalAppointments: readFileSync(
    new URL('../../app/portal/(protected)/appointments/request-form.tsx', import.meta.url),
    'utf8',
  ),
};

describe('zentrale Formularfehler in den 0.3.0-Migrationspfaden', () => {
  it.each(Object.entries(files))(
    '%s nutzt Zusammenfassung und Feldverknüpfung',
    (_name, source) => {
      expect(source).toContain('<FormErrorSummary');
      expect(source).toContain('fieldErrorProps(');
      expect(source).toContain('<FieldError');
    },
  );

  it('bindet die neue Anforderung an REQ-LIFECYCLE-001 ohne lokalen ActionResult-Klon', () => {
    const actions = readFileSync(
      new URL('../../app/staff/(protected)/clients/[id]/requests/actions.ts', import.meta.url),
      'utf8',
    );
    expect(actions).toContain('type ActionResult,');
    expect(actions).not.toMatch(/export interface ActionResult\s*\{/);
  });
});
