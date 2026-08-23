// =============================================================================
// Modul-Konfiguration pro Tenant
//
// Welche Bereiche der App eine Kanzlei nutzt — alles andere wird ausgeblendet.
// Liegt in `tenant_setting.modules` als JSON.
//
// Verwendung:
//   - Sidebar filtert Items basierend auf `enabled.*` (UI-Sichtbarkeit).
//   - Direkte Seiten werden zusätzlich im jeweiligen Surface-Layout über die
//     zentrale Pfadzuordnung gesperrt; Actions/API-Endpunkte verwenden diesen
//     Gate-Baustein bzw. die module-Option der zentralen Action-Guards.
//   - Rechnungen, POA, Risk und Signal-Engine behalten ihre strengeren
//     Spezial-Gates zusätzlich zu den tenantweiten Schaltern.
//   - PoaMode steuert das Vollmachten-Subsystem.
// =============================================================================

import { cache } from 'react';
import { withTenantContext, type TenantContext } from '@taxtronik/db/tenant-context';
import type { BooleanTenantModules, BooleanTenantModuleKey } from '@taxtronik/db/tenant-modules';
import {
  DEFAULT_BOOLEAN_TENANT_MODULES,
  parseBooleanTenantModules,
} from '@taxtronik/db/tenant-modules';

export type PoaMode = 'OFF' | 'MARKDOWN_OTP' | 'PDF_TEMPLATE';
export type InvoiceMode = 'OFF' | 'IN_APP' | 'EXTERNAL';
export type ModeModuleKey = 'poa' | 'invoices';

export interface ModuleConfig extends BooleanTenantModules {
  // Kernfeatures (Default an)
  bwa: boolean; // BWA-Auswertungen
  knowledge: boolean; // Wissensdatenbank
  timeTracking: boolean; // Zeiterfassung
  phoneNotes: boolean; // Telefonzettel
  taxNotices: boolean; // Bescheide + Steuertermine (= Kanzleikalender)
  workflows: boolean; // Workflow-Vorlagen + Instanzen
  forms: boolean; // Formular-Builder
  reminders: boolean; // Wiedervorlagen (Block am Mandanten + Widget)
  binders: boolean; // Pendelordner (Kanzlei → Mandant)
  handovers: boolean; // Anlieferungen (Mandant → Kanzlei)
  appointments: boolean; // Kanzleikalender-Termine + Portal-Anfragen
  rssReader: boolean; // RSS-Reader-Widget
  inboundMail: boolean; // E-Mail-Antworten von Mandanten → Anforderungs-Antwort (via n8n)
  risk: boolean; // Subsumtions-Workspace / TCMS (braucht zusätzlich die Risk-Engine)
  signalEngine: boolean; // Signal-Engine-Integration (externe Signale; braucht zusätzlich signalEngineConfig)

  // Vollmachten-Modus
  poaMode: PoaMode;
  poaPdfTemplate: {
    subject: string;
    bodyMd: string; // Markdown
  } | null;

  // Rechnungs-Modus — analog zu poaMode:
  //   - OFF       → Modul komplett aus (z. B. Partnerschaft mit zentraler DATEV-Abrechnung)
  //   - IN_APP    → Vollständige App-Rechnungserstellung mit XRechnung/ZUGFeRD
  //   - EXTERNAL  → Nur PDF-Anhang an Mandant senden, Erstellung extern (DATEV)
  invoiceMode: InvoiceMode;
  invoicePdfTemplate: {
    subject: string;
    bodyMd: string;
  } | null;
}

export const DEFAULT_MODULES: ModuleConfig = {
  ...DEFAULT_BOOLEAN_TENANT_MODULES,
  // Default: PDF_TEMPLATE (extern) — Vollmachten werden als PDF aus einer
  // externen Vorlage angebunden, nicht im Inline-Markdown-Editor verfasst.
  poaMode: 'PDF_TEMPLATE',
  poaPdfTemplate: null,
  // Default: EXTERNAL (PDF-Upload aus zentraler Rechnungssoftware) — der
  // typische Use Case in mittleren bis großen Kanzleien. In-App-Erstellung
  // gibt es weiterhin als IN_APP-Modus.
  invoiceMode: 'EXTERNAL',
  invoicePdfTemplate: null,
};

const KEY_MODULES = 'modules';

// Layout UND Page laden readModules pro Request (Sidebar + Modul-Gate). cache()
// dedupliziert request-scoped — aber auf PRIMITIVEN (tenantId/actorId/actorType),
// nicht auf dem ctx-Objekt: Layout und Page bauen separate ctx-Instanzen, und
// cache() vergleicht Objekt-Argumente per Referenz (würde sonst nie greifen).
const readModulesCached = cache(
  (
    tenantId: string,
    actorId: TenantContext['actorId'],
    actorType: TenantContext['actorType'],
  ): Promise<ModuleConfig> => readModulesByCtx({ tenantId, actorId, actorType }),
);

function readModulesByCtx(ctx: TenantContext): Promise<ModuleConfig> {
  return withTenantContext(ctx, async (tx) => {
    const row = await tx.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY_MODULES } },
    });
    if (!row) return { ...DEFAULT_MODULES };
    const value = row.value as Partial<ModuleConfig>;
    return { ...DEFAULT_MODULES, ...value, ...parseBooleanTenantModules(value) };
  });
}

export function readModules(ctx: TenantContext): Promise<ModuleConfig> {
  return readModulesCached(ctx.tenantId, ctx.actorId, ctx.actorType);
}

/** Spezialmodule werden nicht mit einem Boolean, sondern mit einem Betriebsmodus geschaltet. */
export function isModeModuleEnabled(cfg: ModuleConfig, module: ModeModuleKey): boolean {
  return module === 'poa' ? cfg.poaMode !== 'OFF' : cfg.invoiceMode !== 'OFF';
}

export async function writeModules(ctx: TenantContext, cfg: ModuleConfig): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    await tx.tenantSetting.upsert({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY_MODULES } },
      create: {
        tenantId: ctx.tenantId,
        key: KEY_MODULES,
        value: cfg as object,
        updatedBy: ctx.actorId ?? undefined,
      },
      update: {
        value: cfg as object,
        updatedBy: ctx.actorId ?? undefined,
      },
    });
  });
}

/**
 * Wirft, wenn das Modul deaktiviert ist. Server-Actions sollten am Anfang
 * `assertModuleEnabled(ctx, 'bwa')` aufrufen.
 */
export type BooleanModuleKey = BooleanTenantModuleKey;

export class ModuleDisabledError extends Error {
  constructor(public readonly module: BooleanModuleKey) {
    super(`Modul ${module} ist deaktiviert.`);
    this.name = 'ModuleDisabledError';
  }
}

/** Generischer serverseitiger Modul-Gate (wirft bei deaktiviertem Modul). */
export async function assertModuleEnabled(
  ctx: TenantContext,
  module: BooleanModuleKey,
): Promise<void> {
  const cfg = await readModules(ctx);
  if (!cfg[module]) {
    throw new ModuleDisabledError(module);
  }
}
