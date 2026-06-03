// =============================================================================
// Barrel der Kanzlei-Einstellungs-Actions.
//
// Die früher 890-zeilige God-Datei ist nach Domäne aufgeteilt
// (branding · modules · mail · infra). Dieser Re-Export hält den Import-Pfad
// `./actions` für alle Settings-Formulare stabil — die Actions selbst sind in
// den jeweiligen `'use server'`-Domänen-Dateien definiert. Benannte Re-Exports
// (statt `export *`) sind für Server-Actions am zuverlässigsten. ActionResult
// kommt zentral aus server/actions.
// =============================================================================

export type { ActionResult } from '@/server/actions/staff-action';

export { saveSellerInfoAction, saveBrandingAction, saveLetterheadAction, saveLegalAction } from './branding-actions';
export {
  saveModulesAction,
  saveAccessPolicyAction,
  saveClientLayoutAction,
  resetClientLayoutAction,
  savePortalFeaturesAction,
} from './modules-actions';
export { saveSmtpAction, resetSmtpAction, sendTestMailAction, saveMailDispatchAction } from './mail-actions';
export { saveTaxRegionAction, saveTsaAction, testTsaAction } from './infra-actions';
