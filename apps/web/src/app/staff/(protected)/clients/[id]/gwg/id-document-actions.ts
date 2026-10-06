'use server';

// GwG-Ausweis- und Rechtsträgernachweise: Parsen → (P-13: Seitenzahlen vor der
// gesperrten Transaktion) → Service in der Tenant-Transaktion → Ergebnis. Die
// Fachlogik liegt in server/gwg/identity-document-sets.ts,
// identity-document-links.ts und identity-document-confirmation.ts
// (Review-Befund K-03).

import { z } from 'zod';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { findCleanGwgEvidenceDocumentsTx } from '@/server/gwg/evidence-documents';
import { IdentitySourceViewsSchema, identityViewports } from '@/lib/gwg/identity-viewport';
import {
  identityViewsNeedPageCheck,
  loadIdentitySourcesForPageCheckTx,
  NO_IDENTITY_PDF_PAGE_COUNTS,
  prepareIdentityPdfPageCounts,
  type IdentityPdfPageCounts,
  type IdentityViewSelection,
} from '@/server/gwg/identity-source';
import { validateIdentityDates } from '@/server/gwg/identity-date-validation';
import {
  addIdentityDocumentSetTx,
  extendIdentityDocumentSetTx,
  newIdentityViewsFor,
} from '@/server/gwg/identity-document-sets';
import {
  removeGwgEvidenceLinkTx,
  selectCurrentIdentityDocumentSetTx,
} from '@/server/gwg/identity-document-links';
import { updateIdentityDocumentSetTx } from '@/server/gwg/identity-document-confirmation';
import {
  withStaff,
  staffAction,
  ActionError,
  parseFormData,
  type StaffCtx,
} from '@/server/actions/staff-action';
import { formDefault } from '@/server/actions/form-data';

import { isPersonalIdType, type ActionResult } from './_action-helpers';

// Stabile Typ-Importpfade fuer die Form-Komponenten dieser Route.
export type { ActionResult, InvalidatedIdentitySet, SavedBeneficialOwner } from './_action-helpers';

const AddIdDocSchema = z
  .object({
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    type: z.enum([
      'PERSONALAUSWEIS',
      'REISEPASS',
      'HANDELSREGISTERAUSZUG',
      'GESELLSCHAFTSVERTRAG',
      'VOLLMACHT',
      'TRANSPARENZREGISTER_AUSZUG',
      'SONSTIGES',
    ]),
    subjectKey: z.string().max(500).optional().or(z.literal('')),
    number: z.string().max(100).optional().or(z.literal('')),
    issuedBy: z.string().max(200).optional().or(z.literal('')),
    issueDate: z.string().date().optional().or(z.literal('')),
    expiryDate: z.string().date().optional().or(z.literal('')),
    replacementMode: z.enum(['none', 'set', 'subject', 'type']).default('none'),
    replaceDocumentSetId: z.string().uuid().optional().or(z.literal('')),
    viewports: IdentitySourceViewsSchema.default([]),
    documentIds: z
      .array(z.string().uuid())
      .min(1, 'Mindestens ein Aktenbeleg ist erforderlich.')
      .max(2, 'Ein Ausweissatz darf höchstens zwei Dateien enthalten.'),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.documentIds).size !== value.documentIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['documentIds'],
        message: 'Jeder Aktenbeleg darf im Satz nur einmal vorkommen.',
      });
    }
    if (!isPersonalIdType(value.type) && value.documentIds.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['documentIds'],
        message: 'Ein Rechtsträgernachweis besteht aus genau einem Aktenbeleg.',
      });
    }
    if (isPersonalIdType(value.type) && !value.subjectKey?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['subjectKey'],
        message: 'Identifizierte Person ist erforderlich.',
      });
    }
    if (value.replacementMode === 'set' && !value.replaceDocumentSetId) {
      ctx.addIssue({
        code: 'custom',
        path: ['replaceDocumentSetId'],
        message: 'Der zu ersetzende Ausweissatz fehlt.',
      });
    }
    if (isPersonalIdType(value.type) && value.replacementMode === 'type') {
      ctx.addIssue({
        code: 'custom',
        path: ['replacementMode'],
        message: 'Ein Ausweis muss als konkreter Ausweissatz ersetzt werden.',
      });
    }
    if (
      !isPersonalIdType(value.type) &&
      (value.replacementMode === 'set' || value.replacementMode === 'subject')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['replacementMode'],
        message: 'Ein Rechtsträgernachweis wird anhand seines Nachweistyps ersetzt.',
      });
    }
    if (isPersonalIdType(value.type)) {
      for (const issue of validateIdentityDates({
        issueDate: value.issueDate || null,
        expiryDate: value.expiryDate || null,
      })) {
        ctx.addIssue({
          code: 'custom',
          path: [issue.field],
          message: issue.message,
        });
      }
    }
  });

