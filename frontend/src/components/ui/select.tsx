"use client";

/**
 * Select — Radix select on desktop, canonical mobile BottomSheet on mobile
 * (OVERLAY-CANON-002, Phase 2b). THE hardest of the three (value-bound).
 *
 * Public compound API UNCHANGED — call sites keep writing
 *   <Select value onValueChange>
 *     <SelectTrigger><SelectValue placeholder?/></SelectTrigger>
 *     <SelectContent>
 *       <SelectLabel>…</SelectLabel>
 *       <SelectItem value="x">Label</SelectItem>
 *       <SelectSeparator/>
 *     </SelectContent>
 *   </Select>
 * and nothing else changes for them.
 *
 * Mechanism (context-based responsive wrapper):
 *   • ROOT (`Select`) reads `value` / `defaultValue` / `onValueChange`, owns a CONTROLLED
 *     *sheet-open* state, and publishes context `{ value, onValueChange, open, setOpen,
 *     isMobile, sheetTitle }`. It renders `SelectPrimitive.Root` controlled on value
 *     (so desktop behavior is unchanged) — but the Radix *open* is left to Radix on
 *     desktop; on mobile the Radix listbox is never opened (our sheet is), so we pin the
 *     Radix `open={false}` on mobile to keep the native popup from ever mounting.
 *   • DESKTOP is BYTE-IDENTICAL: SelectTrigger/Value/Content/Item render the exact Radix
 *     markup from before.
 *   • MOBILE:
 *       – `SelectTrigger` renders a styled <button> (SAME classes) that opens the sheet.
 *       – `SelectValue` shows the CURRENT selection's LABEL, mapped value→label from the
 *         matching `SelectItem`'s children (or the `placeholder` when nothing is chosen).
 *       – `SelectContent` renders a <BottomSheet> listing the options.
 *       – each `SelectItem` row calls `onValueChange(value)` + closes, with a check on the
 *         selected one. `SelectLabel`/`SelectSeparator` render as sheet section/divider.
 *
 * value→label for the trigger: `SelectValue` (mobile) walks the option registry the Root
 * built by recursively scanning `SelectContent`'s children for `SelectItem`s (they may be
 * nested in `.map()` arrays / fragments / `SelectGroup`s) → `{ value → label node }`.
 *
 * A new OPTIONAL `sheetTitle` on the ROOT titles the mobile sheet; defaults to none.
 */

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useIsMobile } from "../../hooks/useIsMobile";
import { BottomSheet } from "./BottomSheet";

interface SelectCtx {
  value?: string;
  onValueChange?: (value: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  isMobile: boolean;
  sheetTitle?: string;
  /** value → label node for the current option set (mobile trigger display). */
  labelFor: (value: string) => React.ReactNode | undefined;
}

const SelectContext = React.createContext<SelectCtx | null>(null);

/** Marker so the mobile value→label walk can find each option among arbitrary children. */
const SELECT_ITEM_MARKER = Symbol.for("albusto.select-item");

/**
 * Recursively walk arbitrary children collecting each SelectItem's { value → label }.
 * Items may sit inside `.map()` arrays, fragments, SelectGroups, or a SelectContent, so
 * we recurse through every element's children until we hit the tagged SelectItems.
 */
function collectOptionLabels(
  node: React.ReactNode,
  out: Map<string, React.ReactNode>,
): void {
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement(child)) return;
    const type = child.type as { [SELECT_ITEM_MARKER]?: boolean } | undefined;
    const childProps = child.props as { value?: string; children?: React.ReactNode };
    if (type && type[SELECT_ITEM_MARKER] && typeof childProps.value === "string") {
      out.set(childProps.value, childProps.children);
      return;
    }
    if (childProps && childProps.children != null) {
      collectOptionLabels(childProps.children, out);
    }
  });
}

type SelectRootProps = React.ComponentProps<typeof SelectPrimitive.Root> & {
  /** OPTIONAL — title shown on the mobile BottomSheet header. Default: none (headerless). */
  sheetTitle?: string;
};

