'use server';

// =============================================================================
// Ereigniseingang und Triage (TCMS Stufe 3, Bereich D; aus der Demo
// server/actions/ereignisse.ts). Dünne Hüllen um die Endpunkte des Dienstes:
// Rechte (kannBearbeiten), Status, Vier-Augen beim Verwerfen, TS-04 (Auswirkung
// „nein“ nur mit Würdigungsrecht) und Audit entscheidet ausschließlich das
// Tax-CMS. Die kanzleikonsole bindet den Mandanten (gebundenes Argument, nie
// aus dem Formular) und prüft Personen der Zuständigkeit gegen den Mandanten.
// =============================================================================

import { z } from 'zod';
import {
  ENDPUNKTE,
  EreignisErfassenBodySchema,
  FolgeAnlegenSchema,
  FolgeHinzufuegenBodySchema,
  ObjektIdSchema,
  VerwerfenBeantragenBodySchema,
} from '@taxtronik/tcms-contract';
import {
  formEmpty,
  formList,
  parseActionInput,
  parseFormData,
  validationFailure,
} from '@/server/actions/form-data';
import type { ActionResult } from '@/server/actions/types';
import { tcmsKanzleiAktion } from '@/server/tcms/aktion';
import { meldungsAnlagenNachVerwerfen } from '@/server/tcms/portal/meldung';
import { vertragsZeichenMeldung } from '@/server/tcms/zeichen';
import {
  pruefeZuweisungenTx,
  zuweisungAusFormular,
  type TcmsZuweisung,
} from '@/server/tcms/ereignisse/personen';

type Ergebnis = ActionResult & { meldung?: string };

const Ids = z.object({ ereignisId: ObjektIdSchema });
const FolgeIds = z.object({ ereignisId: ObjektIdSchema, folgeId: ObjektIdSchema });

/** Pfad-IDs (gebundene Argumente) prüfen; ungültig → feste Meldung ohne Dienstaufruf. */
function ids<T extends z.ZodType>(schema: T, roh: unknown) {
  return parseActionInput(
    schema,
    roh,
    'Der Eintrag wurde nicht gefunden. Bitte laden Sie die Seite neu.',
  );
}

const ErfassenFormular = z.object({
  ...EreignisErfassenBodySchema.shape,
});

export async function ereignisErfassenAction(
  mandantId: string,
  _vorher: Ergebnis | null,
  formData: FormData,
): Promise<Ergebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: {
      typ: 'typ',
      quelle: 'quelle',
      titel: 'titel',
      beschreibung: 'beschreibung',
      datum: 'datum',
    },
    parse: () => parseFormData(ErfassenFormular, formData),
    aufruf: async (dienst, daten) => {
      const { daten: r } = await dienst.rufe(ENDPUNKTE.ereignisErfassen, { body: daten });
      return {
        meldung: `Ereignis ${r.nummer} erfasst – ${r.folgen} ${r.folgen === 1 ? 'Folge' : 'Folgen'} vorgeschlagen.`,
      };
    },
  });
}

export async function ereignisInPruefungNehmenAction(
  mandantId: string,
  ereignisId: string,
  _vorher: Ergebnis | null,
  _formData: FormData,
): Promise<Ergebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    parse: () => ids(Ids, { ereignisId }),
    aufruf: async (dienst, p) => {
      await dienst.rufe(ENDPUNKTE.ereignisInPruefungNehmen, { params: p });
      return { meldung: 'In Prüfung genommen.' };
    },
  });
}

const WeitereFolgeFormular = z.object({
  art: FolgeHinzufuegenBodySchema.shape.art,
  ziel: formEmpty(null, FolgeHinzufuegenBodySchema.shape.ziel),
  text: FolgeHinzufuegenBodySchema.shape.text,
});

export async function folgeHinzufuegenAction(
  mandantId: string,
  ereignisId: string,
  _vorher: Ergebnis | null,
  formData: FormData,
): Promise<Ergebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: { art: 'art', ziel: 'ziel', text: 'text' },
    parse: () => {
      const p = ids(Ids, { ereignisId });
      if (!p.ok) return p;
      const f = parseFormData(WeitereFolgeFormular, formData);
      return f.ok ? { ok: true, data: { ...p.data, body: f.data } } : f;
    },
    aufruf: async (dienst, d) => {
      await dienst.rufe(ENDPUNKTE.folgeHinzufuegen, {
        params: { ereignisId: d.ereignisId },
        body: d.body,
      });
      return { meldung: 'Folge vorgeschlagen – jetzt auswählen und anlegen.' };
    },
  });
}

/**
 * Formular „Folgen anlegen“: `folge` (Mehrfachauswahl) und je Folge
 * `zustaendig_<id>` (K:/M:-Person), `frist_<id>` und bei „Feststellung
 * anlegen“ `ftitel_<id>`, `fklasse_<id>`, `fschwere_<id>`, `fauswirkung_<id>`.
 */