/** Ausgewählte Aktenbelege wie bisher: nur nicht-leere Texteinträge (getAll + filter). */
function selectedDocumentEntries(value: unknown): unknown {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : value;
}

/** Ausweisausschnitte als JSON; unlesbar → nur diese Meldung, wie bisher vor dem Schema. */
function parseViewportsJson(value: unknown, ctx: z.RefinementCtx): unknown {
  try {
    return JSON.parse(String(value || '[]'));
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Ungültiger Ausweisausschnitt.' });
    return z.NEVER;
  }
}

type AddIdDocFields = z.input<typeof AddIdDocSchema>;

/**
 * Formular → AddIdDocSchema (R-12): Felder wie formData.get (fehlend → null,
 * optionale Angaben fehlend → '', Ersetzungsmodus fehlend → 'none'). Ohne
 * Auswahl gilt das ältere Einzelfeld documentId. Ein unlesbarer
 * Ausweisausschnitt beendet die Prüfung vor dem Schema — wie bisher.
 */
const AddIdDocForm = z
  .object({
    documentIds: z.preprocess(selectedDocumentEntries, z.array(z.string())),
    documentId: z.unknown(),
    viewports: z.preprocess(parseViewportsJson, z.unknown()),
    checkId: z.unknown(),
    clientId: z.unknown(),
    type: z.unknown(),
    subjectKey: formDefault('', z.unknown()),
    number: formDefault('', z.unknown()),
    issuedBy: formDefault('', z.unknown()),
    issueDate: formDefault('', z.unknown()),
    expiryDate: formDefault('', z.unknown()),
    replacementMode: formDefault('none', z.unknown()),
    replaceDocumentSetId: formDefault('', z.unknown()),
  })
  .transform(
    // Rohwerte wie aus formData.get — erst AddIdDocSchema prüft sie.
    ({ documentIds, documentId, ...fields }) =>
      ({
        ...fields,
        documentIds:
          documentIds.length === 0 && typeof documentId === 'string' && documentId
            ? [documentId]
            : documentIds,
      }) as AddIdDocFields,
  )
  .pipe(AddIdDocSchema);

const SearchGwgDocumentsSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  query: z.string().trim().min(2).max(100),
});

export interface GwgDocumentSearchResult {
  id: string;
  title: string;
  createdAt: string;
}

/**
 * Durchsucht die gesamte Mandantenakte serverseitig. Die initiale Seite lädt
 * bewusst nur die jüngsten Belege; ältere Treffer bleiben über diese Suche
 * erreichbar. Bereits in diesem Check verknüpfte Dateien werden hier nicht
 * erneut angeboten (Alt-Sätze stellt die Review-Karte separat zum Merge dar).
 */
export async function searchUnlinkedGwgDocumentsAction(input: {
  checkId: string;
  clientId: string;
  query: string;
}): Promise<
  ActionResult & {
    documents?: GwgDocumentSearchResult[];
    limited?: boolean;
  }
> {
  const parsed = SearchGwgDocumentsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Bitte mindestens zwei Zeichen eingeben.' };
  const data = parsed.data;

  return withStaff(async (tx, { tenantId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: { id: true },
    });
    if (!check) throw new ActionError('GwG-Check nicht gefunden.');

    const matches = await findCleanGwgEvidenceDocumentsTx(tx, {
      tenantId,
      clientId: data.clientId,
      query: data.query,
      excludeLinkedCheckId: data.checkId,
      limit: 51,
    });
    return {
      documents: matches.slice(0, 50).map((document) => ({
        id: document.id,
        title: document.title,
        createdAt: document.createdAt.toISOString(),
      })),
      limited: matches.length > 50,
    };
  });
}

