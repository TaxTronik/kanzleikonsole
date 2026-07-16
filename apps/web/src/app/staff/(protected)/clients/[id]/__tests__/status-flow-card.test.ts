import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const clientRoot = resolve(__dirname, '..');
const read = (relativePath: string) => readFileSync(resolve(clientRoot, relativePath), 'utf8');
const shared = read('status-flow-card.tsx');
const binders = read('binders/binders-block.tsx');
const handovers = read('handovers/handovers-block.tsx');

describe('client status flow card consolidation', () => {
  it('owns the shared shell and mutation transition lifecycle once', () => {
    expect(shared).toContain('export function ClientStatusFlowCard');
    expect(shared).toContain('const [isMutating, startMutation] = useTransition()');
    expect(shared).toContain('await updateStatus(item.id, next)');
    expect(shared).toContain('await deleteItem(item.id)');
    expect(shared).toContain('router.refresh()');

    for (const domainBlock of [binders, handovers]) {
      expect(domainBlock).toContain('<ClientStatusFlowCard');
      expect(domainBlock).not.toContain('useRouter');
      expect(domainBlock).not.toContain('useTransition');
      expect(domainBlock).not.toContain('<Trash2');
      expect(domainBlock).not.toContain('<ArrowRight');
    }
  });

  it('keeps domain-specific confirmations and copy in their adapters', () => {
    expect(binders).toContain("confirm('Pendelordner löschen?')");
    expect(binders).toContain('Keine aktiven Pendelordner.');
    expect(binders).toContain('überfällig');
    expect(binders).toContain('Erwartete Rückgabe');

    expect(handovers).toContain("confirm('Anlieferung löschen?')");
    expect(handovers).toContain('Der Mandant wird per E-Mail informiert.');
    expect(handovers).toContain('Keine offenen Anlieferungen.');
    expect(handovers).toContain('notifiedContactEmail');
  });
});
