import type { BrandingInfo } from '@/server/settings/branding';

/**
 * Rendert das Tenant-Logo mit Dark-Mode-Unterstützung.
 *
 * Liegt eine Dark-Variante (logoDataUrlDark) vor, wird per Tailwind-dark-Variante
 * passend zum Theme geschaltet (`.dark`-Klasse am <html>-Element). Ohne Dark-
 * Variante gilt das hell-Logo in beiden Themes (Status quo). Gibt null zurück,
 * wenn gar kein Logo hinterlegt ist — der Aufrufer zeigt dann den Text-Fallback.
 */
export function TenantLogo({
  branding,
  alt,
  className,
}: {
  branding: Pick<BrandingInfo, 'logoDataUrl' | 'logoDataUrlDark'>;
  alt: string;
  className?: string;
}) {
  const light = branding.logoDataUrl;
  const dark = branding.logoDataUrlDark;
  if (!light && !dark) return null;
  if (light && dark) {
    return (
      <>
        <img src={light} alt={alt} className={`${className ?? ''} dark:hidden`} />
        <img src={dark} alt={alt} className={`${className ?? ''} hidden dark:block`} />
      </>
    );
  }
  return <img src={(light ?? dark) as string} alt={alt} className={className} />;
}
