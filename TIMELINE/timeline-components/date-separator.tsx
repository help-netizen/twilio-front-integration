// Date Separator Component
// This component displays date bubbles between timeline items
// Import and use: <DateSeparator date="February 9, 2026" />

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