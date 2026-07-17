
export const BLANC_STATUSES = ['Submitted', 'Waiting for parts', 'Follow Up with Client', 'Visit completed', 'Job is Done', 'Rescheduled', 'Canceled'];

export const BLANC_STATUS_COLORS: Record<string, string> = {
    'Submitted':            '#3B82F6',
    'Waiting for parts':    '#F59E0B',
    'Follow Up with Client':'#8B5CF6',
    'Visit completed':      '#22C55E',
    'Job is Done':          '#6B7280',
    'Rescheduled':          '#F97316',
    'Canceled':             '#EF4444',
};

export function FilterColumn({
    title, items, selected, onToggle, colorMap,
}: {
    title: string;
    items: string[];
    selected: string[];
    onToggle: (item: string) => void;
    colorMap?: Record<string, string>;
}) {
    return (
        <div className="px-3 space-y-1 min-w-0">
            <div className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase mb-2 whitespace-nowrap">{title}</div>
            <div className="space-y-0.5 max-h-[240px] overflow-y-auto">
                {items.length === 0 && <div className="text-xs text-muted-foreground italic py-1">None available</div>}
                {items.map(item => {
                    const isSelected = selected.includes(item);
                    const dotColor = colorMap?.[item];
                    return (
                        <button key={item} type="button" onClick={() => onToggle(item)}
                            className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors ${isSelected ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted text-foreground'}`}>
                            {dotColor && (
                                <span className="shrink-0 rounded-full" style={{ width: 10, height: 10, background: dotColor, opacity: isSelected ? 1 : 0.55, flexShrink: 0 }} />
                            )}
                            <span className="truncate">{item}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
