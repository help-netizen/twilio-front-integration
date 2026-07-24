import { Toaster as Sonner } from "sonner"
import { useIsMobile } from "../../hooks/useIsMobile"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
    // On mobile the bottom is crowded by the keyboard and bottom nav, and a
    // bottom-left toast is easy to miss — surface toasts at the top there.
    const isMobile = useIsMobile()
    return (
        <Sonner
            position={isMobile ? "top-center" : "bottom-left"}
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
