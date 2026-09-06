import { NextResponse } from 'next/server';
import { getPayrollFile, payrollFileBytes } from './storage';
import { payrollGuard, type PayrollSurface } from './service';
import { requireGuestHash } from './capability';
import { checkRateLimit } from '@/server/rate-limit';
import { sanitizeFilenameForHeader } from '@taxtronik/storage';
import { isUuid } from '@/lib/uuid';
export async function payrollDownload(
  surface: PayrollSurface | 'employee',
  attachmentId: string,
  intakeId?: string,
) {
  if (!isUuid(attachmentId) || (intakeId && !isUuid(intakeId)))
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  try {
    const identity =
      surface === 'employee'
        ? await requireGuestHash()
        : (await payrollGuard(surface)).ctx.actorId!;
    if (!(await checkRateLimit('payroll-download:' + identity, { max: 60, windowSec: 600 })).ok)
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    const row = await getPayrollFile(surface, attachmentId, intakeId);
    const bytes = await payrollFileBytes(row);
    // Do not return bytes after a concurrent grant revocation or mandate end.
    await getPayrollFile(surface, attachmentId, intakeId);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'content-type': row.mimeType,
        'content-disposition':
          'attachment; filename="' + sanitizeFilenameForHeader(row.filename) + '"',
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
        'referrer-policy': 'no-referrer',
      },
    });
  } catch {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}
