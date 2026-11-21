import type { ReactNode } from 'react';
import { expect, it } from 'vitest';
import { within } from '@testing-library/dom';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { rufeEndpunkt } from '@taxtronik/tcms-client';
import {
  ergaenzeTestnachweise,
  neuerNachtrag,
} from '../../../../../../packages/tcms-client/src/__tests__/durchfuehrung-fixture';
import { DEMO } from '@/__tests__/tcms-fixtures';
import { tcmsClient } from '../dienst';
import { tcmsMandantSeite, tcmsPortalSeite } from '../seite';
import { TCMS_AKTION_TEXTE } from '../zustand';

type Person = 'leon' | 'anna' | 'murat';
type Kanal = 'Kanzlei' | 'Portal';
type Rendern = (seite: ReactNode | Promise<ReactNode>) => Promise<{ container: HTMLElement }>;

function formularDaten(knopf: HTMLButtonElement) {
  expect(knopf.disabled).toBe(false);
  const formular = knopf.form!;
  const dom = formular.ownerDocument.defaultView!;
  const daten = new FormData();
  for (const [name, wert] of new dom.FormData(formular, knopf).entries()) {
    if (typeof wert !== 'string') throw new Error(`Unerwartete Datei im Feld ${name}.`);
    daten.append(name, wert);
  }
  return daten;
}

