import { NextResponse } from 'next/server';
import { portalAuth } from '@/server/auth/portal';
import { assistanceDownload } from '@/server/client-assistance/download';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await portalAuth())?.user) return new NextResponse(null, { status: 401 });
  return assistanceDownload('portal', request, (await params).id);
}
