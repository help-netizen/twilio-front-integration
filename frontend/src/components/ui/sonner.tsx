import { Toaster as Sonner } from "sonner"
import { useIsMobile } from "../../hooks/useIsMobile"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
    // On mobile the bottom is crowded by the keyboard and bottom nav, and often
    // covers the Save/Send CTA — surface toasts at the TOP there (OB-40).
    const isMobile = useIsMobile()
    // Push the top-center mobile toasts below the notch / status bar so they are
    // not tucked under it (there is no sticky top header on mobile — the nav is a
    // bottom bar). Set both `offset` and `mobileOffset` so it holds across sonner's
    // own ~600px mobile breakpoint. Desktop keeps sonner's default placement.
    const topSafeOffset = { top: 'calc(env(safe-area-inset-top, 0px) + 12px)' }
    return (
        <Sonner
            position={isMobile ? "top-center" : "bottom-left"}
            offset={isMobile ? topSafeOffset : undefined}
            mobileOffset={isMobile ? topSafeOffset : undefined}
            className="toaster group"
            toastOptions={{
                classNames: {
                    toast:
                        "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
                    description: "group-[.toast]:text-muted-foreground",
                    actionButton:
                        "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
                    cancelButton:
                        "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
                },
            }}
            {...props}
        />
    )
}

export { Toaster }
