'use server';

// =============================================================================
// Kontrollaufgabe im Portal (TCMS Stufe 3, Bereich D; aus der Demo
// server/actions/portal-aufgabe.ts und server/durchfuehrung-daten.ts).
//
// Mandant und Person kommen nur aus der Portal-Sitzung (tcmsPortalAktion).
// Sichtbarkeit (eigene Seite, zugewiesen oder GV/TCB), Bearbeitungsrecht,
// Vier-Augen beim Bestätigen und Status prüft das Tax-CMS. Die kanzleikonsole
// nimmt Dateien an (Portal-Dokumentenpipeline, server/tcms/portal/anlagen.ts)
// – erst nachdem das Tax-CMS für diese Aufgabe das Bearbeitungsrecht meldet,
// damit Unberechtigte keine Dateien ablegen – und hängt Verweise aus der
// gespeicherten Fassung an.
// =============================================================================

import { z } from 'zod';
import {
  DurchfuehrungBegruendungBodySchema,
  DurchfuehrungIdSchema,
  ENDPUNKTE,
  NachweisIdSchema,
} from '@taxtronik/tcms-contract';
import { parseActionInput, parseFormData } from '@/server/actions/form-data';
import type { ActionFailure } from '@/server/actions/action-runner';
import type { ActionResult } from '@/server/actions/types';
import { tcmsPortalAktion } from '@/server/tcms/aktion';
import {
  dateiSha256,
  portalAblageKontext,
  portalAnlageAblegen,
  portalDateienFeld,
} from '@/server/tcms/portal/anlagen';
import { koerperAusFormular, type AufgabeFormular } from '@/server/tcms/portal/aufgabe';

type Ergebnis = ActionResult & { meldung?: string; warnung?: string };
/** Rückgabe des Dienstaufrufs: Fehlerergebnis oder Meldung (Nutzlast). */
type Lauf = ActionFailure | { meldung?: string; warnung?: string };

const NICHT_GEFUNDEN = 'Diese Aufgabe wurde nicht gefunden. Bitte laden Sie die Seite neu.';
const Aufgabe = z.object({ durchfuehrungId: DurchfuehrungIdSchema });
const Anlage = z.object({ durchfuehrungId: DurchfuehrungIdSchema, nachweisId: NachweisIdSchema });

// ---------------------------------------------------------------------------
// Entwurf speichern / übermitteln
// ---------------------------------------------------------------------------

/** Felder `schritt_<i>_erledigt|kommentar`, `wert_<key>`, `bemerkung_<key>`, `erklaert_<key>`, `ergebnis`, `ergebnisKommentar`. */
const SpeichernFormular = z
  .object({ absicht: z.enum(['speichern', 'einreichen']) })
  .catchall(z.string().max(4000));

