import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Calendar } from '../ui/calendar';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../ui/command';
import { Badge } from '../ui/badge';
import { CalendarIcon, Search, Filter, X } from 'lucide-react';
import { format } from 'date-fns';
import { useState } from 'react';
import type { LeadsListParams } from '../../types/lead';
import { LEAD_STATUSES } from '../../types/lead';

interface LeadsFiltersProps {
  filters: LeadsListParams;
  searchQuery: string;
  onFiltersChange: (filters: Partial<LeadsListParams>) => void;
  onSearchChange: (query: string) => void;
}

export function LeadsFilters({ 
  filters, 
  searchQuery,
  onFiltersChange, 
  onSearchChange 
}: LeadsFiltersProps) {
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false);

  const startDate = filters.start_date ? new Date(filters.start_date) : undefined;

  const handleDateSelect = (date: Date | undefined) => {
    if (date) {
      onFiltersChange({ start_date: format(date, 'yyyy-MM-dd') });
      setDatePickerOpen(false);
    }
  };

  const handleDatePreset = (days: number) => {
    const date = new Date();
    date.setDate(date.getDate() - days);
    onFiltersChange({ start_date: format(date, 'yyyy-MM-dd') });
    setDatePickerOpen(false);
  };

  const toggleStatus = (status: string) => {
    const current = filters.status || [];
    const updated = current.includes(status)
      ? current.filter(s => s !== status)
      : [...current, status];
    onFiltersChange({ status: updated });
  };

  const clearStatusFilter = () => {
    onFiltersChange({ status: [] });
    setStatusPopoverOpen(false);
  };

  return (
    <div className="flex flex-wrap gap-3 items-center">
      {/* Search */}
      <div className="relative flex-1 min-w-[200px]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          placeholder="Search by name, phone, email, ID..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Date Range Picker */}
      <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="gap-2">
            <CalendarIcon className="size-4" />
            {startDate ? format(startDate, 'MMM dd, yyyy') : 'Start Date'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <div className="flex">
            <div className="border-r p-3 space-y-1">
              <div className="text-sm font-medium mb-2">Presets</div>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => handleDatePreset(0)}
              >
                Today
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => handleDatePreset(7)}
              >
                Last 7 days
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => handleDatePreset(30)}
              >
                Last 30 days
              </Button>
            </div>
            <Calendar
              mode="single"
              selected={startDate}
              onSelect={handleDateSelect}
              initialFocus
            />
          </div>
        </PopoverContent>
      </Popover>

      {/* Status Filter */}
      <Popover open={statusPopoverOpen} onOpenChange={setStatusPopoverOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="gap-2">
            <Filter className="size-4" />
            Status
            {filters.status && filters.status.length > 0 && (
              <Badge variant="secondary" className="ml-1 px-1.5 py-0">
                {filters.status.length}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[240px] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search status..." />
            <CommandList>
              <CommandEmpty>No status found.</CommandEmpty>
              <CommandGroup>
                {LEAD_STATUSES.map((status) => (
                  <CommandItem
                    key={status}
                    onSelect={() => toggleStatus(status)}
                  >
                    <div className="flex items-center gap-2 w-full">
                      <div className={`size-4 border rounded flex items-center justify-center ${
                        filters.status?.includes(status) ? 'bg-primary border-primary' : 'border-input'
                      }`}>
                        {filters.status?.includes(status) && (
                          <div className="size-2 bg-primary-foreground rounded-sm" />
                        )}
                      </div>
                      <span>{status}</span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
            {filters.status && filters.status.length > 0 && (
              <div className="border-t p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={clearStatusFilter}
                >
                  <X className="size-4 mr-2" />
                  Clear filters
                </Button>
              </div>
            )}
          </Command>
        </PopoverContent>
      </Popover>

      {/* Only Open Toggle */}
      <div className="flex items-center gap-2 px-3 py-2 border rounded-md">
        <Switch
          id="only-open"
          checked={filters.only_open}
          onCheckedChange={(checked) => onFiltersChange({ only_open: checked })}
        />
        <Label htmlFor="only-open" className="cursor-pointer">
          Only Open
        </Label>
      </div>
    </div>
  );
}
