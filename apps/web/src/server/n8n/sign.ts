// =============================================================================
// Re-Export aus @taxtronik/n8n-shared.
//
// Vorher Code-Duplikation zwischen sign.ts (Web) und einer Inline-Funktion
// in apps/worker/src/jobs/n8n-deliver.ts. Beide bauten dieselben drei
// Zeilen `${event}\n${ts}\n${body}` + `sha256=${hex}`. Konsolidierung
// Round 12.
// =============================================================================

export { signOutboundN8n, type OutboundSignature } from '@taxtronik/n8n-shared';
