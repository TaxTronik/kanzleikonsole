import type { ModuleConfig } from '@/server/settings/modules';

/** Serverseitige Dashboard-Sicht; dieselben Flags steuern Query und Ausgabe. */
export function portalDashboardVisibility(modules: Pick<ModuleConfig, 'forms' | 'invoiceMode'>): {
  forms: boolean;
  invoices: boolean;
} {
  return {
    forms: modules.forms,
    invoices: modules.invoiceMode !== 'OFF',
  };
}
