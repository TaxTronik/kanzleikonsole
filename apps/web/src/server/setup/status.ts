// =============================================================================
// Setup-Checkliste — fasst zusammen, was für eine produktive Inbetriebnahme
// noch konfiguriert werden muss. Anzeige im Admin-Banner und auf der
// Integrationen-Seite.
// =============================================================================

import { withTenantContext } from '@taxtronik/db';
import type { TenantContext } from '@taxtronik/db';
import { readSellerInfo } from '@/server/settings/tenant-settings';
import { readBranding } from '@/server/settings/branding';
import { readTaxRegion } from '@/server/settings/tax-region';
import { getSmtpStatus } from '@/server/settings/smtp';

export interface SetupItem {
  key: string;
  label: string;
  done: boolean;
  href: string;
  hint?: string;
}

export interface SetupStatus {
  items: SetupItem[];
  doneCount: number;
  totalCount: number;
  allDone: boolean;
}

export async function getSetupStatus(ctx: TenantContext): Promise<SetupStatus> {
  const [seller, branding, region, smtp, contactCount] = await Promise.all([
    readSellerInfo(ctx),
    readBranding(ctx),
    readTaxRegion(ctx),
    getSmtpStatus(ctx),
    withTenantContext(ctx, (tx) =>
      tx.clientContact.count({ where: { active: true } }),
    ),
  ]);

  const items: SetupItem[] = [
    {
      key: 'branding',
      label: 'Erscheinungsbild (Logo + Anzeigename)',
      done: Boolean(branding.displayName) && Boolean(branding.logoDataUrl),
      href: '/staff/admin/settings/branding',
      hint: 'Logo und Anzeigename erscheinen in Mitarbeiter- und Mandanten-Oberfläche.',
    },
    {
      key: 'region',
      label: 'Bundesland gesetzt',
      done: region !== null,
      href: '/staff/admin/settings/region',
      hint: 'Steuert die Werktagsverschiebung bei Steuerterminen.',
    },
    {
      key: 'seller',
      label: 'Kanzlei-Stammdaten (für XRechnung)',
      done: Boolean(seller.name && seller.street && seller.postalCode && seller.city && seller.vatId),
      href: '/staff/admin/settings/seller',
      hint: 'Name, Anschrift und USt-ID werden für Rechnungs-Exports gebraucht.',
    },
    {
      key: 'smtp',
      label: 'E-Mail-Versand konfiguriert',
      done: smtp.configured,
      href: '/staff/admin/settings/mail',
      hint: 'Sonst kein Magic-Link-Login fürs Portal und keine Reminder-Mails.',
    },
    {
      key: 'contacts',
      label: 'Mindestens ein Portal-Kontakt aktiv',
      done: contactCount > 0,
      href: '/staff/clients',
      hint: 'Mandanten brauchen mindestens einen Kontakt mit E-Mail-Adresse, um sich einzuloggen.',
    },
  ];

  const doneCount = items.filter((i) => i.done).length;
  return {
    items,
    doneCount,
    totalCount: items.length,
    allDone: doneCount === items.length,
  };
}
