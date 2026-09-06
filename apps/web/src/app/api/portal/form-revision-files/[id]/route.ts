import { NextResponse } from 'next/server';
import { portalAuth } from '@/server/auth/portal';
import { formRevisionDownload } from '@/server/forms/revision-download';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await portalAuth())?.user) return new NextResponse(null, { status: 401 });
  return formRevisionDownload('portal', (await params).id);
}
