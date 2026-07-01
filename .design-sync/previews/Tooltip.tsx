import {
  Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, Button, Badge,
} from 'albusto-ui';

// Open in-card: the tooltip content renders statically so its styling is visible.
export const OnProvider = () => (
  <div style={{ minHeight: 96, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
    <TooltipProvider>
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <Button variant="outline">Marcus Bell</Button>
        </TooltipTrigger>
        <TooltipContent>Boston team · 4 jobs today</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
);

// Icon-triggered hint — the common "explain this status" affordance, open in-card.
export const StatusHint = () => (
  <div style={{ minHeight: 96, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
    <TooltipProvider>
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <Badge variant="secondary">Scheduled</Badge>
        </TooltipTrigger>
        <TooltipContent>Tomorrow, 9:00–11:00 AM</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
);

// Closed trigger only — a stable fallback that never renders blank.
export const Trigger = () => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
          Details
        </Button>
      </TooltipTrigger>
      <TooltipContent>View job details</TooltipContent>
    </Tooltip>
  </TooltipProvider>
);
