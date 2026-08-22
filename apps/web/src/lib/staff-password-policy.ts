export const STAFF_PASSWORD_MIN_LENGTH = 12;
export const STAFF_PASSWORD_MAX_LENGTH = 200;

export function validateStaffPasswordPair(password: string, confirmation: string): string | null {
  if (password.length < STAFF_PASSWORD_MIN_LENGTH) {
    return `Das Passwort muss mindestens ${STAFF_PASSWORD_MIN_LENGTH} Zeichen lang sein.`;
  }
  if (password.length > STAFF_PASSWORD_MAX_LENGTH) {
    return `Das Passwort darf höchstens ${STAFF_PASSWORD_MAX_LENGTH} Zeichen lang sein.`;
  }
  if (password !== confirmation) return 'Die Passwörter stimmen nicht überein.';
  return null;
}