type NewIdDocumentData = z.infer<typeof AddIdDocSchema>;

/**
 * P-13: PDF-Seitenzahlen, die beim Upload nicht gespeichert wurden (Altbestand),
 * vor der gesperrten Transaktion ermitteln: kurze Lesetransaktion mit
 * Mandantenzugriff, dann Download, Hashprüfung und Zählung im begrenzten
 * Worker-Thread ohne Transaktion. Die Transaktion vergleicht danach nur
 * Version-ID und SHA-256.
 */
function prepareStaffIdentityPageCounts(
  guard: StaffCtx,
  clientId: string,
  readSelections: (tx: TxClient) => Promise<IdentityViewSelection[]>,
): Promise<IdentityPdfPageCounts> {
  return prepareIdentityPdfPageCounts(() =>
    withTenantContext(guard.ctx, async (tx) => {
      await assertClientAccessTx(tx, guard.session, clientId);
      return loadIdentitySourcesForPageCheckTx(
        tx,
        { tenantId: guard.tenantId, clientId },
        await readSelections(tx),
      );
    }),
  );
}

async function prepareNewIdentityPageCounts(
  guard: StaffCtx,
  data: NewIdDocumentData,
): Promise<IdentityPdfPageCounts> {
  const selections = data.documentIds.map((documentId) => ({
    documentId,
    views: newIdentityViewsFor(data, documentId),
  }));
  if (!selections.some((selection) => identityViewsNeedPageCheck(selection.views))) {
    return NO_IDENTITY_PDF_PAGE_COUNTS;
  }
  return prepareStaffIdentityPageCounts(guard, data.clientId, async () => selections);
}

export async function addIdDocumentAction(
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
) {
  const parsed = parseFormData(AddIdDocForm, formData, {
    repeatable: ['documentIds'],
    absentAsNull: true,
    errorMessage: (issues) => issues.map((issue) => issue.message).join(' '),
  });
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  return staffAction({
    // P-13: Vorabzählung und gesperrte Transaktion unter demselben Gate.
    run: async (staff) => {
      const pageCounts = await prepareNewIdentityPageCounts(staff, data);
      return withTenantContext(staff.ctx, (tx) =>
        addIdentityDocumentSetTx(tx, data, staff, pageCounts),
      );
    },
    // Kein revalidate der aktuellen Route (siehe addGwgPersonAction) —
    // der Client refresht nach dem Erfolg außerhalb der Form-Transition.
  });
}

const ExtendIdentityDocumentSetSchema = z
  .object({
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    targetDocumentSetId: z.string().uuid(),
    documentIds: z.preprocess(
      selectedDocumentEntries,
      z
        .array(z.string().uuid())
        .min(1, 'Mindestens eine Datei ist erforderlich.')
        .max(2, 'Es können höchstens zwei Dateien auf einmal ergänzt werden.'),
    ),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.documentIds).size !== value.documentIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['documentIds'],
        message: 'Jede Datei darf nur einmal ausgewählt werden.',
      });
    }
  });

/**
 * Ergänzt einen bestehenden Ausweissatz direkt aus der Akte
 * (server/gwg/identity-document-sets.ts).
 */
export async function extendIdentityDocumentSetAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult & { reviewReset?: boolean }> {
  const parsed = parseFormData(ExtendIdentityDocumentSetSchema, formData, {
    repeatable: ['documentIds'],
    absentAsNull: true,
    errorMessage: (issues) => issues.map((issue) => issue.message).join(' '),
  });
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  return withStaff((tx, staff) => extendIdentityDocumentSetTx(tx, data, staff), {
    // Kein revalidate der aktuellen Route (siehe addGwgPersonAction).
    uniqueError:
      'Mindestens eine Datei wurde zwischenzeitlich bereits zugeordnet. Bitte Seite neu laden.',
  });
}

