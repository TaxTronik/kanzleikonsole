import { payrollDownload } from '@/server/payroll/download';
import { portalAuth } from '@/server/auth/portal';
import { NextResponse } from 'next/server';
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  if (!(await portalAuth())?.user) return new NextResponse(null, { status: 401 });
  const { id, attachmentId } = await params;
  return payrollDownload('portal', attachmentId, id);
}
