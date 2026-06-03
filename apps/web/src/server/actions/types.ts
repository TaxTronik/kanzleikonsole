// Neutraler, IO-freier gemeinsamer Typ für Staff- UND Portal-Actions (vorher 81×
// lokal redefiniert). Hier, damit weder staff-action noch portal-action sich
// gegenseitig (und ihre jeweilige Auth.js-Kette) ziehen müssen.

export interface ActionResult {
  ok: boolean;
  error?: string;
}