/** TCMS-DIENST-001. Seiten, Formularfelder, Server-Aktionen und Dienst benutzen dieselbe Demo. */
export function pruefeDurchfuehrungsformulare(als: (person: Person) => void, rendern: Rendern) {
  async function akteur(person: Person) {
    als(person);
    const seite =
      person === 'murat' ? await tcmsPortalSeite() : await tcmsMandantSeite(DEMO.talwind);
    if (!seite.ok) throw new Error(seite.zustand.art);
    return seite.akteur;
  }
  async function oeffnen(id: string, kanal: Kanal) {
    if (kanal === 'Portal') {
      const { default: Seite } = await import('@/app/portal/(protected)/tcms/aufgaben/[id]/page');
      return (
        await rendern(Seite({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }))
      ).container;
    }
    const { default: Seite } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/durchfuehrungen/[did]/page');
    return (
      await rendern(
        Seite({
          params: Promise.resolve({ id: DEMO.talwind, did: id }),
          searchParams: Promise.resolve({}),
        }),
      )
    ).container;
  }

  it.each(['Kanzlei', 'Portal'] as const)(
    'Formularstand %s: veraltetes Einreichen verwirft keine neueren Angaben, neues Formular reicht ein',
    async (kanal) => {
      const client = tcmsClient()!;
      const portal = kanal === 'Portal';
      const params = await neuerNachtrag(
        client,
        portal ? 'K-EC-02' : 'K-EC-13',
        DEMO.talwind,
        await akteur('leon'),
      );
      const ziel = { params, akteur: await akteur(portal ? 'murat' : 'leon') };
      const lesen = () =>
        rufeEndpunkt(
          client,
          portal ? ENDPUNKTE.portalAufgabeLesen : ENDPUNKTE.durchfuehrungLesen,
          ziel,
        );
      const { daten: aufgabe } = await lesen();
      await ergaenzeTestnachweise(
        client,
        ziel,
        aufgabe.pruefung.mindestNachweise,
        portal ? ENDPUNKTE.portalAnlageAnhaengen : ENDPUNKTE.nachweisAnhaengen,
      );
      const { durchfuehrungSpeichernAction, durchfuehrungBeginnenAction } =
        await import('@/app/staff/(protected)/clients/[id]/tcms/durchfuehrungen/[did]/actions');
      const { portalAufgabeSpeichernAction } =
        await import('@/app/portal/(protected)/tcms/aufgaben/[id]/actions');
      const sende = (daten: FormData) =>
        portal
          ? portalAufgabeSpeichernAction(params.durchfuehrungId, null, daten)
          : durchfuehrungSpeichernAction(params.mandantId, params.durchfuehrungId, null, daten);

      async function eingabe(absicht: 'speichern' | 'einreichen', kommentar: string) {
        const dom = await oeffnen(params.durchfuehrungId, kanal);
        const knopf = dom.querySelector<HTMLButtonElement>(
          `button[name="absicht"][value="${absicht}"]`,
        )!;
        const vorEingabe = formularDaten(knopf);
        expect(vorEingabe.get('bisher')).toBe((await lesen()).daten.inhalt);
        const schritte = dom.querySelectorAll<HTMLInputElement>(
          'input[name^="schritt_"][name$="_erledigt"]',
        );
        expect(schritte.length).toBeGreaterThan(0);
        for (const feld of schritte) feld.checked = true;
        dom.querySelector<HTMLInputElement>(
          'input[name="ergebnis"][value="OHNE_BEFUND"]',
        )!.checked = true;
        dom.querySelector<HTMLTextAreaElement>('textarea[name="ergebnisKommentar"]')!.value =
          kommentar;
        return formularDaten(knopf);
      }

      if (!portal) {
        const start = await oeffnen(params.durchfuehrungId, kanal);
        const knopf = within(start).getByRole<HTMLButtonElement>('button', {
          name: /Durchführung beginnen/,
        });
        expect(
          await durchfuehrungBeginnenAction(
            params.mandantId,
            params.durchfuehrungId,
            null,
            formularDaten(knopf),
          ),
        ).toMatchObject({ ok: true });
      }
      const alt = await eingabe('einreichen', 'Stand des ersten Formulars');
      const parallel = await eingabe('speichern', 'Nach Öffnen des ersten Formulars geändert');
      expect(await sende(parallel)).toMatchObject({ ok: true, meldung: 'Entwurf gespeichert.' });
      const geaendert = (await lesen()).daten;
      expect(geaendert.inhalt).not.toBe(alt.get('bisher'));
      expect(await sende(alt)).toMatchObject({
        ok: false,
        errorCode: 'CONFLICT',
        error: TCMS_AKTION_TEXTE.konflikt,
      });
      expect((await lesen()).daten).toMatchObject({
        status: 'IN_DURCHFUEHRUNG',
        inhalt: geaendert.inhalt,
        ergebnisKommentar: parallel.get('ergebnisKommentar'),
      });
      const frisch = await eingabe('einreichen', 'Aktueller, zur Einreichung geprüfter Stand');
      expect(await sende(frisch)).toMatchObject({
        ok: true,
        meldung: expect.stringMatching(portal ? /übermittelt/i : /eingereicht/i),
      });
      expect((await lesen()).daten).toMatchObject({
        status: 'ZUR_GEGENZEICHNUNG',
        ergebnisKommentar: frisch.get('ergebnisKommentar'),
      });
      await rufeEndpunkt(client, ENDPUNKTE.durchfuehrungGegenzeichnen, {
        params,
        akteur: await akteur('anna'),
        body: {},
      });
    },
    60000,
  );

  it('Formularstand Entfallen: nur der im Freigabeformular angezeigte Antrag wird bestätigt', async () => {
    const client = tcmsClient()!;
    const params = await neuerNachtrag(client, 'K-EC-06', DEMO.talwind, await akteur('leon'));
    const id = params.durchfuehrungId;
    const aktionen =
      await import('@/app/staff/(protected)/clients/[id]/tcms/durchfuehrungen/[did]/actions');
    async function beantrage(text: string) {
      als('leon');
      const fd = new FormData();
      fd.set('begruendung', text);
      expect(await aktionen.entfallenBeantragenAction(DEMO.talwind, id, null, fd)).toMatchObject({
        ok: true,
      });
    }
    async function freigabe() {
      const ziel = { params, akteur: await akteur('anna') };
      const { daten } = await rufeEndpunkt(client, ENDPUNKTE.durchfuehrungLesen, ziel);
      const dom = await oeffnen(id, 'Kanzlei');
      const merkmal = dom.querySelector<HTMLInputElement>('input[name="antrag"]')!;
      const fd = formularDaten(
        merkmal.form!.querySelector<HTMLButtonElement>('button[type="submit"]')!,
      );
      expect(fd.get('antrag')).toMatch(/^[a-f0-9]{64}$/);
      expect(fd.get('antrag')).toBe(daten.entfallenAntrag);
      return fd;
    }

    await beantrage('Der Standort ist im ganzen Prüfzeitraum planmäßig geschlossen.');
    const alt = await freigabe();
    als('leon');
    expect(
      await aktionen.entfallenAblehnenAction(DEMO.talwind, id, null, new FormData()),
    ).toMatchObject({ ok: true });
    await beantrage('Die Kontrollgrundlage hat sich seit der letzten Beantragung geändert.');
    const frisch = await freigabe();
    expect(frisch.get('antrag')).not.toBe(alt.get('antrag'));
    expect(await aktionen.entfallenFreigebenAction(DEMO.talwind, id, null, alt)).toMatchObject({
      ok: false,
      errorCode: 'CONFLICT',
      error: TCMS_AKTION_TEXTE.konflikt,
    });
    expect((await freigabe()).get('antrag')).toBe(frisch.get('antrag'));
    expect(await aktionen.entfallenFreigebenAction(DEMO.talwind, id, null, frisch)).toMatchObject({
      ok: true,
      meldung: expect.stringMatching(/Entfallen freigegeben/),
    });
    const detail = await rufeEndpunkt(client, ENDPUNKTE.durchfuehrungLesen, {
      params,
      akteur: await akteur('anna'),
    });
    expect(detail.daten).toMatchObject({ status: 'ENTFALLEN', entfallenFreigegebenVon: DEMO.anna });
  }, 60000);
}
