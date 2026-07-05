// =============================================================================
// @taxtronik/elster — Public API.
//
// Neutrale Schnittstelle zur eric-bridge (privater Dienst, Repo
// taxtronik-eric-bridge): Typen + HTTP-Client + Feature-Gating. Bewusst OHNE
// Schema-/Spezifikationswissen — Datenteil und TransferHeader entstehen in
// der Bridge (Vertraulichkeit der ELSTER-Unterlagen, siehe
// docs/development/eric-integration.md).
// =============================================================================

export {
  ElsterBridgeClient,
  ElsterBridgeHttpError,
  ElsterKontoabfrageInputError,
} from './client';
export type { ElsterBridgeClientOptions, KontoabfrageInput, Uebertragung } from './client';

export {
  isElsterConfigured,
  requireElsterConfig,
  ElsterNotConfiguredError,
} from './config';
export type { ElsterConfig } from './config';

export {
  BridgeHealthSchema,
  ValidateResponseSchema,
  AbfrageResponseSchema,
  KontoabfrageResponseSchema,
  KontoabfrageTeilSchema,
  KontoSteuerartSchema,
  IstAbfrageSchema,
  OffeneBetraegeAbfrageSchema,
  SollstellungenAbfrageSchema,
} from './schema';
export type {
  BridgeHealth,
  ValidateResponse,
  AbfrageResponse,
  KontoabfrageResponse,
  KontoabfrageTeil,
  KontoSteuerart,
} from './schema';
