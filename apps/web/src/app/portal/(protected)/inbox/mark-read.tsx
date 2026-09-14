'use client';

import { useEffect } from 'react';
import { markInboxThreadReadAction } from './actions';

export function MarkInboxThreadRead({
  threadId,
  lastMessageAt,
}: {
  threadId: string;
  lastMessageAt: string;
}) {
  useEffect(() => {
    const form = new FormData();
    form.set('id', threadId);
    form.set('lastMessageAt', lastMessageAt);
    void markInboxThreadReadAction(form);
  }, [threadId, lastMessageAt]);
  return null;
}
