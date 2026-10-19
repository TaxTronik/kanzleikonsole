// =============================================================================
// TCMS-Dienst in der Web-App (TCMS Stufe 2): Client einmal je Prozess und
// Aktivierungs-Gate.
//
// Aktiv ist das TCMS für einen Tenant nur mit Modulschalter `tcms` an UND
// TCMS_DEPLOYMENT != disabled (istTcmsAktiv aus @taxtronik/tcms-client; dieselbe
// Regel im Worker: isWorkerTcmsActive in apps/worker/src/module-gate.ts).
// Server-Aktionen rufen `assertTcmsAktivTx` bzw. `assertTcmsAktiv` vor jedem
// TCMS-Aufruf; die Akteursbestätigung kommt aus ./akteur.ts.
//
// Konfiguration und Client entstehen beim ersten Zugriff einmal: Der private
// Schlüssel wird dabei genau einmal als KeyObject geladen (getTcmsConfig) und
// bleibt im Client; das Boot-Gate hat dieselben Regeln schon beim Start geprüft.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import type { TenantContext } from '@taxtronik/db/tenant-context';
import { getTcmsConfig, type TcmsConfig } from '@taxtronik/config/env-schema';
import { PERSONEN_AKTEURE, TcmsClient, istTcmsAktiv } from '@taxtronik/tcms-client';
import { ActionError } from '@/server/actions/action-error';
import { readModules, readModulesTx } from '@/server/settings/modules';

interface Dienst {
  config: TcmsConfig | null;
  client: TcmsClient | null;
}

let dienst: Dienst | undefined;

function laden(): Dienst {
  if (!dienst) {
    const config = getTcmsConfig();
    // TCMS Stufe 4: Die Web-App bestätigt nur Personen; den Systemakteur bildet
    // und signiert allein der Zustell-Worker (Guard tcms-systemakteur-guard.test.ts).
    dienst = {
      config,
      client: config ? new TcmsClient({ config, akteurArten: PERSONEN_AKTEURE }) : null,
    };
  }
  return dienst;
}

/** Nur für Tests: Konfiguration beim nächsten Zugriff neu lesen. */
export function tcmsDienstZuruecksetzen(): void {
  dienst = undefined;
}

/** Client des Prozesses oder `null` bei TCMS_DEPLOYMENT=disabled. */
export function tcmsClient(): TcmsClient | null {
  return laden().client;
}

/**
 * Dienst konfiguriert (TCMS_DEPLOYMENT managed/external), unabhängig vom
 * Modulschalter des Tenants. Speist die Sichtbarkeit der Navigation
 * (`dienste.tcms`, TCMS Stufe 3); Seiten und Aktionen prüfen zusätzlich
 * `tcmsAktivTx` (Schalter UND Konfiguration).
 */
export function tcmsKonfiguriert(): boolean {
  return laden().config !== null;
}

/** Fachfehler mit UI-tauglicher Meldung (toActionError reicht sie durch). */
export class TcmsInaktivError extends ActionError {
  constructor() {
    super('Das Tax-CMS ist für diese Kanzlei nicht aktiv.');
    this.name = 'TcmsInaktivError';
  }
}

/** Modul `tcms` an und Dienst konfiguriert – in einer laufenden Tenant-Transaktion. */
export async function tcmsAktivTx(tx: TxClient, tenantId: string): Promise<boolean> {
  return istTcmsAktiv((await readModulesTx(tx, tenantId)).tcms, laden().config);
}

export async function assertTcmsAktivTx(tx: TxClient, tenantId: string): Promise<void> {
  if (!(await tcmsAktivTx(tx, tenantId))) throw new TcmsInaktivError();
}

/** Wie `assertTcmsAktivTx`, mit eigener (request-gecachter) Modul-Abfrage. */
export async function assertTcmsAktiv(ctx: TenantContext): Promise<void> {
  if (!istTcmsAktiv((await readModules(ctx)).tcms, laden().config)) throw new TcmsInaktivError();
}
