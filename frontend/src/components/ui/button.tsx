import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
    {
        variants: {
            variant: {
                // PRIMARY — the one main action per surface (submit/confirm). Solid accent.
                default: "bg-primary text-primary-foreground hover:bg-primary/90",
                // DESTRUCTIVE — delete / cancel-entity. Solid danger.
                destructive:
                    "bg-[var(--blanc-danger)] text-white hover:bg-[var(--blanc-danger)]/90 focus-visible:ring-destructive/30",
                // SECONDARY — emphasized non-primary action (tinted accent). Use for prominent
                // in-form steps like "Pick time", "Add item" — colored, but not competing with primary.
                // PALETTE-V2 (W2): tinted-акцент = лавандовая пара фиолетового primary
                secondary:
                    "bg-[var(--blanc-accent-soft)] text-[var(--blanc-accent)] hover:bg-[rgba(222,206,250,0.95)]",
                // OUTLINE — neutral bordered action. Transparent so it sits on any surface.
                outline:
                    "border border-[var(--blanc-line-strong)] bg-transparent text-[var(--blanc-ink-1)] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]",
                // GHOST — tertiary / cancel / dismiss. Text only.
                ghost:
                    "text-[var(--blanc-ink-2)] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]",
                // LINK — inline textual action.
                link: "text-primary underline-offset-4 hover:underline",
            },
            size: {
                default: "h-9 px-4 py-2 has-[>svg]:px-3",
                sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
                lg: "h-10 px-6 has-[>svg]:px-4",
                icon: "size-9",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    },
);

const Button = React.forwardRef<
    HTMLButtonElement,
    React.ComponentProps<"button"> &
    VariantProps<typeof buttonVariants> & {
        asChild?: boolean;
    }
>(({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";

    return (
        <Comp
            ref={ref}
            data-slot="button"
            className={cn(buttonVariants({ variant, size, className }))}
            {...props}
        />
    );
});

Button.displayName = "Button";

export { Button, buttonVariants };
