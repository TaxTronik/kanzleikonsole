// =============================================================================
// TimestampPort — Adapter für RFC-3161-Zeitstempel.
//
// MVP: LocalTimestampAdapter (Self-Timestamp, keine externe TSA).
// Produktion: Rfc3161StubAdapter erweitern oder durch echte TSA-Implementierung
// ersetzen (z. B. D-Trust). Adapter wird in apps/web/src/server/container.ts
// bzw. apps/worker/src/container.ts verdrahtet.
// =============================================================================

export interface TimestampResult {
  /** ISO-8601-Zeitstempel der Versiegelung (UTC). */
  timestampedAt: string;
  /** Optionales TSA-Request-Blob (DER-encoded, falls echte TSA). */
  tsaRequestBlob: Uint8Array | null;
  /** Optionales TSA-Response-Blob (DER-encoded, falls echte TSA). */
  tsaResponseBlob: Uint8Array | null;
  /** Seriennummer der Stempel-Antwort, falls vorhanden. */
  tsaSerial: string | null;
}

export interface TimestampPort {
  /**
   * Adapter-Modus — vom Verify-Report IMMER ausgewiesen (Audit-Transparenz).
   *   'local'   = Self-Timestamp, keine externe Wahrheitsquelle (nur Dev/Test).
   *   'rfc3161' = echte externe TSA mit kryptografisch prüfbarer Antwort.
   * Eine app, die die App-Uhr speichert und „TSA-Zeit" nennt, ist eine Audit-
   * Falle; deshalb muss der Modus jederzeit sichtbar sein.
   */
  readonly mode: 'local' | 'rfc3161';

  /**
   * Liefert einen Zeitstempel über die übergebenen Bytes (typischerweise
   * der Tages-Spitzen-Hash der Audit-Chain).
   */
  timestamp(payload: Uint8Array): Promise<TimestampResult>;

  /**
   * Verifiziert ein gespeichertes TSA-Response-Blob gegen den ursprünglichen
   * Payload. Lokaler Adapter macht eine schwache Selbst-Prüfung.
   */
  verify(payload: Uint8Array, response: Uint8Array | null): Promise<boolean>;

  /**
   * Optional: wie verify(), liefert aber zusätzlich, ob die Cert-Kette bis zu
   * einem hinterlegten Trust-Anchor validiert (`trustAnchored`) oder ob das
   * Token nur kryptografisch wohlgeformt/an die Daten gebunden ist (cryptoOk,
   * No-Regress-Pfad ohne Anker). Nur der HTTP-Adapter implementiert das; der
   * Aufrufer nutzt es für Verankerungs-Transparenz und fällt sonst auf verify()
   * zurück.
   */
  verifyDetailed?(
    payload: Uint8Array,
    response: Uint8Array | null,
  ): Promise<{ ok: boolean; trustAnchored: boolean }>;
}

// -----------------------------------------------------------------------------
// LocalTimestampAdapter — Self-Timestamp ohne externe TSA.
//
// **Nicht für Produktion.** Vor Produktivstart zwingend durch echte TSA ersetzen.
// Speichert nur den UTC-Zeitstempel; verify() ist deshalb nicht aussagekräftig
// (es wird nur die Anwesenheit eines Zeitstempels geprüft).
// -----------------------------------------------------------------------------
export class LocalTimestampAdapter implements TimestampPort {
  readonly mode = 'local' as const;

  async timestamp(_payload: Uint8Array): Promise<TimestampResult> {
    return {
      timestampedAt: new Date().toISOString(),
      tsaRequestBlob: null,
      tsaResponseBlob: null,
      tsaSerial: null,
    };
  }

  async verify(_payload: Uint8Array, _response: Uint8Array | null): Promise<boolean> {
    // A3: Self-Timestamp ohne externe Quelle → es GIBT keine unabhängige Wahrheit,
    // gegen die geprüft werden könnte; verify() gibt daher immer true zurück. Folge:
    // ohne gesetzte TIMESTAMP_AUTHORITY_URL ist der Seal-Check in `verify:chain`
    // gegenstandslos (nur die SHA-256-Kette trägt dann). Vor Produktivstart durch
    // eine echte TSA + kryptografischen verify() ersetzen (siehe Klassen-Header).
    return true;
  }
}

// -----------------------------------------------------------------------------
// Rfc3161StubAdapter — Skelett für echte RFC-3161-Anbindung.
//
// Implementiert das Protokoll noch nicht; wird in einer späteren Iteration
// (vor Produktivstart) ausgefüllt. Liegt hier, damit das Interface eingebunden
// und vertragsgetestet werden kann.
// -----------------------------------------------------------------------------
export class Rfc3161StubAdapter implements TimestampPort {
  readonly mode = 'rfc3161' as const;

  constructor(private readonly tsaUrl: string) {}

  async timestamp(_payload: Uint8Array): Promise<TimestampResult> {
    throw new Error(
      `Rfc3161StubAdapter: echte TSA-Anbindung an ${this.tsaUrl} ist noch nicht implementiert. ` +
        'Vor Produktivstart ausimplementieren (RFC 3161 §3.4 TimeStampReq/TimeStampResp).',
    );
  }

  async verify(_payload: Uint8Array, _response: Uint8Array | null): Promise<boolean> {
    throw new Error('Rfc3161StubAdapter.verify ist noch nicht implementiert.');
  }
}
