import { payrollDownload } from '@/server/payroll/download';
import { staffAuth } from '@/server/auth/staff';
import { NextResponse } from 'next/server';
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  if (!(await staffAuth())?.user) return new NextResponse(null, { status: 401 });
  const { id, attachmentId } = await params;
  return payrollDownload('staff', attachmentId, id);
}
