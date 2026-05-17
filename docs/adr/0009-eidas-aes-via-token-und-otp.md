# ADR 0009 — eIDAS Advanced Electronic Signature (AES) für Vollmachten

**Status**: Akzeptiert (Iteration 5, MVP-Variante)
**Datum**: 2026-05-10
**Kontext**: Vollmachten an die Kanzlei (z. B. Vertretung gegenüber Finanzamt)
müssen rechtsverbindlich elektronisch unterschrieben werden können.
Die Anforderung an eine "fortgeschrittene elektronische Signatur" (eIDAS
Art. 26) verlangt eindeutige Zuordnung, alleinige Kontrolle und
Manipulations-Erkennbarkeit.

## Entscheidung

**Zwei-Faktor-Verfahren via App + E-Mail-OTP**:

1. **Faktor "Was man hat"**: ein 32-Byte-Random-Token, gehasht in
   `power_of_attorney.signing_token_hash`, im Klartext im Magic-Link an die
   Mandanten-E-Mail-Adresse versendet (TTL 72h)
2. **Faktor "Was man weiß"**: ein 6-stelliger OTP, gehasht in
   `signing_otp_hash`, im Klartext bei Klick auf "Signieren" per separater
   Mail an dieselbe Adresse (TTL 10 Minuten)

Der Signatur-Beleg umfasst:
- IP-Adresse + User-Agent zum Zeitpunkt des Signierens
- Audit-Eintrag in der Hash-Chain (Action `poa.sign`)
- `signed_at`-Timestamp

Beim Klick auf "Signieren" wird beides geprüft, der Status atomar auf
`SIGNED` gesetzt (UPDATE…WHERE status='SENT'), und beide Token entwertet.

## Konsequenzen

**Vorteile**
- Erfüllt eIDAS-AES-Anforderungen ohne Smartcard/Reader
- Kosten: 0 € (gegenüber QES-Plug-ins ab 1 €/Signatur)
- 100% web-basiert, kein App-Download für Mandanten
- Audit-Trail vollständig hash-gechained → manipulationsfest

**Nachteile**
- Keine **Qualified Electronic Signature** (QES) — für Verträge wie
  Bürgschaften nach BGB §766 nicht ausreichend (dort braucht's QES nach
  eIDAS Art. 25 Abs. 2)
- Mailbox-Kompromittierung des Mandanten reicht zum Signieren
  → Mitigation: zwei separate Mails (Magic-Link + OTP) mit kurzem
  OTP-Fenster (10 min)
- Klartext-Token in der Mail = Sender-Mail-Provider sieht ihn

## Erweiterungspfad

Der `EidasSignaturePort`-Interface ist offen für QES-Plug-ins:
- D-Trust ID-Card (Smartcard + Lesegerät)
- swisscom Mobile-ID (mTAN am Mobiltelefon)
- TR-ESOR konformer Adapter

Die App-Logik bleibt gleich (`status: PENDING_SIGNATURE → SIGNED`),
nur der "wie wird signiert"-Schritt ist austauschbar.

## Alternativen verworfen

- Nur Magic-Link, kein OTP (das wäre nur "Simple Electronic Signature")
- DocuSign-Integration (US-Provider, DSGVO-Risiko, Kosten pro Signatur)
- Smartcard-Pflicht (UX-killer für Mandanten)
