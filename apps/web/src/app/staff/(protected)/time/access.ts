/** Query fragments shared by every read on the time page. */
export function buildTimePageAccessFilters(deniedClientIds: string[]) {
  return {
    timeEntryWhere: deniedClientIds.length
      ? { OR: [{ clientId: null }, { clientId: { notIn: deniedClientIds } }] }
      : {},
    clientWhere: deniedClientIds.length ? { id: { notIn: deniedClientIds } } : undefined,
  };
}
