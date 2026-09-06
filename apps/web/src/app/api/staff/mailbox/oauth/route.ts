import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { withTenantContext } from '@taxtronik/db';
import { decryptSecret } from '@taxtronik/crypto';
import { env } from '@taxtronik/config';
import { microsoftClient, IMAP_SCOPES } from '@taxtronik/mail/imap';
import { staffActionGuard } from '@/server/actions/staff-action';
import { staffAuth } from '@/server/auth/staff';
import { persistMicrosoftOauthCacheTx } from '@/server/mailbox/oauth-cache';
export async function GET(req: NextRequest) {
  if (!(await staffAuth())?.user)
    return NextResponse.json({ error: 'Nicht angemeldet.' }, { status: 401 });
  const g = await staffActionGuard({ requireAdmin: true, module: 'smartMailbox' });
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: 403 });
  const jar = await cookies();
  const raw = jar.get('tt-mailbox-oauth')?.value;
  jar.delete({ name: 'tt-mailbox-oauth', path: '/api/staff/mailbox/oauth' });
  try {
    if (!raw) throw new Error('missing');
    const saved = z
      .object({
        id: z.uuid(),
        staffId: z.uuid(),
        tenantId: z.uuid(),
        state: z.string().min(40),
        verifier: z.string().min(43),
        expires: z.number(),
      })
      .parse(JSON.parse(decryptSecret(raw)));
    const state = req.nextUrl.searchParams.get('state') ?? '';
    const a = Buffer.from(state);
    const b = Buffer.from(saved.state);
    if (
      a.length !== b.length ||
      !timingSafeEqual(a, b) ||
      saved.expires < Date.now() ||
      saved.tenantId !== g.tenantId ||
      saved.staffId !== g.staffId
    )
      throw new Error('state');
    const account = await withTenantContext(g.ctx, (tx) =>
      tx.inboundMailbox.findFirst({
        where: { id: saved.id, tenantId: g.tenantId, provider: 'MICROSOFT365' },
      }),
    );
    const code = req.nextUrl.searchParams.get('code');
    if (!account || !code || req.nextUrl.searchParams.has('error')) throw new Error('denied');
    let persisted = false;
    await microsoftClient(account, async (encryptedCache) => {
      await withTenantContext(g.ctx, (tx) =>
        persistMicrosoftOauthCacheTx(tx, g.tenantId, g.staffId, account.id, encryptedCache),
      );
      persisted = true;
    }).acquireTokenByCode({
      code,
      codeVerifier: saved.verifier,
      scopes: IMAP_SCOPES,
      redirectUri: new URL('/api/staff/mailbox/oauth', env.NEXTAUTH_URL).toString(),
    });
    if (!persisted) throw new Error('Token cache not persisted.');
    return NextResponse.redirect(new URL('/staff/mailbox?connected=1', env.NEXTAUTH_URL));
  } catch {
    return NextResponse.redirect(new URL('/staff/mailbox?connectionError=1', env.NEXTAUTH_URL));
  }
}