const FolgenFormular = z
  .object({
    folge: formList(
      z.array(ObjektIdSchema).min(1, 'Bitte mindestens eine Folge auswählen.').max(50),
    ),
  })
  .catchall(z.string().max(300));

type FolgeEingabe = z.input<typeof FolgeAnlegenSchema>;

interface FolgenDaten {
  ereignisId: string;
  folgen: Array<Omit<FolgeEingabe, 'zustaendig'>>;
  zuweisungen: Array<{ feld: string; roh: string | undefined }>;
}

function text(daten: Record<string, unknown>, feld: string): string | undefined {
  const wert = daten[feld];
  if (typeof wert !== 'string') return undefined;
  const getrimmt = wert.trim();
  return getrimmt === '' ? undefined : getrimmt;
}

function folgenAusFormular(ereignisId: string, formData: FormData) {
  const p = ids(Ids, { ereignisId });
  if (!p.ok) return p;
  const f = parseFormData(FolgenFormular, formData, { repeatable: ['folge'] });
  if (!f.ok) return f;
  const daten = f.data as Record<string, unknown> & { folge: string[] };
  const folgen: FolgenDaten['folgen'] = [];
  const zuweisungen: FolgenDaten['zuweisungen'] = [];
  for (const id of new Set(daten.folge)) {
    const titel = text(daten, `ftitel_${id}`);
    const klasse = text(daten, `fklasse_${id}`);
    const schwere = text(daten, `fschwere_${id}`);
    const auswirkung = text(daten, `fauswirkung_${id}`);
    const feststellung =
      titel || klasse || schwere || auswirkung
        ? { titel: titel ?? '', klasse, schwere, auswirkung }
        : undefined;
    folgen.push({
      folgeId: id,
      frist: text(daten, `frist_${id}`) ?? null,
      ...(feststellung ? { feststellung: feststellung as FolgeEingabe['feststellung'] } : {}),
    });
    zuweisungen.push({ feld: `zustaendig_${id}`, roh: text(daten, `zustaendig_${id}`) });
  }
  // Ohne Zuständigkeit gegen den Vertrag prüfen (sie kommt erst nach der Personenprüfung dazu).
  const ohnePerson = FolgeAnlegenSchema.omit({ zustaendig: true });
  for (const folge of folgen) {
    const geprueft = ohnePerson.safeParse(folge);
    if (!geprueft.success) {
      const issue = geprueft.error.issues[0];
      const feld = issue?.path[0] === 'frist' ? 'frist' : 'ftitel';
      // Unzulässige Zeichen im Titel (einzeilig, TCMS s8): Text des Vertrags.
      const meldung =
        (issue && vertragsZeichenMeldung(issue.message)) ?? 'Bitte prüfen Sie diese Angabe.';
      return validationFailure(
        [{ path: [`${feld}_${folge.folgeId}`], message: meldung }],
        'Bitte prüfen Sie die Angaben der gewählten Folgen (Feststellung: Titel mind. 5 Zeichen, Klasse, Schwere und Auswirkung; Frist als Datum).',
      );
    }
  }
  return { ok: true as const, data: { ereignisId: p.data.ereignisId, folgen, zuweisungen } };
}

export async function folgenAnlegenAction(
  mandantId: string,
  ereignisId: string,
  _vorher: Ergebnis | null,
  formData: FormData,
): Promise<Ergebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: { folgen: 'folge' },
    parse: () => folgenAusFormular(ereignisId, formData),
    // Personen der Zuständigkeit: nur Kanzleipersonen mit Zugriff bzw. Kontakte dieses Mandanten.
    vorbereiten: async (tx, k, daten) => {
      const zuweisungen = daten.zuweisungen.map((z) => ({
        feld: z.feld,
        zuweisung: zuweisungAusFormular(z.roh, z.feld),
      }));
      await pruefeZuweisungenTx(tx, { tenantId: k.g.tenantId, mandantId }, zuweisungen);
      return zuweisungen.map((z) => z.zuweisung);
    },
    aufruf: async (dienst, daten, personen: Array<TcmsZuweisung | null>) => {
      const { daten: r } = await dienst.rufe(ENDPUNKTE.folgenAnlegen, {
        params: { ereignisId: daten.ereignisId },
        body: {
          folgen: daten.folgen.map((f, i) => ({ ...f, zustaendig: personen[i] ?? null })),
        },
      });
      const herabgestuft = r.folgen.some((f) => f.auswirkungHerabgestuft);
      const anzahl = r.folgen.length;
      return {
        meldung:
          `${anzahl} ${anzahl === 1 ? 'Folge' : 'Folgen'} angelegt.` +
          (herabgestuft
            ? ' Die Feststellung wurde mit steuerlicher Auswirkung „unklar“ angelegt – „keine Auswirkung“ ist der §-153-Würdigung vorbehalten.'
            : ''),
      };
    },
  });
}