const UpdateIdDocumentsSchema = z
  .object({
    intent: formDefault('save', z.enum(['save', 'confirm']).default('save')),
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    documentSetId: z.string().uuid(),
    type: z.enum(['PERSONALAUSWEIS', 'REISEPASS']),
    subjectKey: z.string().min(1).max(500),
    number: z.string().trim().min(1).max(100),
    issuedBy: z.string().trim().min(1).max(200),
    issueDate: formDefault('', z.string().date()),
    expiryDate: z.string().date(),
    expectedRevision: z.string().min(2).max(50_000),
  })
  .superRefine((document, ctx) => {
    for (const issue of validateIdentityDates({
      issueDate: document.issueDate,
      expiryDate: document.expiryDate,
    })) {
      ctx.addIssue({ code: 'custom', path: [issue.field], message: issue.message });
    }
  });

/** P-13: Vorabzählung für die beim Bestätigen erneut geprüften gespeicherten Ansichten. */
async function prepareSavedIdentityPageCounts(
  guard: StaffCtx,
  data: z.infer<typeof UpdateIdDocumentsSchema>,
): Promise<IdentityPdfPageCounts> {
  if (data.intent !== 'confirm') return NO_IDENTITY_PDF_PAGE_COUNTS;
  return prepareStaffIdentityPageCounts(guard, data.clientId, async (tx) => {
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: {
        idDocuments: {
          where: { documentSetId: data.documentSetId, supersededAt: null },
          select: { documentId: true, viewports: true },
        },
      },
    });
    return (check?.idDocuments ?? []).flatMap((entry) =>
      entry.documentId
        ? [{ documentId: entry.documentId, views: identityViewports(entry.viewports) }]
        : [],
    );
  });
}

/**
 * Bestätigt oder korrigiert einen zusammengehörigen Ausweissatz (z. B.
 * Vorder- und Rückseite) in einem atomaren Schritt
 * (server/gwg/identity-document-confirmation.ts).
 */
export async function updateIdDocumentsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<
  ActionResult & {
    verified?: boolean;
    reviewReset?: boolean;
    saved?: {
      type: 'PERSONALAUSWEIS' | 'REISEPASS';
      subjectKey: string;
      ownerName: string;
      number: string;
      issuedBy: string;
      issueDate: string;
      expiryDate: string;
    };
    revision?: string;
  }
> {
  const parsed = parseFormData(UpdateIdDocumentsSchema, formData, {
    absentAsNull: true,
    errorMessage: (issues) => issues.map((issue) => issue.message).join(' '),
  });
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  return staffAction({
    // P-13: Vorabzählung und gesperrte Transaktion unter demselben Gate.
    run: async (staff) => {
      const pageCounts = await prepareSavedIdentityPageCounts(staff, data);
      return withTenantContext(staff.ctx, (tx) =>
        updateIdentityDocumentSetTx(tx, data, staff, pageCounts),
      );
    },
  });
}

const RemoveGwgEvidenceLinkSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  gwgIdDocumentId: z.string().uuid(),
});

/**
 * Entfernt ausschließlich eine irrtümliche Zuordnung aus dem aktiven
 * GwG-Prüfsnapshot. Das Document und sämtliche Object-Store-Versionen bleiben
 * unverändert in der Mandantenakte erhalten (GWG-IDENTIFICATION-EVIDENCE-001).
 */
export async function removeGwgEvidenceLinkAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult & { reviewReset?: boolean }> {
  const parsed = parseFormData(RemoveGwgEvidenceLinkSchema, formData, {
    errorMessage: 'Der Nachweis konnte nicht zugeordnet werden.',
  });
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  return withStaff((tx, staff) => removeGwgEvidenceLinkTx(tx, data, staff));
}

const SelectCurrentIdentityDocumentSetSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  documentSetId: z.string().uuid(),
});

/**
 * Repariert historische Doppelbestände, ohne einen fachlich aktuellen Satz
 * automatisch zu erraten (GWG-IDENTIFICATION-EVIDENCE-001).
 */
export async function selectCurrentIdentityDocumentSetAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult & { reviewReset?: boolean }> {
  const parsed = parseFormData(SelectCurrentIdentityDocumentSetSchema, formData, {
    errorMessage: 'Der Ausweissatz konnte nicht ausgewählt werden.',
  });
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  return withStaff((tx, staff) => selectCurrentIdentityDocumentSetTx(tx, data, staff));
}
