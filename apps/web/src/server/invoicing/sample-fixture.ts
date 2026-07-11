// =============================================================================
// Referenz-Fixture für die XRechnung-Erzeugung — mit MISCHSÄTZEN (19/7/0 %),
// dem iter86-Kernfall. Konsumenten:
//   - __tests__/xrechnung.test.ts (strukturelle Assertions)
//   - cli/generate-sample.ts → CI-Job `e-rechnung` (KoSIT-Validierung)
// Eine Quelle für beide, damit Test und Konformitätsprüfung nie auseinanderlaufen.
// =============================================================================

import type { XRechnungInvoice, XRechnungBuyer } from './xrechnung';
import type { SellerInfo } from '@/server/settings/tenant-settings';

export const SAMPLE_INVOICE: XRechnungInvoice = {
  number: '2026-0042',
  issueDate: new Date('2026-06-10T00:00:00Z'),
  dueDate: new Date('2026-07-10T00:00:00Z'),
  subject: 'Beratungsleistungen Juni 2026',
  notes: null,
  currency: 'EUR',
  netAmount: 250,
  vatAmount: 26,
  totalAmount: 276,
  positions: [
    {
      position: 1,
      description: 'Beratung',
      quantity: 1,
      unit: 'Stunde',
      unitPrice: 100,
      netAmount: 100,
      vatRate: 19,
    },
    {
      position: 2,
      description: 'Fachliteratur',
      quantity: 1,
      unit: 'Stück',
      unitPrice: 100,
      netAmount: 100,
      vatRate: 7,
    },
    // P3-14: KEIN „durchlaufender Posten" (§ 10 Abs. 1 S. 5 UStG — kein Entgelt,
    // gehört nicht als Position aufs Entgelt), sondern eine echte 0 %-Nebenkosten-
    // Position (deckt den Kategorie-Z-Pfad im Test ab).
    {
      position: 3,
      description: 'Nebenkosten (0 % USt)',
      quantity: 1,
      unit: 'Pauschal',
      unitPrice: 50,
      netAmount: 50,
      vatRate: 0,
    },
  ],
};

export const SAMPLE_SELLER: SellerInfo = {
  name: 'Musterkanzlei GmbH',
  street: 'Kanzleistraße 1',
  postalCode: '10115',
  city: 'Berlin',
  countryIso: 'DE',
  email: 'rechnung@musterkanzlei.example',
  phone: '+49 30 1234567',
  vatId: 'DE123456789',
  taxNumber: null,
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  bankName: 'Commerzbank',
};

export const SAMPLE_BUYER: XRechnungBuyer = {
  name: 'Mandant AG',
  street: 'Mandantenweg 2',
  postalCode: '80331',
  city: 'München',
  countryIso: 'DE',
  vatId: null,
  email: 'buchhaltung@mandant.example',
};

// Reverse-Charge-Fixture (§ 13b UStG, EN16931-Kategorie AE) — alle Positionen
// 0 %, Käufer MIT USt-IdNr (BR-AE-01 verlangt Verkäufer- UND Käufer-USt-IdNr).
// Zweiter KoSIT-Validierungsfall (iter107).
export const SAMPLE_RC_INVOICE: XRechnungInvoice = {
  number: '2026-0043',
  issueDate: new Date('2026-06-10T00:00:00Z'),
  dueDate: new Date('2026-07-10T00:00:00Z'),
  subject: 'Beratungsleistung (Reverse-Charge § 13b UStG)',
  notes: null,
  currency: 'EUR',
  reverseCharge: true,
  netAmount: 200,
  vatAmount: 0,
  totalAmount: 200,
  positions: [
    {
      position: 1,
      description: 'Beratung',
      quantity: 2,
      unit: 'Stunde',
      unitPrice: 100,
      netAmount: 200,
      vatRate: 0,
    },
  ],
};

export const SAMPLE_RC_BUYER: XRechnungBuyer = {
  ...SAMPLE_BUYER,
  vatId: 'DE987654321',
};

// Korrekturrechnung/Storno (TypeCode 381): EN-16931-konform mit negativer
// Menge und positivem Einzelpreis (BR-27). Dritter KoSIT-Validierungsfall.
export const SAMPLE_STORNO_INVOICE: XRechnungInvoice = {
  ...SAMPLE_INVOICE,
  number: '2026-0044',
  typeCode: '381',
  precedingInvoiceNumber: SAMPLE_INVOICE.number,
  subject: `Korrektur zu ${SAMPLE_INVOICE.number}`,
  netAmount: -100,
  vatAmount: -19,
  totalAmount: -119,
  positions: [
    {
      ...SAMPLE_INVOICE.positions[0]!,
      quantity: -1,
      unitPrice: 100,
      netAmount: -100,
      vatRate: 19,
    },
  ],
};