export async function portalAufgabeSpeichernAction(
  durchfuehrungId: string,
  _vorher: Ergebnis | null,
  formData: FormData,
): Promise<Ergebnis> {
  return tcmsPortalAktion({
    keinRecht: 'PORTAL_ZUGEORDNET',
    felder: {
      schritte: 'schritte',
      werte: 'werte',
      ergebnis: 'ergebnis',
      ergebnisKommentar: 'ergebnisKommentar',
    },
    parse: () => {
      const p = parseActionInput(Aufgabe, { durchfuehrungId }, NICHT_GEFUNDEN);
      if (!p.ok) return p;
      const f = parseFormData(SpeichernFormular, formData);
      return f.ok ? { ok: true, data: { ...p.data, formular: f.data as AufgabeFormular } } : f;
    },
    aufruf: async (dienst, d): Promise<Lauf> => {
      const params = { durchfuehrungId: d.durchfuehrungId };
      // Aufbau (Schritte, Kennzahlen) und Sichtbarkeit laut Dienst.
      const { daten: a } = await dienst.rufe(ENDPUNKTE.portalAufgabeLesen, { params });
      const koerper = koerperAusFormular(a, d.formular);
      if (!koerper.ok) return koerper;
      const { daten: s } = await dienst.rufe(ENDPUNKTE.portalAufgabeSpeichern, {
        params,
        body: koerper.body,
      });
      if (d.formular['absicht'] !== 'einreichen') return { meldung: 'Entwurf gespeichert.' };
      // Übermitteln nur, wenn die Prüfung des gespeicherten Stands (Dienst) keine Mängel
      // nennt; die Mängel sind Teil der Antwort (`pruefung.maengel`), keine Fehlermeldung.
      if (s.pruefung.maengel.length > 0) {
        return {
          warnung: `Entwurf gespeichert, aber noch nicht übermittelt: ${s.pruefung.maengel.join(' · ')}.`,
        };
      }
      await dienst.rufe(ENDPUNKTE.portalAufgabeEinreichen, { params });
      return {
        meldung: a.kontrolle.gegenzeichnungMandant
          ? 'Übermittelt. Eine zweite Person bei Ihnen bestätigt nun die Vollständigkeit.'
          : 'An die Kanzlei übermittelt. Die Anlagen sind jetzt gesperrt.',
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Anlagen
// ---------------------------------------------------------------------------

const AnlagenFormular = z.object({
  dateien: portalDateienFeld({ pflicht: true }),
});

export async function portalAnlagenHochladenAction(
  durchfuehrungId: string,
  _vorher: Ergebnis | null,
  formData: FormData,
): Promise<Ergebnis> {
  return tcmsPortalAktion({
    keinRecht: 'PORTAL_ZUGEORDNET',
    parse: () => {
      const p = parseActionInput(Aufgabe, { durchfuehrungId }, NICHT_GEFUNDEN);
      if (!p.ok) return p;
      const f = parseFormData(AnlagenFormular, formData, { repeatable: ['dateien'] });
      return f.ok ? { ok: true, data: { ...p.data, dateien: f.data.dateien } } : f;
    },
    vorbereiten: (_tx, k) => portalAblageKontext(k.g),
    aufruf: async (dienst, d, g): Promise<Lauf> => {
      const params = { durchfuehrungId: d.durchfuehrungId };
      // Erst das Recht laut Dienst, dann Dateien annehmen: ohne Recht wird nichts abgelegt.
      const { daten: a } = await dienst.rufe(ENDPUNKTE.portalAufgabeLesen, { params });
      if (!a.rechte.bearbeiten.erlaubt) {
        return {
          ok: false,
          error: 'Für diese Aufgabe können Sie derzeit keine Anlagen hochladen.',
          errorCode: 'FORBIDDEN',
        };
      }
      // Gleicher Inhalt in derselben Aufgabe wird übersprungen (wie in der Demo).
      const vorhanden = new Set(a.nachweise.map((n) => n.sha256));
      const neu: File[] = [];
      const doppelt: string[] = [];
      for (const datei of d.dateien) {
        const sha = await dateiSha256(datei);
        if (vorhanden.has(sha)) doppelt.push(datei.name);
        else {
          vorhanden.add(sha);
          neu.push(datei);
        }
      }
      if (neu.length === 0) {
        return {
          ok: false,
          error: `Bereits vorhanden: ${doppelt.join(', ')}.`,
          errorCode: 'CONFLICT',
        };
      }
      for (const datei of neu) {
        const verweis = await portalAnlageAblegen(g, datei);
        await dienst.rufe(ENDPUNKTE.portalAnlageAnhaengen, { params, body: { verweis } });
      }
      const teil = neu.length === 1 ? '1 Datei hochgeladen' : `${neu.length} Dateien hochgeladen`;
      return {
        meldung: doppelt.length ? `${teil}; bereits vorhanden: ${doppelt.join(', ')}.` : `${teil}.`,
      };
    },
  });
}

export async function portalAnlageEntfernenAction(
  durchfuehrungId: string,
  nachweisId: string,
  _vorher: Ergebnis | null,
  _formData: FormData,
): Promise<Ergebnis> {
  return tcmsPortalAktion({
    keinRecht: 'PORTAL_ZUGEORDNET',
    parse: () => parseActionInput(Anlage, { durchfuehrungId, nachweisId }, NICHT_GEFUNDEN),
    aufruf: async (dienst, p): Promise<Lauf> => {
      await dienst.rufe(ENDPUNKTE.portalAnlageEntfernen, { params: p });
      return { meldung: 'Anlage entfernt.' };
    },
  });
}

// ---------------------------------------------------------------------------
// Zweite Person beim Mandanten
// ---------------------------------------------------------------------------

const BegruendungFormular = z.object({ ...DurchfuehrungBegruendungBodySchema.shape });

export async function portalAufgabeZurueckgebenAction(
  durchfuehrungId: string,
  _vorher: Ergebnis | null,
  formData: FormData,
): Promise<Ergebnis> {
  return tcmsPortalAktion({
    keinRecht: 'STANDARD',
    felder: { begruendung: 'begruendung' },
    parse: () => {
      const p = parseActionInput(Aufgabe, { durchfuehrungId }, NICHT_GEFUNDEN);
      if (!p.ok) return p;
      const f = parseFormData(BegruendungFormular, formData);
      return f.ok ? { ok: true, data: { ...p.data, body: f.data } } : f;
    },
    aufruf: async (dienst, d): Promise<Lauf> => {
      await dienst.rufe(ENDPUNKTE.portalAufgabeZurueckgeben, {
        params: { durchfuehrungId: d.durchfuehrungId },
        body: d.body,
      });
      return {
        meldung:
          'Zur Überarbeitung zurückgegeben. Die durchführende Person kann die Angaben ergänzen und erneut übermitteln.',
      };
    },
  });
}

export async function portalAufgabeBestaetigenAction(
  durchfuehrungId: string,
  _vorher: Ergebnis | null,
  _formData: FormData,
): Promise<Ergebnis> {
  return tcmsPortalAktion({
    keinRecht: 'STANDARD',
    parse: () => parseActionInput(Aufgabe, { durchfuehrungId }, NICHT_GEFUNDEN),
    aufruf: async (dienst, p): Promise<Lauf> => {
      await dienst.rufe(ENDPUNKTE.portalAufgabeBestaetigen, { params: p });
      return {
        meldung: 'Vollständigkeit bestätigt. Die Kanzlei prüft nun und schließt die Aufgabe ab.',
      };
    },
  });
}