export async function folgeErledigenAction(
  mandantId: string,
  ereignisId: string,
  folgeId: string,
  _vorher: Ergebnis | null,
  _formData: FormData,
): Promise<Ergebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    parse: () => ids(FolgeIds, { ereignisId, folgeId }),
    aufruf: async (dienst, p) => {
      await dienst.rufe(ENDPUNKTE.folgeErledigen, { params: p });
      return { meldung: 'Folge erledigt.' };
    },
  });
}

const BegruendungFormular = z.object({ ...VerwerfenBeantragenBodySchema.shape });

export async function folgeVerwerfenAction(
  mandantId: string,
  ereignisId: string,
  folgeId: string,
  _vorher: Ergebnis | null,
  formData: FormData,
): Promise<Ergebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: { begruendung: 'begruendung' },
    parse: () => {
      const p = ids(FolgeIds, { ereignisId, folgeId });
      if (!p.ok) return p;
      const f = parseFormData(BegruendungFormular, formData);
      return f.ok ? { ok: true, data: { ...p.data, body: f.data } } : f;
    },
    aufruf: async (dienst, d) => {
      await dienst.rufe(ENDPUNKTE.folgeVerwerfen, {
        params: { ereignisId: d.ereignisId, folgeId: d.folgeId },
        body: d.body,
      });
      return { meldung: 'Folge begründet verworfen.' };
    },
  });
}

export async function ereignisAbschliessenAction(
  mandantId: string,
  ereignisId: string,
  _vorher: Ergebnis | null,
  _formData: FormData,
): Promise<Ergebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    parse: () => ids(Ids, { ereignisId }),
    aufruf: async (dienst, p) => {
      const { daten: r } = await dienst.rufe(ENDPUNKTE.ereignisAbschliessen, { params: p });
      return { meldung: `Ereignis ${r.nummer} erledigt.` };
    },
  });
}

export async function ereignisVerwerfenBeantragenAction(
  mandantId: string,
  ereignisId: string,
  _vorher: Ergebnis | null,
  formData: FormData,
): Promise<Ergebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    felder: { begruendung: 'begruendung' },
    parse: () => {
      const p = ids(Ids, { ereignisId });
      if (!p.ok) return p;
      const f = parseFormData(BegruendungFormular, formData);
      return f.ok ? { ok: true, data: { ...p.data, body: f.data } } : f;
    },
    aufruf: async (dienst, d) => {
      await dienst.rufe(ENDPUNKTE.ereignisVerwerfenBeantragen, {
        params: { ereignisId: d.ereignisId },
        body: d.body,
      });
      return { meldung: 'Verwerfen beantragt. Eine zweite Person muss bestätigen.' };
    },
  });
}

export async function ereignisVerwerfenBestaetigenAction(
  mandantId: string,
  ereignisId: string,
  _vorher: Ergebnis | null,
  _formData: FormData,
): Promise<Ergebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    // Vier-Augen: Ablehnung des Dienstes (dieselbe Person) mit festem Text.
    keinRecht: 'VIER_AUGEN',
    parse: () => ids(Ids, { ereignisId }),
    vorbereiten: async (_tx, k) => k.g.ctx,
    aufruf: async (dienst, p, ctx) => {
      const { daten: r } = await dienst.rufe(ENDPUNKTE.ereignisVerwerfenBestaetigen, { params: p });
      // Anlagen einer Portal-Meldung erst nach der eindeutigen Antwort freigeben
      // (TCMS-NACHWEIS-001); der Mandant ist der gebundene der Aktion.
      await meldungsAnlagenNachVerwerfen(ctx, { mandantId, ereignisId: p.ereignisId }, r);
      return { meldung: `Ereignis ${r.nummer} verworfen.` };
    },
  });
}

export async function ereignisVerwerfenAblehnenAction(
  mandantId: string,
  ereignisId: string,
  _vorher: Ergebnis | null,
  _formData: FormData,
): Promise<Ergebnis> {
  return tcmsKanzleiAktion({
    mandantId,
    keinRecht: 'BEARBEITEN',
    parse: () => ids(Ids, { ereignisId }),
    aufruf: async (dienst, p) => {
      const { daten: r } = await dienst.rufe(ENDPUNKTE.ereignisVerwerfenAblehnen, { params: p });
      return {
        meldung: r.zurueckgezogen ? 'Antrag zurückgezogen.' : 'Antrag auf Verwerfen abgelehnt.',
      };
    },
  });
}
