// =============================================================================
// TCMS Stufe 3, Bereich A: Einrichtung, Profil, Beschreibung und Kommunikation
// gegen einen LAUFENDEN TCMS-Dienst mit Demo-Daten (Opt-in, nicht in CI – wie
// server/tcms/__tests__/oberflaechen-live.test.tsx, dessen Aufbau diese Suite
// übernimmt).
//
// Echt: Seiten-Helfer, Akteursabbildung, Zuständigkeit und Personenprüfung
// gegen PostgreSQL (App-Rolle, RLS), signierter Transport, Dienst, Rendering.
// Ersetzt: nur die Request-Authentisierung, next/navigation und next/cache.
//
// Die Suite verändert den Dienst (je Lauf ein neuer Mandant mit Version 1,
// eine neue Beschreibungsversion von Talwind mit Review und
// Freigabeanforderung, Neuadressierung hin und zurück) und ist wiederholbar;
// die Demo-Mandanten Bergkamm, Seestern und die übrigen bleiben unberührt.
//
// Start (Dienst und Umgebung: docs/development/tcms-anbindung.md §6):
//   cd apps/web && TCMS_LIVE_TESTS=1 DB_TESTS=1 TCMS_DEPLOYMENT=external \
//     TCMS_URL=… TCMS_SERVICE_TOKEN=… TCMS_ACTOR_PRIVATE_KEY=… TCMS_ACTOR_KEY_ID=… \
//     pnpm exec vitest run src/server/tcms/programm/__tests__/programm-live.test.tsx
// Nicht gleichzeitig mit oberflaechen-live.test.tsx (gleicher Demo-Tenant).
// Fachkatalog: TCMS-AKTEUR-001, TCMS-DIENST-001
// =============================================================================
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { ReactNode } from 'react';
import { within } from '@testing-library/dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const sitzung = vi.hoisted(() => ({ staff: null as unknown }));

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => sitzung.staff }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (ziel: string) => {
    throw new Error(`NEXT_REDIRECT:${ziel}`);
  },
  usePathname: () => '/staff/clients/x/tcms',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import * as db from '@taxtronik/db';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { DEMO } from '@/__tests__/tcms-fixtures';
import { renderServerMarkup } from '@/__tests__/render-helpers';
import { erwarteAnwendungsfehler } from '@taxtronik/db/testing/db-fehler';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: { document: Document } };
};

const enabled =
  process.env.TCMS_LIVE_TESTS === '1' &&
  !!process.env.TCMS_URL &&
  (process.env.DB_TESTS === '1' || process.env.TCMS_SEITE_DB_TEST === '1');

async function rendern(seite: ReactNode | Promise<ReactNode>) {
  const html = await renderServerMarkup(seite);
  const body = new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body;
  return { screen: within(body), container: body };
}

function formular(felder: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(felder)) {
    for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  }
  return fd;
}

