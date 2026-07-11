# GwG — Pflichten und technische Umsetzung in taxtronik

Stand: 2026-06-10. Steuerberater sind Verpflichtete nach § 2 Abs. 1 Nr. 12
GwG. Dieses Dokument mappt die zentralen GwG-Pflichten auf die Module, die
sie in taxtronik abbilden. Es ersetzt NICHT die kanzleieigene Risikoanalyse
nach § 5 GwG und die internen Sicherungsmaßnahmen nach § 6 GwG — beides
bleibt organisatorische Pflicht der Kanzlei.

---

## 1. Identifizierung und Risikoanalyse (§§ 10–12 GwG)

**Umsetzung: GwG-Modul + Onboarding-Wizard.**

- Pro Mandant eine GwG-Prüfung (`gwg_check`) mit regelbasiertem
  Risiko-Score (§ 10 GwG), Identifizierungsdokumenten (§ 12 GwG,
  `gwg_id_document` mit Ausweis-Vorder-/Rückseite) und wirtschaftlich
  Berechtigten (§ 11 GwG, `gwg_beneficial_owner`).
- Status-Maschine DRAFT → IN_REVIEW → VERIFIED / REJECTED → EXPIRED.
- **Systemische Schranke** (ADR-0007): DB-Trigger + App-Guard blocken
  Anforderungen, Rechnungen und Dokumente, solange der Mandant nicht
  VERIFIED ist (`client.allow_active = false`).
- **GwG-Onboarding-Einladung**: token-basierter 4-Schritt-Wizard, mit dem
  sich der Mandant ohne Portal-Account selbst identifiziert (Stammdaten →
  wirtschaftlich Berechtigte → Ausweis-Uploads → Zusatz-Dokumente);
  Audit-Trail mit IP + User-Agent.
- Periodische Wiederholung: Hochrisiko jährlich, sonst alle 3 Jahre;
  Worker-Eskalation bei Ablauf (90/30 Tage, Deaktivierung bei Expiry).
- GwG-relevante Stammdaten-Änderungen setzen einen VERIFIED-Check
  automatisch auf IN_REVIEW zurück (Re-Verifikation).

## 2. Aufzeichnungs- und Aufbewahrungspflicht (§ 8 Abs. 1–3 GwG)

**Umsetzung: `gwg_check`-Aggregat + GWG_EVIDENCE-Belege.**

- Aufzeichnungen liegen strukturiert in `gwg_check`,
  `gwg_beneficial_owner` und `gwg_id_document`.
- Datei-Belege (Ausweisbilder, Nachweise) werden als Klassifikation
  `GWG_EVIDENCE` in einem **eigenen Bucket `gwg`** gespeichert —
  Object-Lock-Modus **GOVERNANCE**, Retain-Until 5 Jahre + 1 Tag
  (`gwgRetentionUntil()` in `packages/storage/src/service.ts`).
- Warum GOVERNANCE statt COMPLIANCE: Der gesetzliche Fristbeginn hängt unter
  anderem vom Ende der Geschäftsbeziehung ab. GOVERNANCE schützt vor regulärer
  Löschung, erlaubt aber die kontrollierte Löschung am von der Review-Queue
  ermittelten Fristende (`s3:BypassGovernanceRetention`). GoBD-Belege bleiben
  davon unberührt (COMPLIANCE, je Datei-Typ 6/8/10 Jahre).

## 3. Vernichtungspflicht (§ 8 Abs. 4 GwG)

Die Frist beginnt mit dem Schluss des Kalenderjahres, in dem die
Geschäftsbeziehung endet (`client.mandateEndedAt`); löschreif ist ein
Mandat ab dem 1. Januar nach Jahresende + 5 Jahren
(`gwgDeletionDeadline()` in `apps/web/src/server/gwg/retention.ts`).

**Umsetzung: Review-Queue `/staff/admin/gwg-retention`** — die Vernichtung
bestätigt ein ADMIN/PARTNER explizit, es gibt kein stilles Auto-Delete von
Rechtsbelegen. Zwei Stufen:

1. **Datei-Belege** (`confirmGwgDeletionAction`): prüft serverseitig
   Klassifikation, gesetzliche Frist und Object-Lock-Ablauf, vernichtet
   dann die Bytes aller Versionen im Object-Store und löscht die
   DB-Records; auditiert als `gwg.evidence.destroy` (der Vernichtungs-
   Nachweis bleibt dauerhaft in der insert-only Audit-Chain).
2. **DB-Aufzeichnungen** (`confirmGwgCheckDeletionAction`): erst zulässig,
   wenn keine Datei-Belege des Mandanten mehr existieren. Wirtschaftlich
   Berechtigte werden gelöscht, Ausweis-Detailfelder genullt
   (`ownerName` → „VERNICHTET"), Risiko-Antworten/Notizen entfernt. Ein
   Skelett-Datensatz mit Status, Risiko-Stufe, `verifiedAt` und
   `destroyedAt` als Vernichtungsvermerk bleibt als Nachweis, DASS
   geprüft wurde; auditiert als `gwg.check.destroy`.

**Erinnerung**: Der tägliche Worker `gwg-expiry-check` schickt eine
idempotente `GWG_DELETION_DUE`-Notification an alle ADMIN/PARTNER, sobald
Belege oder Aufzeichnungen beendeter Mandate löschreif sind (Tages-Dedupe
pro Tenant), mit Link auf die Review-Queue.

## 4. Was die Kanzlei selbst regeln muss

- Risikoanalyse der Kanzlei nach § 5 GwG (Dokument, jährliche Prüfung)
- Interne Sicherungsmaßnahmen + Geldwäschebeauftragter nach §§ 6–7 GwG
  (soweit anwendbar)
- Verdachtsmeldungen nach § 43 GwG (goAML) — kein taxtronik-Modul
- Beschaffung von HR-Auszug und Transparenzregister-Auszug (in taxtronik
  als Dokumenttyp `TRANSPARENZREGISTER_AUSZUG` ablegbar; ein
  automatisierter Registerabruf existiert nicht)
- Pflege von `mandateEndedAt` bei Mandatsende — ohne dieses Datum kann
  die Lösch-Queue die Frist nicht berechnen

## Querverweise

- [dsgvo-konzept.md](./dsgvo-konzept.md) § 2 — Aufbewahrungsfristen und
  technische Durchsetzung
- [gobd.md](./gobd.md) § 1 — Abgrenzung GoBD-Bucket / GwG-Bucket
- ADR-0007 — GwG-Schranke via DB-Trigger
