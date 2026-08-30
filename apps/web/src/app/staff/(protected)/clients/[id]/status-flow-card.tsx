'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, Plus, Trash2, type LucideIcon } from 'lucide-react';

export interface ClientStatusFlowItem<Status extends string> {
  id: string;
  label: string;
  contents: string | null;
  status: Status;
}

export interface ClientStatusFlowDefinition<Status extends string> {
  terminalStatus: Status;
  labels: Record<Status, string>;
  badgeClasses: Record<Status, string>;
  next: Record<Status, Status | null>;
  transitionLabels: Record<Status, string>;
}

interface ClientStatusFlowCardProps<
  Status extends string,
  Item extends ClientStatusFlowItem<Status>,
> {
  title: string;
  icon: LucideIcon;
  items: Item[];
  flow: ClientStatusFlowDefinition<Status>;
  emptyText: string;
  renderCreateForm: (close: () => void) => ReactNode;
  renderMeta: (item: Item) => ReactNode;
  renderStatusAdornment?: (item: Item) => ReactNode;
  renderCompletedMeta: (item: Item) => ReactNode;
  completedSummary: (count: number) => ReactNode;
  transitionTitle?: (item: Item, next: Status, label: string) => string;
  confirmTransition?: (item: Item, next: Status) => boolean | Promise<boolean>;
  confirmDelete: (item: Item) => boolean | Promise<boolean>;
  updateStatus: (id: string, next: Status) => Promise<unknown>;
  deleteItem: (id: string) => Promise<unknown>;
}

/** Shared shell for the small, linear client status lists on the cockpit. */
export function ClientStatusFlowCard<
  Status extends string,
  Item extends ClientStatusFlowItem<Status>,
>({
  title,
  icon: Icon,
  items,
  flow,
  emptyText,
  renderCreateForm,
  renderMeta,
  renderStatusAdornment,
  renderCompletedMeta,
  completedSummary,
  transitionTitle,
  confirmTransition,
  confirmDelete,
  updateStatus,
  deleteItem,
}: ClientStatusFlowCardProps<Status, Item>) {
  const router = useRouter();
  const [isMutating, startMutation] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const active = items.filter((item) => item.status !== flow.terminalStatus);
  const completed = items.filter((item) => item.status === flow.terminalStatus);

  async function advance(item: Item, next: Status) {
    if (confirmTransition && !(await confirmTransition(item, next))) return;
    startMutation(async () => {
      await updateStatus(item.id, next);
      router.refresh();
    });
  }

  async function remove(item: Item) {
    if (!(await confirmDelete(item))) return;
    startMutation(async () => {
      await deleteItem(item.id);
      router.refresh();
    });
  }

  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <h2 className="text-sm font-medium text-primary inline-flex items-center gap-2">
          <Icon className="h-4 w-4 text-disabled" />
          {title} ({active.length})
        </h2>
        <button
          type="button"
          onClick={() => setCreateOpen((open) => !open)}
          className="btn-secondary text-xs inline-flex items-center gap-1"
        >
          <Plus className="h-3 w-3" />
          Neu
        </button>
      </div>

      {createOpen && renderCreateForm(() => setCreateOpen(false))}

      {active.length === 0 ? (
        <p className="px-6 py-6 text-sm text-disabled text-center">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {active.map((item) => {
            const next = flow.next[item.status];
            const nextLabel = flow.transitionLabels[item.status];
            return (
              <li key={item.id} className="px-6 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-primary inline-flex items-center gap-2">
                      {item.label}
                      <span className={`${flow.badgeClasses[item.status]} text-[10px]`}>
                        {flow.labels[item.status]}
                      </span>
                      {renderStatusAdornment?.(item)}
                    </p>
                    {item.contents && (
                      <p className="text-xs text-secondary mt-1 whitespace-pre-wrap">
                        {item.contents}
                      </p>
                    )}
                    {renderMeta(item)}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {next && (
                      <button
                        type="button"
                        onClick={() => advance(item, next)}
                        disabled={isMutating}
                        className="btn-secondary text-[11px] py-1 inline-flex items-center gap-1"
                        title={transitionTitle?.(item, next, nextLabel) ?? nextLabel}
                      >
                        {next === flow.terminalStatus ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <ArrowRight className="h-3 w-3" />
                        )}
                        {nextLabel}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(item)}
                      disabled={isMutating}
                      className="text-disabled hover:text-red-700 p-1"
                      title="Löschen"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {completed.length > 0 && (
        <details className="border-t border-default">
          <summary className="px-6 py-2 text-xs text-muted cursor-pointer">
            {completedSummary(completed.length)}
          </summary>
          <ul className="divide-y divide-border-subtle">
            {completed.map((item) => (
              <li key={item.id} className="px-6 py-2 text-sm text-muted flex justify-between gap-2">
                <span className="truncate">{item.label}</span>
                {renderCompletedMeta(item)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
