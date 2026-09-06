export type StaffAuthMethod = 'totp' | 'backup_code' | 'dev_skip_totp' | 'security_key';

/**
 * Verknüpft ein signiertes JWT mit dem aktuellen Faktorstand in der DB.
 * Damit werden nicht nur explizite Revocations, sondern auch ein Modus- oder
 * Faktorwechsel sofort wirksam. Legacy-Tokens sind ausschließlich für noch
 * unveränderte Passwort+TOTP-Konten zugelassen.
 */
export function staffTokenMatchesCurrentAuthState(
  token: { authMethod?: StaffAuthMethod; authRevision?: number },
  account: { authRevision: number; hardwareOnlyEnabledAt: Date | null },
): boolean {
  if (token.authRevision === undefined) {
    if (account.authRevision !== 0 || account.hardwareOnlyEnabledAt) return false;
  } else if (token.authRevision !== account.authRevision) {
    return false;
  }
  const tokenUsesHardware = token.authMethod === 'security_key';
  return account.hardwareOnlyEnabledAt ? tokenUsesHardware : !tokenUsesHardware;
}
