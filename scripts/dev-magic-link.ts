/* eslint-disable no-console */
// Dev-only: erzeugt einen Magic-Link für einen Mandanten-Kontakt und gibt
// die URL in der Konsole aus. NUR im Dev-Modus benutzen — in Produktion
// muss der Link über Mail/SMS zugestellt werden.

import prismaClientPkg from '@prisma/client';
const { PrismaClient } = prismaClientPkg;
import { createHash, randomBytes } from 'node:crypto';

const TTL_MIN = 30;

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: pnpm tsx scripts/dev-magic-link.ts <email>');
    process.exit(1);
  }
  const prisma = new PrismaClient({ datasourceUrl: process.env['DATABASE_URL'] });
  const contact = await prisma.clientContact.findFirst({
    where: { email: email.toLowerCase(), active: true },
    include: { tenant: { select: { slug: true } }, client: { select: { name: true } } },
  });
  if (!contact) {
    console.error(`Kein aktiver ClientContact mit E-Mail "${email}" gefunden.`);
    await prisma.$disconnect();
    process.exit(1);
  }
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + TTL_MIN * 60 * 1000);
  await prisma.magicLink.create({
    data: { tenantId: contact.tenantId, email: contact.email, tokenHash, expiresAt },
  });
  const base = process.env['NEXTAUTH_URL'] ?? 'http://localhost:3000';
  const link = `${base.replace(/\/$/, '')}/portal/login/verify?token=${encodeURIComponent(rawToken)}`;
  console.log('');
  console.log('  Magic-Link:');
  console.log('  Mandant:    ' + contact.client.name);
  console.log('  Kontakt:    ' + contact.fullName + ' <' + contact.email + '>');
  console.log('  Tenant:     ' + contact.tenant.slug);
  console.log('  Gültig:     ' + TTL_MIN + ' min');
  console.log('');
  console.log('  → ' + link);
  console.log('');
  await prisma.$disconnect();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
