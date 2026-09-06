# Erste Schritte: Die Kanzlei in 30 Minuten einrichten

Dieses Kapitel führt Administratoren nach der frischen Installation durch
die Inbetriebnahme. Die Software begleitet diesen Weg selbst: Auf dem
Dashboard und unter **Administration → Übersicht** erscheint die Checkliste
**„Erste Schritte zur Inbetriebnahme"** — jeder Punkt prüft den echten
Systemzustand, verlinkt direkt an die richtige Stelle und hakt sich von
selbst ab, sobald er erledigt ist. Ist alles eingerichtet, verschwindet die
Liste. Wer TaxTronik bereits anderweitig vollständig eingerichtet hat, kann
die Einführung unter **Administration → Übersicht** überspringen und dort
später über die Quick-Links wieder einblenden. Das Ausblenden verändert keine
fachliche Konfiguration.

> Voraussetzung: Die Installation wurde vom Betreiber provisioniert
> (Kanzlei-Tenant + Admin-Konto, ohne Demodaten — siehe
> [Betriebsdoku, Release/Update §2.1](../operations/release.md)). Sie haben
> die Zugangsdaten des Admin-Kontos erhalten.

## 1. Erster Login und Anmeldeschutz (≈ 5 min)

Melden Sie sich unter `/staff/login` an (E-Mail, Passwort, Kanzlei-Kürzel
aus der Provisionierung). Beim ersten Login richten Sie im Standardmodus
verpflichtend die Zwei-Faktor-Authentisierung ein: QR-Code mit einer
Authenticator-App scannen, Code bestätigen, **die acht Backup-Codes sicher
verwahren** (es gibt keinen Self-Service-Reset — siehe
[Administration](administration.md)). Danach: initiales Passwort beim Betreiber
als verbraucht melden bzw. die `.admin-credentials.txt` auf dem Server löschen
lassen.

Wer ausschließlich physische FIDO2-Sicherheitsschlüssel verwenden möchte,
registriert anschließend im eigenen Profil mindestens zwei geeignete Schlüssel
und aktiviert den Modus dort ausdrücklich mit einem dieser Schlüssel. Ab dann
sind Passwort, TOTP und Backup-Codes kein Login-Fallback. Der zweite Schlüssel
ist getrennt zu verwahren; der Verlust aller Schlüssel erfordert die
hierarchische Kontowiederherstellung. Zuvor muss der Betreiber eine nichtleere
Liste geprüfter Modell-AAGUIDs und den FIDO-MDS-Zugriff eingerichtet haben;
ansonsten sperrt TaxTronik den Hardware-Pfad fail-closed. Die Attestation weist
eine Modellfamilie nach, nicht zwei unterschiedliche physische Geräte.
Anforderungen und Grenzen stehen unter
[Administration](administration.md#1-benutzerverwaltung-kanzlei-mitarbeiter).

## 2. Die Checkliste durchgehen (≈ 15 min)

In der empfohlenen Reihenfolge — jeder Punkt ist aus der Checkliste heraus
direkt verlinkt:

1. **Erscheinungsbild** — Logo und Anzeigename der Kanzlei (erscheinen in
   beiden Oberflächen und in E-Mails).
2. **Bundesland** — liefert den technischen Standardkalender für die
   Werktagsverschiebung. Es ist nicht automatisch der rechtlich maßgebliche
   Feiertagsort eines konkreten Bekanntgabe- oder Fristvorgangs.
3. **Kanzlei-Stammdaten** — Name, Anschrift, **USt-ID oder Steuernummer**,
   **E-Mail und Telefon**. Eine der beiden steuerlichen Kennungen genügt. Die
   Kontaktdaten sind Pflichtangaben der E-Rechnung (XRechnung); ohne sie
   verweigert die Rechnungserzeugung mit klarer Meldung.
4. **E-Mail-Versand (SMTP)** — ohne ihn kein Mandanten-Login (Magic-Link)
   und keine Benachrichtigungs-Mails. Eine vom Betreiber aktive
   `SMTP_*`-Konfiguration aus der `.env` wird automatisch erkannt; eine
   zusätzliche Tenant-Konfiguration ist dann optional. Mit der Testfunktion
   prüfen.
5. **Module & Rechnungsmodus** — einmal bewusst speichern, auch wenn die
   Voreinstellung passt. Wichtigste Entscheidung: Rechnungen **In-App**
   (Positionen + E-Rechnung in TaxTronik), **Extern** (PDF-Ablage aus der
   Kanzleisoftware) oder **Aus**.
6. **n8n-Automatisierungen** — unter _Einstellungen → n8n-Automatisierung_ entweder
   den geführten Assistenten abschließen, jedes benötigte Workflow-Ziel als
   Entwurf speichern, mit synthetischen Daten testen und danach unverändert
   aktivieren oder n8n ausdrücklich deaktivieren. Eine
   Instanz-URL allein genügt nicht: jeder Workflow benötigt seine exakte
   Production-Webhook-URL
   ([n8n-Automatisierungen](n8n-automatisierungen.md)).
7. **Erster Mandant** — anlegen und die GwG-Prüfung abschließen; erst
   dann wird der Mandant „aktiv" und kann Anforderungen und Rechnungen
   erhalten (produktseitige GwG-Schranke, von der Datenbank erzwungen).
8. **Portal-Kontakt** — in der Mandantenakte unter _Kontakte_ einladen;
   Mandanten melden sich ausschließlich per E-Mail-Link an.

## 3. Team einrichten (≈ 10 min)

Unter **Administration → Benutzer**: Konten für die Mitarbeiter anlegen
(jede Person richtet zunächst ihre Zwei-Faktor-Anmeldung selbst ein und kann
danach optional auf mindestens zwei physische Sicherheitsschlüssel umstellen).
Für
Mitarbeiter ohne Admin-/Partner-Rolle die **Berechtigungen** setzen —
_Rechnungen anlegen/bearbeiten_, _Rechnungen versenden_ und _Urlaub
entscheiden_ sind Einzelrechte; neue Konten starten ohne
(siehe [Administration](administration.md)). Zuständigkeiten je Mandant
(Berufsträger/Hauptbearbeiter) pflegen Sie in der Mandantenakte; ob
Mitarbeiter alle oder nur zugeordnete Mandanten sehen, steuert das
Zugriffsmodell in den Einstellungen.

## 4. Erste Arbeitsschritte zum Kennenlernen

- Eine **Anforderung** an den Testmandanten stellen und im Portal (als
  eingeladener Kontakt) beantworten — so sehen Sie beide Seiten.
- Eine **Rechnung** im Entwurf anlegen und versenden: Die Nummer wird
  automatisch lückenlos vergeben, beim Versand entsteht die
  mit Object-Lock geschützte Archivkopie und die Rechnung wird festgeschrieben
  ([Rechnungen](rechnungen.md)).
- **Administration → Übersicht** zeigt dauerhaft den Compliance-Status:
  Prüfprotokoll-Kette, letztes Backup, monatlicher Wiederherstellungstest.
