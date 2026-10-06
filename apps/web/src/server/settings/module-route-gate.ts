// =============================================================================
// Layout-Gate für tenantweit deaktivierte Module. Die Zuordnung Pfad → Modul
// steht ausschließlich in der Modul-Registry (lib/module-registry.ts), aus der
// auch Navigation und requireModulePage() lesen.
// =============================================================================

import {
  MODULE_AREAS,
  isModuleRequirementMet,
  moduleAreaForPath,
  type ModuleRequirement,
  type ModuleSurface,
} from '@/lib/module-registry';
import type { ModuleConfig } from './modules';

export function moduleRouteRequirement(
  surface: ModuleSurface,
  pathname: string,
): ModuleRequirement | null {
  const area = moduleAreaForPath(surface, pathname);
  return area ? MODULE_AREAS[area].requires : null;
}

/** Serverseitige Entscheidung für direkt adressierte Modul-Seiten. */
export function isModuleRouteEnabled(
  modules: ModuleConfig,
  surface: ModuleSurface,
  pathname: string,
): boolean {
  const requirement = moduleRouteRequirement(surface, pathname);
  return requirement ? isModuleRequirementMet(modules, requirement) : true;
}
