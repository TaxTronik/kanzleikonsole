// =============================================================================
// Formatierung des gespeicherten Sachverhalts aktualisieren (sourceDoc), OHNE
// den analysierten Text zu verändern.
//
// Nur-Format-Edits (fett, Überschrift, Listen …) lassen den Plaintext — und
// damit die Markierungs-Offsets — unberührt: Markierungen bleiben verankert.
// Ändert sich der Plaintext (Textinhalt), wird NICHT gespeichert; inhaltliche
// Änderungen verschieben Offsets und verlangen eine neue Analyse. Der Aufrufer
// liefert den Plaintext über DIESELBE Serialisierung (doc-text), damit der
// Vergleich deckungsgleich mit dem gespeicherten sourceText ist.
//
// Der Formatwechsel wird in der TaxTronik-Hash-Chain (audit_log) verankert.
// =============================================================================

import { createHash } from 'node:crypto';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

export interface ReformatInput {
  analysisId: string;
  /** Neuer formatierter Sachverhalt (Tiptap/ProseMirror-JSON). */
  doc: unknown;
  /** Plaintext-Serialisierung von `doc` (vom Aufrufer via jsonDocToText). */
  newText: string;
  /** StaffUser, der die Formatierung ändert. */
  actorId: string;
}

/** `format` = gespeichert (nur Formatierung); `text` = abgelehnt (Inhalt geändert). */
export type ReformatResult = { changed: 'format' } | { changed: 'text' };

function docHash(doc: unknown): string {
  return createHash('sha256').update(JSON.stringify(doc ?? null), 'utf8').digest('hex');
}

export async function reformatSourceDoc(
  ctx: TenantContext,
  input: ReformatInput,
): Promise<ReformatResult> {
  return withTenantContext(ctx, async (tx) => {
    const analysis = await tx.riskAnalysis.findUnique({
      where: { id: input.analysisId },
      select: { sourceText: true, sourceDoc: true, archivedAt: true },
    });
    if (!analysis) throw new Error('Analyse nicht gefunden.');
    // Defense in depth — guardAnalysis wirft bereits bei archivierten Analysen.
    if (analysis.archivedAt) throw new Error('Diese Subsumtion ist archiviert (schreibgeschützt).');

    // Inhaltliche Änderung? Dann NICHT speichern — die Offsets der Markierungen
    // hängen am exakt analysierten Text; in diesem Modus darf sich nur die
    // Formatierung ändern.
    if (input.newText !== analysis.sourceText) return { changed: 'text' };

    const beforeHash = docHash(analysis.sourceDoc);
    const afterHash = docHash(input.doc);

    await tx.riskAnalysis.update({
      where: { id: input.analysisId },
      data: { sourceDoc: input.doc != null ? (input.doc as object) : undefined },
    });

    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: input.actorId,
      action: 'risk.analysis.reformatted',
      resourceType: 'risk_analysis',
      resourceId: input.analysisId,
      before: { sourceDocHash: beforeHash },
      after: { sourceDocHash: afterHash, formattingOnly: true },
    });

    return { changed: 'format' };
  });
}
