import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';

/** ORDER-LIST-001 — internal parts to order (never shown to the customer). */
export interface OrderRow {
    key: string;
    part_number: string;
    part_name: string;
    quantity: string;
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function makeOrderRow(part_number = '', part_name = '', quantity = '1'): OrderRow {
    return { key: newKey(), part_number, part_name, quantity };
}

/** Map editor rows → the API shape, dropping incomplete rows. */
export function serializeOrderList(rows: OrderRow[]): Array<{ part_number: string; part_name: string; quantity: number }> {
    return rows
        .filter(r => r.part_number.trim() && r.part_name.trim() && Number(r.quantity) > 0)
        .map(r => ({ part_number: r.part_number.trim(), part_name: r.part_name.trim(), quantity: Number(r.quantity) || 1 }));
}

const inputCls =
    'h-9 w-full rounded-lg border-[1.5px] border-[var(--blanc-line)] bg-transparent px-3 text-sm outline-none transition-colors focus:border-[var(--blanc-ink-2)] disabled:opacity-60';

interface Props {
    value: OrderRow[];
    onChange: (next: OrderRow[]) => void;
    disabled?: boolean;
}

export function OrderListSection({ value, onChange, disabled }: Props) {
    const update = (key: string, patch: Partial<OrderRow>) =>
        onChange(value.map(r => (r.key === key ? { ...r, ...patch } : r)));
    const remove = (key: string) => onChange(value.filter(r => r.key !== key));
    const add = () => onChange([...value, makeOrderRow()]);

    return (
        <section className="space-y-3">
            <div>
                <p className="blanc-eyebrow">Order List</p>
                <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                    Parts to order after approval · Only your team can see this — never on the customer's copy.
                </p>
            </div>

            {value.length > 0 && (
                <div className="space-y-2">
                    {value.map(row => (
                        <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_72px_auto] items-center gap-2">
                            <input
                                className={inputCls}
                                style={{ color: 'var(--blanc-ink-1)' }}
                                placeholder="Part #"
                                value={row.part_number}
                                disabled={disabled}
                                onChange={e => update(row.key, { part_number: e.target.value })}
                            />
                            <input
                                className={inputCls}
                                style={{ color: 'var(--blanc-ink-1)' }}
                                placeholder="Part name"
                                value={row.part_name}
                                disabled={disabled}
                                onChange={e => update(row.key, { part_name: e.target.value })}
                            />
                            <input
                                className={`${inputCls} text-right tabular-nums`}
                                style={{ color: 'var(--blanc-ink-1)' }}
                                placeholder="Qty"
                                inputMode="numeric"
                                value={row.quantity}
                                disabled={disabled}
                                onChange={e => update(row.key, { quantity: e.target.value })}
                            />
                            <button
                                type="button"
                                onClick={() => remove(row.key)}
                                disabled={disabled}
                                aria-label="Remove part"
                                className="flex size-9 items-center justify-center rounded-lg transition-colors hover:bg-[rgba(25,25,25,0.05)]"
                                style={{ color: 'var(--blanc-ink-3)' }}
                            >
                                <Trash2 className="size-4" />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <Button type="button" variant="outline" size="sm" onClick={add} disabled={disabled}>
                <Plus className="mr-1 size-4" /> Add part
            </Button>
        </section>
    );
}
