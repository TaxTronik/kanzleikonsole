# Zusätzliche TSA-Trust-Anchors

Dieses Verzeichnis wird im App- und Worker-Container read-only unter
`/etc/taxtronik/tsa-roots` eingebunden. Für einen anderen als den eingebauten
GlobalSign-R6-Anker:

1. den Betreiber-Root unabhängig vom TSA-Endpunkt prüfen,
2. als PEM-Datei in diesem Verzeichnis ablegen und nur für den Betreiber lesbar
   machen,
3. `TSA_TRUSTED_ROOTS_FILE=/etc/taxtronik/tsa-roots/<datei>.pem` setzen.

Das Verzeichnis kann über `TSA_TRUSTED_ROOTS_HOST_DIR` durch einen absoluten
Host-Pfad ersetzt werden. Private Schlüssel gehören nicht hierher.
