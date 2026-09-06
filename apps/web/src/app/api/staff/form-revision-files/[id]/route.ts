import { NextResponse } from 'next/server';
import { staffAuth } from '@/server/auth/staff';
import { formRevisionDownload } from '@/server/forms/revision-download';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await staffAuth())?.user) return new NextResponse(null, { status: 401 });
  return formRevisionDownload('staff', (await params).id);
}
