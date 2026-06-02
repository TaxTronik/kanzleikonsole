// =============================================================================
// EINE Quelle für das Tiptap-Extension-/Schema-Set aller Sachverhalt-Editoren
// (Compose + Review). Damit rendert ein in einem Modus erzeugtes Dokument im
// anderen bauartbedingt 1:1 — kein Schema-Drift, wenn StarterKit später
// konfiguriert/erweitert wird. Der Review ergänzt nur die (schema-neutralen)
// Markierungs-Decorations obendrauf.
// =============================================================================

import StarterKit from '@tiptap/starter-kit';

export const baseEditorExtensions = [StarterKit];