function Select({
  value: valueProp,
  defaultValue,
  onValueChange,
  sheetTitle,
  children,
  ...props
}: SelectRootProps) {
  const isMobile = useIsMobile();

  // Value: controlled if `value` given, else self-managed (seeded by defaultValue).
  const isControlled = valueProp !== undefined;
  const [uncontrolledValue, setUncontrolledValue] = React.useState<string | undefined>(
    defaultValue,
  );
  const value = isControlled ? valueProp : uncontrolledValue;

  const handleValueChange = React.useCallback(
    (next: string) => {
      if (!isControlled) setUncontrolledValue(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  // Sheet-open state (mobile only; on desktop Radix owns its own popup open).
  const [open, setOpen] = React.useState(false);

  // value → label map for the mobile trigger. Built ONLY on mobile (desktop uses Radix's
  // own ItemText, so this stays a strict no-op there). Recomputes when children change.
  const labelFor = React.useMemo(() => {
    if (!isMobile) return () => undefined;
    const map = new Map<string, React.ReactNode>();
    collectOptionLabels(children, map);
    return (v: string) => map.get(v);
  }, [isMobile, children]);

  const ctx = React.useMemo<SelectCtx>(
    () => ({ value, onValueChange: handleValueChange, open, setOpen, isMobile, sheetTitle, labelFor }),
    [value, handleValueChange, open, isMobile, sheetTitle, labelFor],
  );

  // DESKTOP: forward value/defaultValue/onValueChange EXACTLY as the call site gave them,
  // so Radix sees the identical props it saw before this wrapper existed (controlled OR
  // uncontrolled — byte-identical, and uncontrolled selection still sticks).
  // MOBILE: drive Radix controlled by our mirrored value and pin open={false} — the native
  // listbox never mounts (our BottomSheet is the picker), but the Root stays mounted so the
  // trigger keeps its aria wiring.
  const radixValueProps = isMobile
    ? { value, onValueChange: handleValueChange, open: false as const }
    : { value: valueProp, defaultValue, onValueChange };

  return (
    <SelectContext.Provider value={ctx}>
      <SelectPrimitive.Root data-slot="select" {...radixValueProps} {...props}>
        {children}
      </SelectPrimitive.Root>
    </SelectContext.Provider>
  );
}

function SelectGroup({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({
  placeholder,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  const ctx = React.useContext(SelectContext);

  // Mobile: render the mapped label ourselves (Radix Value can't read labels when the
  // items live in the sheet and were never mounted in a Radix Viewport).
  if (ctx?.isMobile) {
    // Honor an explicit trigger-display override (call sites pass custom SelectValue
    // children, e.g. an icon + name) — same as Radix does on desktop, where children
    // replace the auto value text.
    const childrenOverride = (props as { children?: React.ReactNode }).children;
    if (childrenOverride != null) {
      return <span data-slot="select-value">{childrenOverride}</span>;
    }
    const label = ctx.value != null && ctx.value !== "" ? ctx.labelFor(ctx.value) : undefined;
    const show = label ?? placeholder ?? null;
    const isPlaceholder = label == null;
    return (
      <span
        data-slot="select-value"
        {...(isPlaceholder ? { "data-placeholder": "" } : {})}
      >
        {show}
      </span>
    );
  }

  return <SelectPrimitive.Value data-slot="select-value" placeholder={placeholder} {...props} />;
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default";
}) {
  const ctx = React.useContext(SelectContext);

  const triggerClass = cn(
    "border-transparent data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex w-full items-center justify-between gap-2 rounded-[10px] border-[1.5px] bg-[var(--blanc-field,#F0F0F0)] px-3 py-2 text-sm font-medium whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    className,
  );

  // Mobile: a styled <button> (SAME classes) that opens the sheet. When empty, mark
  // data-placeholder so the muted-foreground rule fires like Radix's own trigger.
  if (ctx?.isMobile) {
    const isPlaceholder = ctx.value == null || ctx.value === "";
    const { disabled, id, ...rest } = props as React.ComponentProps<"button"> & { id?: string };
    return (
      <button
        type="button"
        id={id}
        data-slot="select-trigger"
        data-size={size}
        {...(isPlaceholder ? { "data-placeholder": "" } : {})}
        disabled={disabled}
        onClick={() => ctx.setOpen(true)}
        className={triggerClass}
        {...(rest as React.ComponentProps<"button">)}
      >
        {children}
        <ChevronDownIcon className="size-4 opacity-50" />
      </button>
    );
  }

  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={triggerClass}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  const ctx = React.useContext(SelectContext);

  // Mobile → canonical BottomSheet listing the options (SelectItems become rows).
  if (ctx?.isMobile) {
    // A long list (e.g. the 51-state select) needs a FIXED-height sheet so the sheet's
    // own body is a real scroll container — the reliable iOS pattern every other mobile
    // sheet uses. size="auto" (content-height) does NOT create a scrollable body on iOS
    // Safari for a nested list, so the list wouldn't scroll and the touch fell through to
    // the form behind. Short lists keep the compact content-height sheet.
    const itemCount = React.Children.toArray(children).length;
    const size = itemCount > 8 ? 'full' : 'auto';
    return (
      <BottomSheet
        open={ctx.open}
        onClose={() => ctx.setOpen(false)}
        title={ctx.sheetTitle}
        size={size}
      >
        {/* Plain list — the BottomSheet body owns the scroll (flex-1 + min-height:0 +
            overflow-y:auto in a fixed-height panel = reliable internal scroll). */}
        <div className="flex flex-col gap-0.5 py-1" role="listbox">
          {children}
        </div>
      </BottomSheet>
    );
  }

  // Desktop → ORIGINAL Radix popper content (byte-identical).
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          // z-[150] === OVERLAY_Z.dropdown (overlayLayout.ts) — ABOVE modal(140) by design
          // so a Select opened inside a Dialog pops above it. Literal class for the JIT.
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-[150] max-h-96 min-w-[8rem] overflow-hidden rounded-md border shadow-md",
          position === "popper" &&
          "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className,
        )}
        position={position}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            "p-1",
            position === "popper" &&
            "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  const ctx = React.useContext(SelectContext);

  if (ctx?.isMobile) {
    return (
      <div
        data-slot="select-label"
        className={cn(
          "px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground",
          className,
        )}
      >
        {children}
      </div>
    );
  }

  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("text-muted-foreground px-2 py-1.5 text-xs", className)}
      {...props}
    >
      {children}
    </SelectPrimitive.Label>
  );
}

function SelectItem({
  className,
  children,
  value,
  disabled,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  const ctx = React.useContext(SelectContext);

  // Mobile → tappable sheet row: pick the value + close, with a check on the selected one.
  if (ctx?.isMobile) {
    const selected = ctx.value === value;
    return (
      <button
        type="button"
        role="option"
        aria-selected={selected}
        disabled={disabled}
        data-slot="select-item"
        onClick={() => {
          if (disabled) return;
          ctx.onValueChange?.(value);
          ctx.setOpen(false);
        }}
        className={cn(
          "relative flex w-full shrink-0 cursor-pointer select-none items-center gap-2 rounded-md py-2.5 pr-9 pl-3 text-left text-sm outline-none transition-colors",
          "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
          "disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          className,
        )}
      >
        <span className="flex-1">{children}</span>
        {selected && (
          <span className="absolute right-3 flex size-3.5 items-center justify-center">
            <CheckIcon className="size-4" />
          </span>
        )}
      </button>
    );
  }

  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      value={value}
      disabled={disabled}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
// Tag SelectItem so the mobile value→label walk can recognize it among arbitrary children.
(SelectItem as unknown as Record<symbol, boolean>)[SELECT_ITEM_MARKER] = true;

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  const ctx = React.useContext(SelectContext);

  if (ctx?.isMobile) {
    return <div className={cn("bg-border pointer-events-none -mx-1 my-1 h-px", className)} />;
  }

  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("bg-border pointer-events-none -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className,
      )}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className,
      )}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
