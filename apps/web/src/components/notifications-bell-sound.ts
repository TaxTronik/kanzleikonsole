'use client';
// =============================================================================
// Ton der Benachrichtigungsglocke (Review-Befund K-04): Die Einstellung liegt
// in localStorage (lib/notification-sound.ts) und gilt für alle Glocken des
// Browsers; Änderungen in anderen Tabs (storage) und in diesem Tab (eigenes
// Ereignis) werden übernommen. Gespielt wird bei einem angekündigten Zuwachs
// (notifications-bell-feed.ts) und einmal zur Probe beim Einschalten — die
// stummgeschaltete Einstellung prüft playNotificationSound selbst.
// =============================================================================

import { useSyncExternalStore } from 'react';
import {
  isNotificationSoundEnabled,
  playNotificationSound,
  setNotificationSoundEnabled,
} from '@/lib/notification-sound';

export const SOUND_EVENT = 'taxtronik:notification-sound';

export function subscribeSoundPreference(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(SOUND_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(SOUND_EVENT, onChange);
  };
}

export function useNotificationSound() {
  // Serverseitig gilt der Ton als an (Voreinstellung); der Client liest die Einstellung.
  const soundOn = useSyncExternalStore(
    subscribeSoundPreference,
    isNotificationSoundEnabled,
    () => true,
  );
  function toggleSound() {
    const next = !soundOn;
    setNotificationSoundEnabled(next);
    window.dispatchEvent(new Event(SOUND_EVENT));
    // Beim Aktivieren einmal probe-Play (gibt Nutzer:in direktes Feedback +
    // löst ggf. die Autoplay-Sperre durch die Nutzerinteraktion).
    if (next) playNotificationSound();
  }
  return { soundOn, toggleSound };
}
