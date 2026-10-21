# GwG — Pflichten und technische Umsetzung in taxtronik

Stand: 2026-08-23. Steuerberater sind Verpflichtete nach § 2 Abs. 1 Nr. 12
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

Bei einer Geschäftsbeziehung beginnt die Frist mit dem Schluss des
Kalenderjahres ihres Endes (`client.mandateEndedAt`). In den übrigen Fällen —
insbesondere wenn die Erstprüfung offen liegen blieb oder keine Beziehung
zustande kam — beginnt sie mit dem Schluss des Feststellungsjahres. Löschreif
ist der Datensatz grundsätzlich ab dem 1. Januar nach fünf vollen Jahren
(`gwgDeletionDeadline()` in `apps/web/src/server/gwg/retention.ts`). Die
absolute Zehnjahresgrenze läuft ab demselben maßgeblichen Fristbeginn
(`gwgMaximumDeletionDeadline()`), also bei einer Geschäftsbeziehung erst ab
deren Ende. Das bloße Alter eines Belegs oder Checks löst bei einer laufenden
Beziehung keine Vernichtung aus.

**Umsetzung: Review-Queue `/staff/admin/gwg-retention`** — die Vernichtung
bestätigt ein ADMIN/PARTNER explizit, es gibt kein stilles Auto-Delete von
Rechtsbelegen. Ein Eintrag erscheint nach Ablauf der regulären Fünfjahresfrist.
Bleibt die manuelle Prüfung bis zur absoluten Zehnjahresgrenze offen, eskaliert
die Queue den Löschgrund und die angezeigte Frist auf **absolute
10-Jahres-Grenze**. Diese Eskalation löscht weiterhin nichts automatisch. Zwei
Vernichtungsstufen:

1. **Datei-Belege** (`confirmGwgDeletionAction`): prüft serverseitig
   Klassifikation, gesetzliche Frist und Object-Lock-Ablauf, vernichtet
   dann die Bytes aller Versionen im Object-Store und löscht deren
   `document_version`-Zeilen. Reihenfolge: Vormerkung und DB-Claim
   (`app.assert_gwg_document_destruction_due`) in einer Transaktion, Commit,
   erst danach die Bytes, zuletzt der DB-Abschluss. Ein im Tax-CMS verknüpftes
   Dokument (Nachweis einer Kontrolldurchführung oder Anlage einer
   Ereignismeldung, TCMS-NACHWEIS-001) wird nicht vernichtet: Die Aktion
   prüft die Verknüpfung vor der Vormerkung und vor jedem Object-Store-Löschen,
   der Claim unter der Dokumentsperre (RT3B-K-01). Ein gebundenes Dokument
   kann seit TCMS Stufe 3 nicht mehr zum GwG-Beleg werden; betroffen ist nur
   Altbestand, der vor der Behebung umklassifiziert wurde. Ein solcher
   GwG-Beleg gilt zugleich als steuerliche Unterlage (Produktentscheidung
   Rey Koxha, 21.10.2026, fachlich ungeprüft; kk-tcms-s11): Sein
   Aufbewahrungsende (`retention_until`) steigt auf die GoBD-Frist der
   Steuerunterlage (zehn Jahre ab dem Anlagejahr, 1. Januar des Folgejahres;
   `app.tcms_gwg_evidence_tax_retention_until`), und die Vernichtung ist erst
   nach Ablauf beider Fristen zulässig – auch nach der Freigabe der
   Verknüpfung (Aktion mit festem Text, Claim unter der Dokumentsperre).
   Freigegebene Verweise des Tax-CMS werden mit dem Beleg vernichtet. Der
   `document`-Skelettdatensatz bleibt mit
   `deletedAt`/`gwgDestroyedAt` als Abschlussvermerk erhalten; auditiert wird
   als `gwg.evidence.destroy` (der Vernichtungsnachweis bleibt dauerhaft in
   der insert-only Audit-Chain).
2. **DB-Aufzeichnungen** (`confirmGwgCheckDeletionAction`): erst zulässig,
   wenn keine Datei-Belege des Mandanten mehr existieren. Wirtschaftlich
   Berechtigte werden gelöscht, Ausweis-Detailfelder genullt
   (`ownerName` → „VERNICHTET"), Risiko-Antworten/Notizen entfernt. Ein
   Skelett-Datensatz mit Status, Risiko-Stufe, `verifiedAt` und
   `destroyedAt` als Vernichtungsvermerk bleibt als Nachweis, DASS
   geprüft wurde; auditiert als `gwg.check.destroy`.

**Erinnerung**: Der tägliche Worker `gwg-expiry-check` schickt eine
idempotente `GWG_DELETION_DUE`-Notification an alle ADMIN/PARTNER, sobald
Belege oder Aufzeichnungen beendeter Mandate oder nie zustande gekommener
Beziehungen nach dem jeweils maßgeblichen Fristbeginn löschreif sind
(Tages-Dedupe pro Tenant), mit Link auf die Review-Queue.

**Aufbewahrungsende (kk-tcms-s11):** Ein Datei-Beleg ist erst löschreif, wenn
auch sein Aufbewahrungsende (`retention_until`) erreicht ist – dieselbe Grenze
prüfen Aktion und Claim. Vorher erscheint er weder in der Queue noch in Kachel
und Benachrichtigung. Ein Beleg ohne Aufbewahrungsende bleibt sichtbar; die
Aktion weist ihn mit Hinweis auf den fehlenden Stichtag ab.

**Zählungen (Welle 15):** Admin-Kachel, Review-Queue und Benachrichtigung
zählen Datei-Belege und Aufzeichnungen mit denselben Filtern
(`@taxtronik/gwg`). Kachel und Queue zeigen die für den Betrachter sichtbaren
Einträge (RLS der App-Rolle). Die Benachrichtigung zählt Datei-Belege
kanzleiweit über den Owner-Client und damit auch Belege, die RLS selbst
ADMIN/PARTNER nicht anzeigt: Übergabeprotokolle und -archive einer
Mandatsübergabe (Klasse `GWG_EVIDENCE`), deren übergebene Quelldokumente nicht
mehr vollständig sind oder deren Mandant anonymisiert ist. Sie nennt deren
Anzahl gesondert („Davon zeigt die Review-Queue … nicht an“). Diese Belege
lassen sich in der Queue derzeit nicht vernichten; das Vorgehen dafür ist noch
fachlich zu entscheiden.

## 4. Was die Kanzlei selbst regeln muss

- Risikoanalyse der Kanzlei nach § 5 GwG (Dokument, jährliche Prüfung)
- Interne Sicherungsmaßnahmen + Geldwäschebeauftragter nach §§ 6–7 GwG
  (soweit anwendbar)
- Verdachtsmeldungen nach § 43 GwG (goAML) — kein taxtronik-Modul
- Beschaffung von HR-Auszug und Transparenzregister-Auszug (in taxtronik
  als Dokumenttyp `TRANSPARENZREGISTER_AUSZUG` ablegbar; ein
  automatisierter Registerabruf existiert nicht)
- Pflege von `mandateEndedAt` bei Mandatsende — ohne dieses Datum kann für eine
  tatsächlich zustande gekommene Geschäftsbeziehung weder die reguläre noch
  die absolute Frist ab Beziehungsende beginnen

## Querverweise

- [dsgvo-konzept.md](./dsgvo-konzept.md) § 2 — Aufbewahrungsfristen und
  technische Durchsetzung
- [gobd.md](./gobd.md) § 1 — Abgrenzung GoBD-Bucket / GwG-Bucket
- ADR-0007 — GwG-Schranke via DB-Trigger
