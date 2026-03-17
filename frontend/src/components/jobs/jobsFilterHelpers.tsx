import { Check } from 'lucide-react';

export const BLANC_STATUSES = ['Submitted', 'Waiting for parts', 'Follow Up with Client', 'Visit completed', 'Job is Done', 'Rescheduled', 'Canceled'];

export function FilterColumn({ title, items, selected, onToggle }: { title: string; items: string[]; selected: string[]; onToggle: (item: string) => void }) {
    return (
        <div className="px-3 space-y-1">
            <div className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase mb-2">{title}</div>
            <div className="space-y-0.5 max-h-[240px] overflow-y-auto">
                {items.length === 0 && <div className="text-xs text-muted-foreground italic py-1">None available</div>}
                {items.map(item => {
                    const isSelected = selected.includes(item);
                    return (
                        <button key={item} type="button" onClick={() => onToggle(item)} className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors ${isSelected ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted text-foreground'}`}>
                            <div className={`size-4 border rounded flex items-center justify-center shrink-0 ${isSelected ? 'bg-primary border-primary' : 'border-input'}`}>{isSelected && <Check className="size-3 text-primary-foreground" />}</div>
                            {item}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
