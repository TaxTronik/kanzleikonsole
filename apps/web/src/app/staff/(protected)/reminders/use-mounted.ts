'use client';

import { useEffect, useRef } from 'react';

/** Ein abgeschlossener Auftrag darf nach dem Seitenwechsel keine Navigation mehr auslösen. */
export function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
