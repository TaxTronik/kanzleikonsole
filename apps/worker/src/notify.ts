// =============================================================================
// notify() — der eine Benachrichtigungsweg der Worker-Jobs (R-11).
//
// Vorher existierten vier Wege nebeneinander: upsertNotificationTx direkt,
// ein eigener Upsert-Wrapper mit eigener Transaktion, handgeschriebene
// findFirst/update/create-Upserts (ohne Sperre, ohne Sanitizer) und createMany
// (tax-news-fetch speicherte RSS-Titel externer Feeds ungefiltert). Jetzt
// schreibt jeder Job über notify() in seiner Tenant-Transaktion; jeder Text
// läuft durch sanitizeNotificationText.
//
//   - dedupe 'unread' (Standard): Semantik von upsertNotificationTx — eine
//     ungelesene Benachrichtigung desselben Schlüssels (Tenant, Empfänger,
//     Art, Ressource) wird aktualisiert statt dupliziert; gebündelt über
//     upsertNotificationsTx.
//   - dedupe 'daily': tägliche Erinnerungen — jede Eingabe wird angelegt; die
//     Tages-Dedupe-Indizes überspringen Wiederholungen desselben UTC-Tags.
//
// Ein Konflikt mit den Tages-Dedupe-Indizes gilt in beiden Modi als „heute
// bereits geschrieben" und bricht die Transaktion nicht ab (früher: P2002).
// =============================================================================

import {
  insertNotificationsTx,
  upsertNotificationsTx,
  type NotificationBatchResult,
  type NotificationUpsertInput,
} from '@taxtronik/db/notification';
import type { withWorkerTenantContext } from './tenant-context';

export type NotifyInput = NotificationUpsertInput;
export type NotifyResult = NotificationBatchResult;
export type NotifyTx = Parameters<Parameters<typeof withWorkerTenantContext>[1]>[0];

export interface NotifyOptions {
  dedupe?: 'unread' | 'daily';
}

function isInputList(input: NotifyInput | readonly NotifyInput[]): input is readonly NotifyInput[] {
  return Array.isArray(input);
}

export async function notify(
  tx: NotifyTx,
  input: NotifyInput | readonly NotifyInput[],
  options: NotifyOptions = {},
): Promise<NotifyResult> {
  const inputs = isInputList(input) ? input : [input];
  if (inputs.length === 0) return { created: 0, updated: 0 };
  if (options.dedupe === 'daily') {
    return { created: await insertNotificationsTx(tx, inputs), updated: 0 };
  }
  return upsertNotificationsTx(tx, inputs);
}
