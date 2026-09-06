import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withTenantContext } from '@taxtronik/db';
import { sanitizeFilenameForHeader } from '@taxtronik/storage';
import { ActionError, toActionError } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { checkStaffExportLimit, checkPortalReadLimit } from '@/server/rate-limit';
import { filenameWithExtension } from '@/server/storage/preview-mime';
import { assistanceAccess, type Surface } from './service';
import {
  assistanceRevisionTx,
  assistanceVersionTx,
  checkAssistanceSourcesTx,
  readAssistanceBytes,
} from './outputs';
import { CASE_KINDS } from './definitions';
import { ASSISTANCE_GENERATOR } from './snapshot';

const Query = z.object({
  clientId: z.uuid(),
  kind: z.enum(CASE_KINDS),
  revision: z.coerce.number().int().positive(),
  format: z.enum(['pdf', 'docx', 'merged', 'manifest', 'original', 'external']),
  outputId: z.uuid().optional(),
});
export async function assistanceDownload(surface: Surface, request: Request, id: string) {
  try {
    z.uuid().parse(id);
    const input = Query.parse(Object.fromEntries(new URL(request.url).searchParams));
    const access = await assistanceAccess(surface, input.kind, input.clientId);
    const { ctx } = access;
    const rate =
      surface === 'staff'
        ? await checkStaffExportLimit('client-assistance-download', ctx.actorId!)
        : await checkPortalReadLimit(ctx.actorId!);
    if (!rate.ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    const data = await withTenantContext(ctx, async (tx) => {
      await access.guardMutationTx(tx);
      const { row, snapshot } = await assistanceRevisionTx(
        tx,
        id,
        input.clientId,
        input.kind,
        input.revision,
      );
      await checkAssistanceSourcesTx(tx, surface, ctx.tenantId, input.clientId, snapshot);
      if (input.format === 'original' || input.format === 'external') {
        const versionId =
          input.format === 'original' ? snapshot.sourceVersionId : snapshot.externalVersionId;
        const hash = input.format === 'original' ? snapshot.sourceHash : snapshot.externalHash;
        if (!versionId) throw new ActionError('Keine solche Dokumentfassung zugeordnet.');
        return {
          snapshot,
          version: await assistanceVersionTx(
            tx,
            surface,
            ctx.tenantId,
            input.clientId,
            versionId,
            hash,
          ),
          manifest: null,
          outputId: null,
        };
      }
      const output = await tx.clientAssistanceOutput.findFirst({
        where: {
          revisionId: row.id,
          status: 'READY',
          ...(input.outputId
            ? { id: input.outputId }
            : { format: input.format, generatorVersion: ASSISTANCE_GENERATOR }),
        },
      });
      if (
        !output ||
        !output.documentVersionId ||
        output.snapshotHash !== row.snapshotHash ||
        (input.format !== 'manifest' && output.format !== input.format)
      )
        throw new ActionError(
          'Diese Ausgabe ist noch nicht vollständig abgelegt. Bitte die Ausgabe zuerst im Vorgang ablegen oder fortsetzen.',
        );
      const version = await assistanceVersionTx(
        tx,
        surface,
        ctx.tenantId,
        input.clientId,
        output.documentVersionId,
        output.outputHash,
      );
      return {
        snapshot,
        version,
        manifest: {
          ...(output.manifest as Record<string, unknown>),
          outputId: output.id,
          documentVersionId: version.id,
          outputHash: output.outputHash,
          bytes: version.sizeBytes.toString(),
          completedAt: output.completedAt?.toISOString(),
        },
        outputId: output.id,
      };
    });
    const manifest = input.format === 'manifest';
    const bytes = manifest
      ? Buffer.from(JSON.stringify(data.manifest, null, 2))
      : await readAssistanceBytes(data.version);
    await withTenantContext(ctx, async (tx) => {
      await access.guardMutationTx(tx);
      await checkAssistanceSourcesTx(tx, surface, ctx.tenantId, input.clientId, data.snapshot);
      await assistanceVersionTx(
        tx,
        surface,
        ctx.tenantId,
        input.clientId,
        data.version.id,
        Buffer.from(data.version.sha256).toString('hex'),
      );
      await evidenceService.record(tx, {
        tenantId: ctx.tenantId,
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: 'client_assistance.download',
        resourceType: 'client_assistance_case',
        resourceId: id,
        after: {
          revision: input.revision,
          format: input.format,
          outputId: data.outputId,
          documentVersionId: data.version.id,
        },
      });
    });
    const file = manifest
      ? `vorgang-${id}-v${input.revision}-manifest.json`
      : filenameWithExtension(data.version.document.title, data.version.document.mimeType);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': manifest ? 'application/json' : data.version.document.mimeType,
        'Content-Disposition': `attachment; filename="${sanitizeFilenameForHeader(file)}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
      },
    });
  } catch (error) {
    return NextResponse.json({ error: toActionError(error).error }, { status: 403 });
  }
}
