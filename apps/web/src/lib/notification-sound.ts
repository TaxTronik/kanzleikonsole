// =============================================================================
// Benachrichtigungssound — per Web Audio API synthetisierter kurzer Chime.
//
// Bewusst KEIN Audio-Asset (mp3/wav): vermeidet Lade-/Caching-Probleme, keine
// Binärdatei im Repo, und der Klang ist ggf. leicht anpassbar. Die Pref liegt
// in localStorage ('notif-sound' === '0' = aus) — analog zum Theme-Toggle.
//
// Hinweis Autoplay-Policy: ein AudioContext darf i. d. R. erst nach einer
// Nutzerinteraktion mit der Seite starten. Die ersten Polls vor der ersten
// Interaktion bleiben daher still (catch — kein Fehler); danach läuft der Ton.
// =============================================================================

const PREF_KEY = 'notif-sound';

export function isNotificationSoundEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== '0';
  } catch {
    return false; // localStorage nicht verfügbar (z. B. Inkognito) → kein Ton
  }
}

export function setNotificationSoundEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, '0');
  } catch {
    // ignore
  }
}

let sharedCtx: AudioContext | null = null;

/** Deziderer dreistimmiger Aufwärts-Chime (C5 → E5 → G5). Failt still. */
export function playNotificationSound(): void {
  if (typeof window === 'undefined') return;
  if (!isNotificationSoundEnabled()) return;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!sharedCtx) sharedCtx = new Ctor();
    const ctx = sharedCtx;
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    master.connect(ctx.destination);
    for (let i = 0; i < notes.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = notes[i]!;
      const start = now + i * 0.12;
      osc.connect(master);
      osc.start(start);
      osc.stop(start + 0.18);
    }
  } catch {
    // Audio nicht abspielbar (z. B. Autoplay-Sperre) — still ignorieren.
  }
}