(enabled ? describe : describe.skip)('Bereich A gegen den laufenden Dienst', () => {
  // Owner nur für synthetische Fixtures (wie tickets-db.test.ts), kein eigener PrismaClient.
  const owner = db.prismaOwner;
  const neuerMandant = randomUUID();
  const neuerKontakt = randomUUID();
  const einrichtungMandant = randomUUID();
  const gerda = randomUUID();
  const inEinerStunde = () => new Date(Date.now() + 3_600_000).toISOString();
  const staffSitzung = (staffId: string, roles: string[]) => ({
    user: {
      id: staffId,
      email: `${staffId}@kanzlei-roth.example`,
      name: 'Person',
      fullName: 'Person',
      tenantId: DEMO.tenant,
      staffId,
      roles,
      permissions: [],
    },
    expires: inEinerStunde(),
  });
  const alsAnna = () => {
    sitzung.staff = staffSitzung(DEMO.anna, ['ADMIN']);
  };

  beforeAll(async () => {
    await owner.tenant.deleteMany({ where: { id: DEMO.tenant } });
    await owner.tenant.create({
      data: { id: DEMO.tenant, slug: `tcms-demo-${randomUUID()}`, name: 'Kanzlei Roth (Demo)' },
    });
    const person = (id: string, fullName: string, role: string, isProfessional: boolean) =>
      owner.staffUser.create({
        data: {
          id,
          tenantId: DEMO.tenant,
          email: `${id}@kanzlei-roth.example`,
          fullName,
          passwordHash: 'synthetic',
          isProfessional,
          roles: { create: [{ role: role as never }] },
        },
      });
    await person(DEMO.anna, 'StB Dr. Anna Roth', 'ADMIN', true);
    await person(DEMO.leon, 'Leon Brandt', 'EMPLOYEE', false);
    await person(DEMO.thomas, 'StB Thomas Kern', 'EMPLOYEE', true);
    const mandanten: Array<[string, string]> = [
      [DEMO.talwind, 'Talwind Outdoor GmbH'],
      [DEMO.seestern, 'Seestern Home & Living GmbH'],
      [neuerMandant, 'Neu Handel GmbH'],
      [einrichtungMandant, 'Einrichtung Live GmbH'],
    ];
    for (const [id, name] of mandanten) {
      await owner.client.create({ data: { id, tenantId: DEMO.tenant, kind: 'JURPERS', name } });
    }
    const zu = (clientId: string, staffId: string, role: 'BERUFSTRAEGER' | 'HAUPTBEARBEITER') => ({
      tenantId: DEMO.tenant,
      clientId,
      staffId,
      role,
    });
    await owner.clientResponsibility.createMany({
      data: [
        zu(DEMO.talwind, DEMO.anna, 'BERUFSTRAEGER'),
        zu(DEMO.talwind, DEMO.leon, 'HAUPTBEARBEITER'),
        zu(DEMO.seestern, DEMO.thomas, 'BERUFSTRAEGER'),
        zu(einrichtungMandant, DEMO.anna, 'BERUFSTRAEGER'),
        zu(einrichtungMandant, DEMO.leon, 'HAUPTBEARBEITER'),
      ],
    });
    const kontakt = (id: string, clientId: string, fullName: string) =>
      owner.clientContact.create({
        data: { id, tenantId: DEMO.tenant, clientId, fullName, email: `${id}@mandant.example` },
      });
    await kontakt(DEMO.jana, DEMO.talwind, 'Jana Weller');
    await kontakt(DEMO.murat, DEMO.talwind, 'Murat Yilmaz');
    await kontakt(DEMO.sabine, DEMO.talwind, 'Sabine Berg');
    await kontakt(neuerKontakt, neuerMandant, 'Nina Neu');
    await kontakt(gerda, einrichtungMandant, 'Gerda Grund');
    await owner.tenantSetting.create({
      data: { tenantId: DEMO.tenant, key: 'modules', value: { tcms: true } },
    });
    alsAnna();
  }, 60_000);

  afterAll(async () => {
    try {
      await owner.tenant.deleteMany({ where: { id: DEMO.tenant } });
    } finally {
      await owner.$disconnect();
    }
  }, 60_000);

  it('Einrichtung: fünf Schritte bis Version 1 mit Personen der kanzleikonsole; fremde Personen abgewiesen', async () => {
    const { mandantImTcmsAnlegenAction } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/actions');
    const { kontaktRollenSetzenAction } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/kontakte/actions');
    const { default: Seite } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/einrichtung/page');
    const { einrichtungSpeichernAction } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/einrichtung/actions');
    const M = einrichtungMandant;
    expect(await mandantImTcmsAnlegenAction(M, null, new FormData())).toMatchObject({ ok: true });
    expect(
      await kontaktRollenSetzenAction(
        M,
        null,
        formular({
          kontaktId: gerda,
          rollen: 'GESETZLICHER_VERTRETER',
          funktion: 'Geschäftsführerin',
        }),
      ),
    ).toEqual({ ok: true });

    /** Rendert den Schritt und liefert dessen Daten (Startwerte des Dienstes). */
    const schritt = async (n: number) => {
      const { screen, container } = await rendern(
        Seite({
          params: Promise.resolve({ id: M }),
          searchParams: Promise.resolve({ schritt: String(n) }),
        }),
      );
      expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(String(n));
      expect(container.textContent).not.toContain('Unbekannte Person');
      const daten = (container.querySelector('input[name="daten"]') as HTMLInputElement).value;
      return { screen, daten: JSON.parse(daten) as Record<string, unknown> };
    };
    const weiter = async (n: number, daten: unknown, ziel = 'weiter') =>
      einrichtungSpeichernAction(
        M,
        null,
        formular({ schritt: String(n), ziel, daten: JSON.stringify(daten) }),
      ).catch((e: unknown) => erwarteAnwendungsfehler(e, /^NEXT_REDIRECT:/).message);

    const s1 = await schritt(1);
    expect(await weiter(1, s1.daten)).toBe(
      `NEXT_REDIRECT:/staff/clients/${M}/tcms/einrichtung?schritt=2`,
    );
    const s2 = await schritt(2);
    const profil = (s2.daten as { profil: Record<string, Record<string, unknown>> }).profil;
    Object.assign(profil.p1!, { shopSystem: 'Shopware 6', marktplaetze: ['Amazon'] });
    Object.assign(profil.p4!, { warengruppen: [{ name: 'Kaffee', abweichenderSatz: true }] });
    Object.assign(profil.p6!, { zahlungswege: ['PayPal'] });
    Object.assign(profil.p7!, { gutscheine: true });
    expect(await weiter(2, { profil })).toBe(
      `NEXT_REDIRECT:/staff/clients/${M}/tcms/einrichtung?schritt=3`,
    );
    const s3 = await schritt(3);
    // Empfänger der Zielfreigabe: nur die gesetzliche Vertretung dieses Mandanten.
    const gv = s3.screen.queryByRole('combobox', { name: 'Empfänger' });
    if (gv)
      expect([...gv.querySelectorAll('option')].map((o) => o.textContent)).toContain(
        'Gerda Grund (gesetzliche Vertretung)',
      );
    const ziele = { ...s3.daten, freigabe: { anfordern: true, empfaengerId: gerda } };
    expect(
      await weiter(3, { ...ziele, freigabe: { anfordern: true, empfaengerId: neuerKontakt } }),
    ).toMatchObject({
      ok: false,
      error: 'Der gewählte Kontakt gehört nicht zu diesem Mandanten.',
    });
    expect(await weiter(3, ziele)).toBe(
      `NEXT_REDIRECT:/staff/clients/${M}/tcms/einrichtung?schritt=4`,
    );
    const s4 = await schritt(4);
    expect(await weiter(4, s4.daten)).toBe(
      `NEXT_REDIRECT:/staff/clients/${M}/tcms/einrichtung?schritt=5`,
    );

    const s5 = await schritt(5);
    const kanzlei = s5.screen.getAllByRole('combobox', { name: /^Durchführend K-EC-/ })[0]!;
    expect([...kanzlei.querySelectorAll('option')].map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['Leon Brandt', 'StB Dr. Anna Roth', 'StB Thomas Kern']),
    );
    // Kontakt eines anderen Mandanten als Gegenzeichnung: abgewiesen, bevor das TCMS gefragt wird.
    const fremd = structuredClone(s5.daten) as {
      kontrollen: Record<string, { gegenzeichnerId: string | null }>;
    };
    Object.values(fremd.kontrollen)[0]!.gegenzeichnerId = neuerKontakt;
    expect(await weiter(5, fremd, 'speichern')).toMatchObject({
      ok: false,
      error: 'Die gewählte Person hat keinen Zugriff auf diesen Mandanten.',
    });
    expect(await weiter(5, s5.daten, 'speichern')).toMatchObject({
      ok: true,
      ziel: 'speichern',
      schritt: 5,
    });
    expect(await weiter(5, s5.daten, 'anlegen')).toBe(
      `NEXT_REDIRECT:/staff/clients/${M}/tcms/einrichtung`,
    );

    const fertig = await rendern(
      Seite({ params: Promise.resolve({ id: M }), searchParams: Promise.resolve({}) }),
    );
    expect(fertig.container.textContent).toMatch(/Das Tax-CMS ist eingerichtet – Version 1 vom/);
  }, 120_000);

  it('Profil: Stände und Vorschläge des Dienstes; ohne Zuständigkeit kein Aufnehmen', async () => {
    const { default: Seite } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/profil/page');
    const { screen } = await rendern(
      Seite({ params: Promise.resolve({ id: DEMO.talwind }), searchParams: Promise.resolve({}) }),
    );
    expect(screen.getByRole('region', { name: /Geschäftsprofil P1–P12/ }).textContent).toContain(
      'Erfasst von Leon Brandt',
    );
    expect(screen.getByRole('region', { name: 'Risikovorschlag aus dem Profil' })).toBeTruthy();

    const { risikoAufnehmenAction } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/profil/actions');
    // Seestern: Berufsträger, aber keine Hauptbearbeitung zugeordnet.
    expect(
      await risikoAufnehmenAction(DEMO.seestern, null, formular({ code: 'EC-UST-01' })),
    ).toMatchObject({ ok: false, error: expect.stringContaining('keine Hauptbearbeitung') });
  }, 60_000);

  it('Beschreibung: Abschnitt, Review mit Vier-Augen-Prinzip, Freigabe mit eingefrorenen Namen', async () => {
    const { tcmsMandantSeite, tcmsLesen } = await import('@/server/tcms/seite');
    const aktionen = await import('@/app/staff/(protected)/clients/[id]/tcms/beschreibung/actions');
    const lesen = async () => {
      const seite = await tcmsMandantSeite(DEMO.talwind);
      if (!seite.ok) throw new Error(seite.zustand.art);
      const r = await tcmsLesen(seite, ENDPUNKTE.beschreibungLesen);
      if (!r.ok) throw new Error(r.zustand.art);
      return r.daten;
    };

    // Offene Version suchen bzw. anlegen (wiederholbar).
    let b = await lesen();
    let v = b.versionen.find((x) => x.status === 'ENTWURF' || x.status === 'KANZLEI_REVIEW');
    if (!v) {
      const angelegt = await aktionen
        .versionAnlegenAction(DEMO.talwind, null, new FormData())
        .catch((e: Error) => e);
      expect(String(angelegt)).toContain('NEXT_REDIRECT:');
      b = await lesen();
      v = b.versionen.at(-1)!;
    }
    if (v.status === 'KANZLEI_REVIEW') {
      expect(
        await aktionen.reviewZurueckweisenAction(
          DEMO.talwind,
          null,
          formular({
            versionId: v.id,
            begruendung: 'Live-Test: zurück in den Entwurf für den Ablauf.',
          }),
        ),
      ).toMatchObject({ ok: true });
    }
    const versionId = v.id;

    const text = `Live-Test ${new Date().toISOString()}`;
    expect(
      await aktionen.abschnittSpeichernAction(
        DEMO.talwind,
        null,
        formular({ versionId, key: 'kultur', struktur: '[{"typ":"text"}]', text }),
      ),
    ).toMatchObject({ ok: true, meldung: expect.stringContaining('gespeichert') });
    expect(
      await aktionen.zurReviewAction(DEMO.talwind, null, formular({ versionId })),
    ).toMatchObject({ ok: true });

    // Anna hat zuletzt bearbeitet: Vier-Augen-Prinzip (feste Meldung, kein Text des Dienstes).
    expect(
      await aktionen.reviewAbschliessenAction(DEMO.talwind, null, formular({ versionId })),
    ).toEqual({
      ok: false,
      error: 'Vier-Augen-Prinzip: Diesen Schritt muss eine andere Person ausführen.',
      errorCode: 'FORBIDDEN',
    });
    sitzung.staff = staffSitzung(DEMO.leon, ['EMPLOYEE']);
    try {
      expect(
        await aktionen.reviewAbschliessenAction(DEMO.talwind, null, formular({ versionId })),
      ).toMatchObject({ ok: true });
    } finally {
      alsAnna();
    }

    // Empfänger eines anderen Mandanten: abgewiesen, bevor das TCMS gefragt wird.
    expect(
      await aktionen.freigabeAnfordernAction(
        DEMO.talwind,
        null,
        formular({ versionId, empfaengerId: neuerKontakt }),
      ),
    ).toMatchObject({ ok: false, fieldErrors: { empfaengerId: [expect.any(String)] } });
    const angefordert = await aktionen.freigabeAnfordernAction(
      DEMO.talwind,
      null,
      formular({ versionId, empfaengerId: DEMO.jana }),
    );
    expect(angefordert).toMatchObject({
      ok: true,
      meldung: expect.stringContaining('bei Jana Weller angefordert'),
    });

    const { default: Seite } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/beschreibung/page');
    const { screen } = await rendern(
      Seite({
        params: Promise.resolve({ id: DEMO.talwind }),
        searchParams: Promise.resolve({ version: versionId, abschnitt: 'organisation' }),
      }),
    );
    const snap = screen.getByRole('region', { name: 'Eingefrorener Inhalt' });
    expect(snap.textContent).toContain('Hash geprüft: Inhalt unverändert');
    expect(snap.textContent).toMatch(/SHA-256 [0-9a-f]{64}/);
    const abschnitt = screen.getByRole('region', { name: /^Abschnitt 5/ });
    // Eingefrorene Namen stammen aus der kanzleikonsole (Namen beim Anfordern).
    expect(abschnitt.textContent).toContain('Gesetzliche Vertretung: Jana Weller');
    expect(abschnitt.textContent).toContain('StB Dr. Anna Roth');
    expect(abschnitt.textContent).not.toContain('Unbekannte Person');
    expect(abschnitt.querySelector('textarea')).toBeNull();
  }, 120_000);

  it('Kommunikation: Neuadressierung an Kontakte dieses Mandanten (hin und zurück)', async () => {
    const { tcmsMandantSeite, tcmsLesen } = await import('@/server/tcms/seite');
    const seite = await tcmsMandantSeite(DEMO.talwind);
    if (!seite.ok) throw new Error(seite.zustand.art);
    const h = await tcmsLesen(seite, ENDPUNKTE.freigabenHistorieLesen);
    if (!h.ok) throw new Error(h.zustand.art);
    const kenntnis = h.daten.freigaben.find(
      (f) => f.art === 'KENNTNISNAHME' && f.status === 'OFFEN',
    )!;
    expect(kenntnis).toBeTruthy();

    const { freigabeNeuadressierenAction } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/kommunikation/actions');
    const an = (empfaengerId: string) =>
      freigabeNeuadressierenAction(
        DEMO.talwind,
        null,
        formular({ freigabeId: kenntnis.id, empfaengerId }),
      );
    expect(await an(neuerKontakt)).toMatchObject({
      ok: false,
      error: 'Der gewählte Kontakt gehört nicht zu diesem Mandanten.',
    });
    expect(await an(DEMO.sabine)).toMatchObject({
      ok: true,
      meldung: expect.stringContaining('an Sabine Berg adressiert'),
    });
    expect(await an(kenntnis.empfaengerId)).toMatchObject({ ok: true });

    const { default: Seite } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/kommunikation/page');
    const { screen } = await rendern(
      Seite({ params: Promise.resolve({ id: DEMO.talwind }), searchParams: Promise.resolve({}) }),
    );
    const freigaben = screen.getByRole('table', { name: 'Freigaben' });
    expect(freigaben.textContent).toContain('Jana Weller');
    expect(screen.getByRole('table', { name: 'Kenntnisnahmen' }).textContent).toContain(
      'Murat Yilmaz',
    );
  }, 60_000);
});
