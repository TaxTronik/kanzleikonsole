import { NextResponse } from 'next/server';
import { staffAuth } from '@/server/auth/staff';
import { assistanceDownload } from '@/server/client-assistance/download';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await staffAuth())?.user) return new NextResponse(null, { status: 401 });
  return assistanceDownload('staff', request, (await params).id);
}
