import { useState, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Eye, EyeOff, GripVertical } from 'lucide-react';
import type { TableColumn } from '../../types/lead';

interface ColumnSettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    columns: TableColumn[];
    onSave: (columns: TableColumn[]) => void;
}

interface DraggableColumnItemProps {
    column: TableColumn;
    index: number;
    onDragStart: (index: number) => void;
    onDragOver: (index: number) => void;
    onDragEnd: () => void;
    isDragging: boolean;
    toggleVisibility: (id: string) => void;
}

const DraggableColumnItem = ({ column, index, onDragStart, onDragOver, onDragEnd, isDragging, toggleVisibility }: DraggableColumnItemProps) => {
    return (
        <div
            draggable
            onDragStart={() => onDragStart(index)}
            onDragOver={(e) => { e.preventDefault(); onDragOver(index); }}
            onDragEnd={onDragEnd}
            className={`flex items-center gap-3 p-3 rounded-md border bg-background transition-opacity ${isDragging ? 'opacity-50' : 'opacity-100'
                } ${!column.visible ? 'bg-muted/50' : ''}`}
        >
            <div className="cursor-grab active:cursor-grabbing">
                <GripVertical className="size-5 text-muted-foreground" />
            </div>

            <span className={`flex-1 ${!column.visible ? 'text-muted-foreground' : ''}`}>
                {column.label}
            </span>

            <Button
                variant="ghost"
                size="sm"
                className="size-8 p-0"
                onClick={() => toggleVisibility(column.id)}
                disabled={column.locked}
            >
                {column.visible ? (
                    <Eye className="size-4" />
                ) : (
                    <EyeOff className="size-4 text-muted-foreground" />
                )}
            </Button>
        </div>
    );
};

export function ColumnSettingsDialog({ open, onOpenChange, columns, onSave }: ColumnSettingsDialogProps) {
    const [localColumns, setLocalColumns] = useState<TableColumn[]>([...columns]);
    const [dragIndex, setDragIndex] = useState<number | null>(null);

    const handleDragStart = useCallback((index: number) => {
        setDragIndex(index);
    }, []);

    const handleDragOver = useCallback((overIndex: number) => {
        if (dragIndex === null || dragIndex === overIndex) return;

        setLocalColumns(prev => {
            const updated = [...prev];
            const [removed] = updated.splice(dragIndex, 1);
            updated.splice(overIndex, 0, removed);
            return updated.map((col, idx) => ({ ...col, order: idx }));
        });
        setDragIndex(overIndex);
    }, [dragIndex]);

    const handleDragEnd = useCallback(() => {
        setDragIndex(null);
    }, []);

    const toggleVisibility = (id: string) => {
        const updated = localColumns.map(col =>
            col.id === id ? { ...col, visible: !col.visible } : col
        );

        // Sort: visible columns first, then hidden columns
        const visible = updated.filter(col => col.visible);
        const hidden = updated.filter(col => !col.visible);
        const sorted = [...visible, ...hidden].map((col, idx) => ({
            ...col,
            order: idx,
        }));

        setLocalColumns(sorted);
    };

    const handleSave = () => {
        onSave(localColumns);
        onOpenChange(false);
    };

    const handleReset = () => {
        const reset = localColumns.map(col => ({ ...col, visible: true }));
        setLocalColumns(reset);
    };

    const visibleCount = localColumns.filter(col => col.visible).length;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Column Settings</DialogTitle>
                    <DialogDescription>
                        Drag to reorder, click eye icon to show/hide columns
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-2 max-h-[400px] overflow-y-auto py-2">
                    {localColumns.map((column, index) => (
                        <DraggableColumnItem
                            key={column.id}
                            column={column}
                            index={index}
                            onDragStart={handleDragStart}
                            onDragOver={handleDragOver}
                            onDragEnd={handleDragEnd}
                            isDragging={dragIndex === index}
                            toggleVisibility={toggleVisibility}
                        />
                    ))}
                </div>

                <div className="text-sm text-muted-foreground">
                    {visibleCount} of {localColumns.length} columns visible
                </div>

                <DialogFooter className="flex justify-between sm:justify-between">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={handleReset}
                    >
                        Show All
                    </Button>
                    <div className="flex gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button onClick={handleSave}>
                            Save Changes
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
