import { createHash, randomUUID } from 'node:crypto';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import type { TcmsClient, TcmsAkteurAngaben } from '../client';
import { rufeEndpunkt } from '../endpunkt';

// Jeder Fall arbeitet mit einem eigenen Nachtrag. Das reguläre Original
// und die Aufgaben aus den Bedienprüfungen bleiben auch bei Wiederholung verfügbar.
export async function neuerNachtrag(
  client: TcmsClient,
  code: string,
  mandantId: string,
  akteur: TcmsAkteurAngaben,
) {
  const { daten } = await rufeEndpunkt(client, ENDPUNKTE.kontextLesen, {
    params: { mandantId },
    akteur,
  });
  const abgeschlossen = ['OHNE_BEFUND', 'MIT_BEFUND', 'ENTFALLEN'];
  for (const original of daten.durchfuehrungen.filter(
    (d) => d.code === code && !d.ausserplanmaessig && abgeschlossen.includes(d.status),
  )) {
    const { daten: detail } = await rufeEndpunkt(client, ENDPUNKTE.durchfuehrungLesen, {
      params: { mandantId, durchfuehrungId: original.id },
      akteur,
    });
    if (detail.nachtraege.some((n) => !abgeschlossen.includes(n.anzeige))) continue;
    const { daten: neu } = await rufeEndpunkt(client, ENDPUNKTE.nachtragAnlegen, {
      params: { mandantId, durchfuehrungId: original.id },
      body: {
        begruendung: 'Eigene Durchführung zur Prüfung des gesehenen Bearbeitungsstands.',
      },
      akteur,
    });
    return { mandantId, durchfuehrungId: neu.durchfuehrungId };
  }
  throw new Error(`Kein abgeschlossenes Demo-Original für ${code} mit freiem Nachtrag.`);
}

/** Synthetische Dokumentreferenzen zur Einreichprüfung auf dem isolierten Demodienst. */
export async function ergaenzeTestnachweise(
  client: TcmsClient,
  ziel: { params: { mandantId: string; durchfuehrungId: string }; akteur: TcmsAkteurAngaben },
  mindestNachweise: number,
  anhaengen: typeof ENDPUNKTE.nachweisAnhaengen | typeof ENDPUNKTE.portalAnlageAnhaengen,
) {
  for (let i = 0; i < mindestNachweise; i++) {
    const dokumentId = randomUUID();
    const inhalt = Buffer.from(`Demo-Nachweis ${dokumentId}`);
    await rufeEndpunkt(client, anhaengen, {
      ...ziel,
      body: {
        verweis: {
          dokumentId,
          dateiname: 'Pruefnachweis.txt',
          mime: 'text/plain',
          groesse: inhalt.length,
          sha256: createHash('sha256').update(inhalt).digest('hex'),
        },
      },
    });
  }
}
