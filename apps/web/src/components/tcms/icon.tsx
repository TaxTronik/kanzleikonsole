// =============================================================================
// Icons der Tax-CMS-Oberflächen (TCMS Stufe 3). Der Katalog in
// @taxtronik/tcms-domain nennt Icons als lucide-Namen (Ereignistypen,
// Grundelemente); hier werden genau diese Namen auf Komponenten abgebildet.
// Unbekannte Namen zeigen einen neutralen Kreis statt eines Fehlers. Icons
// sind immer dekorativ (aria-hidden); die Bedeutung trägt der Text daneben.
// =============================================================================

import {
  Ban,
  Bell,
  Briefcase,
  Circle,
  CreditCard,
  Flag,
  Gauge,
  Gift,
  Globe,
  Landmark,
  MessagesSquare,
  RefreshCw,
  Route,
  Scale,
  Ship,
  SquareCheckBig,
  Store,
  Tag,
  TriangleAlert,
  UserRound,
  Users,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';

const KATALOG_ICONS: Readonly<Record<string, LucideIcon>> = {
  Ban,
  Bell,
  Briefcase,
  CreditCard,
  Flag,
  Gauge,
  Gift,
  Globe,
  Landmark,
  MessagesSquare,
  RefreshCw,
  Route,
  Scale,
  Ship,
  SquareCheckBig,
  Store,
  Tag,
  TriangleAlert,
  UserRound,
  Users,
  Warehouse,
};

/** Icon zu einem Namen aus dem Domain-Katalog; unbekannt → Kreis. */
export function KatalogIcon({ name, className = 'h-4 w-4' }: { name: string; className?: string }) {
  const Icon = Object.hasOwn(KATALOG_ICONS, name) ? KATALOG_ICONS[name]! : Circle;
  return <Icon className={className} aria-hidden="true" />;
}

/** Namen, die KatalogIcon kennt (Test: jeder Name des Domain-Katalogs ist enthalten). */
export const KATALOG_ICON_NAMEN: readonly string[] = Object.keys(KATALOG_ICONS);
