import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Eye, EyeOff, GripVertical } from 'lucide-react';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import type { TableColumn } from '../../types/table-settings';

interface ColumnSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columns: TableColumn[];
  onSave: (columns: TableColumn[]) => void;
}

interface DraggableColumnItemProps {
  column: TableColumn;
  index: number;
  moveColumn: (fromIndex: number, toIndex: number) => void;
  toggleVisibility: (id: string) => void;
}

const DraggableColumnItem = ({ column, index, moveColumn, toggleVisibility }: DraggableColumnItemProps) => {
  const [{ isDragging }, drag, preview] = useDrag({
    type: 'COLUMN',
    item: { index },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });

  const [, drop] = useDrop({
    accept: 'COLUMN',
    hover: (item: { index: number }) => {
      if (item.index !== index) {
        moveColumn(item.index, index);
        item.index = index;
      }
    },
  });

  return (
    <div
      ref={(node) => preview(drop(node))}
      className={`flex items-center gap-3 p-3 rounded-md border bg-background transition-opacity ${
        isDragging ? 'opacity-50' : 'opacity-100'
      } ${!column.visible ? 'bg-muted/50' : ''}`}
    >
      <div ref={drag} className="cursor-grab active:cursor-grabbing">
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

function ColumnSettingsContent({ columns, onSave, onOpenChange }: Omit<ColumnSettingsDialogProps, 'open'>) {
  const [localColumns, setLocalColumns] = useState<TableColumn[]>([...columns]);

  const moveColumn = (fromIndex: number, toIndex: number) => {
    const updated = [...localColumns];
    const [removed] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, removed);
    
    // Update order property
    const reordered = updated.map((col, idx) => ({
      ...col,
      order: idx,
    }));
    
    setLocalColumns(reordered);
  };

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
            moveColumn={moveColumn}
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
  );
}

export function ColumnSettingsDialog(props: ColumnSettingsDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DndProvider backend={HTML5Backend}>
        <ColumnSettingsContent {...props} />
      </DndProvider>
    </Dialog>
  );
}