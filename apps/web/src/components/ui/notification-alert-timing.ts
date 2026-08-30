/** Optional reading aid: no deadline while the personal display mode is active. */
export function scheduleNotificationAlertDismiss({
  persistent,
  interacting,
  dismiss,
}: {
  persistent: boolean;
  interacting: boolean;
  dismiss: () => void;
}): () => void {
  if (persistent || interacting) return () => {};
  const timer = setTimeout(dismiss, 8000);
  return () => clearTimeout(timer);
}
