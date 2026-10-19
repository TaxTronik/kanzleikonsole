// TCMS Stufe 3, Bereich C: Auswahl der Verantwortlichen einer Maßnahme –
// nur Mitarbeiter mit Zugriff auf den Mandanten (ACCESS-CLIENT-MODE-001) und
// aktive Kontakte genau dieses Mandanten mit Tax-CMS-Rolle; Namen aus der
// kanzleikonsole. Die Aktion prüft die gewählte Person zusätzlich über
// server/tcms/personen.ts.
// Fachkatalog: TCMS-AKTEUR-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ zugriff: vi.fn(), kontakte: vi.fn() }));

vi.mock('@/server/auth/rbac', () => ({ filterStaffAccessClientTx: h.zugriff }));
vi.mock('@/server/tcms/personen', () => ({ kontakteDesMandantenTx: h.kontakte }));

import { massnahmePersonenTx, personAusWert, personWert } from '../personen';

const TENANT = '7a1e0000-0000-4000-8000-00000000d3e0';
const MANDANT = 'a1000000-0000-4000-8000-000000004711';
const ANNA = 'b1000000-0000-4000-8000-000000000001';
const LEON = 'b1000000-0000-4000-8000-000000000002';
const JANA = 'b1000000-0000-4000-8000-000000000011';
const MURAT = 'b1000000-0000-4000-8000-000000000012';
const SABINE = 'b1000000-0000-4000-8000-000000000013';

const findMany = vi.fn();
const tx = { staffUser: { findMany } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([
    { id: ANNA, fullName: 'StB Dr. Anna Roth' },
    { id: LEON, fullName: 'Leon Brandt' },
  ]);
  h.zugriff.mockResolvedValue(new Set([LEON]));
  h.kontakte.mockResolvedValue([
    { id: JANA, name: 'Jana Talwind', email: 'j@x', aktiv: true, funktion: null },
    { id: MURAT, name: 'Murat Yilmaz', email: 'm@x', aktiv: false, funktion: null },
    { id: SABINE, name: 'Sabine Kern', email: 's@x', aktiv: true, funktion: null },
  ]);
});

describe('massnahmePersonenTx', () => {
  it('nur Mitarbeiter mit Mandantenzugriff und aktive Kontakte mit Tax-CMS-Rolle', async () => {
    const auswahl = await massnahmePersonenTx(
      tx,
      { tenantId: TENANT, mandantId: MANDANT },
      new Set([JANA, MURAT]),
    );
    expect(auswahl).toEqual([
      [`KANZLEI:${LEON}`, 'Leon Brandt (Kanzlei)'],
      [`MANDANT:${JANA}`, 'Jana Talwind (Mandant)'],
    ]);
    expect(findMany.mock.calls[0]![0].where).toEqual({ tenantId: TENANT, active: true });
    expect(h.zugriff).toHaveBeenCalledWith(tx, TENANT, [ANNA, LEON], MANDANT);
    expect(h.kontakte).toHaveBeenCalledWith(tx, { tenantId: TENANT, mandantId: MANDANT });
  });
});

describe('personAusWert', () => {
  it('nur Art und UUID; alles andere ist ungültig', () => {
    expect(personAusWert(`kanzlei:${LEON.toUpperCase()}`)).toEqual({ art: 'KANZLEI', id: LEON });
    expect(personAusWert(personWert('MANDANT', JANA))).toEqual({ art: 'MANDANT', id: JANA });
    expect(personAusWert(LEON)).toBeNull();
    expect(personAusWert(`ADMIN:${LEON}`)).toBeNull();
    expect(personAusWert(`KANZLEI:${LEON}:x`)).toBeNull();
  });
});
