// Date Separator — per TIMELINE_TECHNICAL_SPECIFICATION.md
// bg-gray-200 text-gray-600 px-4 py-1.5 rounded-full text-xs font-medium shadow-sm

interface DateSeparatorProps {
    date: string;
}

export function DateSeparator({ date }: DateSeparatorProps) {
    return (
        <div className="flex items-center justify-center my-6">
            <div className="bg-gray-200 text-gray-600 px-4 py-1.5 rounded-full text-xs font-medium shadow-sm">
                {date}
            </div>
        </div>
    );
}
