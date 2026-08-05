// =============================================================================
// Re-Export aus @taxtronik/db (Muster M-7, secret-box.ts).
//
// Vorher: eigener Owner-Client hier — seit @taxtronik/mail den Paket-Client
// aus @taxtronik/db nutzt, hätte der Worker-Prozess sonst ZWEI Owner-
// Connection-Pools. Jetzt eine Quelle für alle Jobs und den Mail-Versand.
// =============================================================================

export { prismaOwner } from '@taxtronik/db';
