// Welle 15 (Folgepunkt P-11): Serialisierung und Paketaufbau liegen in
// @taxtronik/db/dsgvo-contact-export, damit der Worker dsgvo-export dieselben
// Bytes erzeugt. Dieser Pfad bleibt für die Web-App erhalten.
export { serializeDsgvoExport } from '@taxtronik/db/dsgvo-contact-export';
