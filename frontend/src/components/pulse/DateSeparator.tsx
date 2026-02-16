// Date Separator Component
// Pill-shaped date bubble between timeline groups

interface DateSeparatorProps {
    date: string;
}

export function DateSeparator({ date }: DateSeparatorProps) {
    return (
        <div className="flex items-center justify-center my-6">
            <div
                style={{
                    backgroundColor: '#f3f4f6',
                    color: '#6b7280',
                    padding: '6px 16px',
                    borderRadius: '9999px',
                    fontSize: '12px',
                    fontWeight: 500,
                    boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                }}
            >
                {date}
            </div>
        </div>
    );
}
