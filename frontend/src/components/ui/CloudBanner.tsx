import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// STRIPE-CONNECT-UX-001 §1.2: the single violet-cloud surface (.blanc-cloud in
// design-system.css). Pure presentation — no state, no queries, no logic.
export interface CloudBannerProps {
    variant?: "hero" | "compact";
    className?: string;
    children: ReactNode;
}

export function CloudBanner({ variant = "compact", className, children }: CloudBannerProps) {
    return (
        <div className={cn("blanc-cloud", variant === "hero" ? "p-6 sm:p-8" : "p-5", className)}>
            <div className="relative z-[1]">{children}</div>
        </div>
    );
}
