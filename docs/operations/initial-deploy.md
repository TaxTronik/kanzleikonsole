# Erstinstallation

Die produktive Erstinstallation beginnt immer mit:

```bash
./taxtronik deploy
```

Wer Konfiguration und Aktivierung bewusst trennen möchte, verwendet zuerst
`./taxtronik config` und danach `./taxtronik deploy`. Der historische Befehl
`bootstrap` ist nur noch ein Kompatibilitätsalias für `deploy`.

Solange noch keine `.env` existiert, fragt der Assistent zuerst nach dem
Betriebsweg. Er schreibt bis zur abschließenden, wörtlichen Bestätigung keine
Konfiguration.

## Betriebswege

### Standard (empfohlen)

Die Standardmethode ist für bestehende, gehärtete oder bereits anderweitig
verwaltete Server gedacht. TaxTronik veröffentlicht die Anwendung nur auf
`127.0.0.1`; der Betreiber bindet nginx, Caddy, Traefik, einen Load-Balancer
oder ein vorhandenes Ingress-System selbst an. Bestehende Container, Dienste,
Firewallregeln und Zertifikate werden nicht übernommen oder verändert.

Diese Variante ist die richtige Wahl, sobald die Maschine nicht zweifelsfrei
leer ist.

### 1-Klick mit Traefik

Der 1-Klick-Pfad richtet zusätzlich einen gehärteten Traefik mit automatischen
Let's-Encrypt-Zertifikaten ein. Er ist **ausschließlich für eine komplett leere
Linux-/Docker-Maschine** bestimmt. Der Assistent verweigert diesen Weg, wenn

- bereits Docker-Container vorhanden sind,
- Port 80 oder 443 belegt ist oder
- TaxTronik-, Migrations- oder Restore-State erkannt wird.

Traefik erhält keinen Docker-Socket. Zwei statisch gerenderte TLS-Routen leiten
Kanzlei-/Mitarbeiterportal und Mandantenportal intern an die App weiter; das n8n-UI bleibt weiterhin nur
auf Loopback erreichbar. Der Proxy läuft mit schreibgeschütztem Root-Dateisystem,
reduzierten Linux-Capabilities, begrenzten Logs und einem persistenten
ACME-Volume. Dieses Volume wird im verschlüsselten `backup-full` mitgesichert.

## Voraussetzungen

Die Standardmethode setzt Docker Engine mit Compose-v2-Plugin, Git, Node.js
`>=24.11.0 <25`, pnpm 11 und `curl` als bewusst betreiberverwaltete
Host-Werkzeuge voraus.

Beim 1-Klick-Weg reicht ein ausgecheckter, freigegebener TaxTronik-Release auf
einem unterstützten Debian-/Ubuntu-Host. Erst nach der wörtlichen Bestätigung
installiert der Assistent fehlende Basispakete, Docker Engine samt Buildx und
Compose aus dem offiziellen Docker-Repository sowie ein SHA-256-verifiziertes,
fest versioniertes Node.js 24 mit dem im Repository gepinnten pnpm. Zusätzlich
braucht dieser Weg:

- einen Linux-Host mit leerem Docker-Daemon,
- freie, aus dem Internet erreichbare TCP-Ports 80 und 443,
- direkte A- oder AAAA-Records für Staff und Portal auf die Server-IP sowie
- eine beim Provider geöffnete Host-/Netzwerk-Firewall.

Der Assistent verändert weder die Host- noch die Provider-Firewall.
Vorgeschaltete CDN-/Proxy-DNS-Modi müssen für die initiale DNS- und ACME-Prüfung
deaktiviert sein. Andere Linux-Distributionen verwenden die Standardmethode
und provisionieren ihre Host-Werkzeuge selbst.

## Abgefragte Konfiguration

Der Assistent validiert und fasst vor der Anwendung zusammen:

- Bezugsweg: aktueller Git-Stand oder veröffentlichtes Release,
- die zwei tatsächlich verwendeten vollständigen Domains: Kanzlei-/Mitarbeiterportal
  (zum Beispiel `portal.taxtronik.de`) und Mandantenportal
  (zum Beispiel `mandanten.taxtronik.de`),
- Kanzleiname und Admin-E-Mail,
- SMTP-Ziel und optionale Zugangsdaten,
- Signal als verwalteter Docker-Dienst, externe/native API oder deaktiviert,
- beim 1-Klick-Weg ACME-E-Mail und erwartete öffentliche Server-IP.

Secrets werden nicht in der Zusammenfassung ausgegeben. Für die Standardmethode
muss exakt `KONFIGURATION UEBERNEHMEN`, für den 1-Klick-Weg bewusst
`LEERE MASCHINE INSTALLIEREN` bestätigt werden. Erst danach entsteht die auf
`0600` gesetzte `.env`; fehlende Secrets werden getrennt generiert.

Beim empfohlenen Git-/Source-Weg leitet die CLI die Identität automatisch als
`source-<12-stelliger Commit>` aus dem ausgecheckten Stand ab. Es wird keine
SemVer abgefragt. Nur wenn ausdrücklich „Veröffentlichtes Release“ gewählt
wird, muss der exakte bereits publizierte Tag `X.Y.Z` angegeben werden; dann
werden signierte Registry-Artefakte statt lokaler Builds verwendet.

## Signal und Embeddings

`managed` lässt TaxTronik ein mit dem Release getestetes, self-contained
CPU-Image von Signal installieren und bei TaxTronik-Updates mitziehen.
`external` bindet eine native, ROCm-/CUDA- oder separat betriebene Installation
nur per API an; TaxTronik startet, stoppt oder aktualisiert sie niemals.

Das Initialsetup startet **keinen Embedding-Aufbau** und aktiviert **keinen
Zeitplan**. Ein Administrator muss einen manuellen Aufbau nach einer deutlichen
Ressourcenwarnung bestätigen oder den Wochenplan später ausdrücklich in
Administration → Einstellungen → Integrationen einschalten. Ein laufender
Aufbau kann dort kooperativ abgebrochen werden.

## Nach der Installation

```bash
./taxtronik doctor
./taxtronik ps
./taxtronik backup-full
```

Beim 1-Klick-Weg prüft der Deploy zusätzlich beide öffentlichen HTTPS-Health-
Endpoints. Updates und Rollbacks verwenden danach automatisch denselben
Betriebsweg. `DEPLOYMENT_METHOD` ist kein beiläufiger Umschalter: Ein späterer
Wechsel zwischen vorhandenem Proxy und verwaltetem Traefik erfordert einen
kontrollierten Betriebswechsel einschließlich Port-, DNS-, Zertifikats- und
Containerprüfung.
