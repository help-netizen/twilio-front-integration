/**
 * OverlayStack — the open-overlay registry (OVERLAY-CANON-002, Phase 0).
 *
 * A tiny context that tracks which overlays are currently open and in what ORDER
 * they were opened. Every overlay built on `useOverlayDismiss` registers itself here
 * while open; the registry hands back that overlay's `depth` (0-based open index),
 * whether it is the top-most (`isTop`), and the total `count` of open overlays.
 *
 * Phase 0 is STATE-TRACKING ONLY — no visual transforms. Consumers use `isTop` to
 * gate global behaviors that must fire for the top layer alone (Esc, Tab-trap) so two
 * stacked overlays no longer both react to one keypress. The desktop card-stack /
 * mobile-cover transforms that read `depth`/`count` land in Phase 3.
 *
 * ── Provider-optional & SSR-safe (hard requirement) ───────────────────────────
 * If no <OverlayStackProvider> is mounted (isolated component tests, Storybook, an
 * overlay rendered outside App), `useOverlayStack` MUST NOT throw. It returns the
 * single-overlay sentinel `{ depth: 0, isTop: true, count: 1 }` — identical to what a
 * lone overlay sees under a provider — so behavior is byte-identical to pre-Phase-0.
 * This is achieved with a DEFAULT context value (no throwing `useContext` guard): the
 * default's register/unregister are no-ops and it advertises `hasProvider: false`.
 */

import * as React from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

interface OverlayStackContextValue {
    /** True only for the real provider — the default (no-provider) value sets false. */
    hasProvider: boolean
    /** Register `id` as open; no-op if already present. */
    register: (id: string) => void
    /** Remove `id` from the open list. */
    unregister: (id: string) => void
    /** Current open ids, in open-order (index 0 = opened first, last = top-most). */
    stack: readonly string[]
}

// DEFAULT value = the no-provider fallback. Its register/unregister do nothing and
// `stack` is always empty, so a hook used outside a provider computes the single-
// overlay sentinel (see useOverlayStack). We NEVER throw for a missing provider.
const NO_OP = () => {}
const OverlayStackContext = createContext<OverlayStackContextValue>({
    hasProvider: false,
    register: NO_OP,
    unregister: NO_OP,
    stack: [],
})

export interface OverlayStackProviderProps {
    children: React.ReactNode
}

export function OverlayStackProvider({ children }: OverlayStackProviderProps) {
    const [stack, setStack] = useState<readonly string[]>([])

    const register = useCallback((id: string) => {
        setStack((prev) => (prev.includes(id) ? prev : [...prev, id]))
    }, [])

    const unregister = useCallback((id: string) => {
        setStack((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev))
    }, [])

    const value = useMemo<OverlayStackContextValue>(
        () => ({ hasProvider: true, register, unregister, stack }),
        [register, unregister, stack],
    )

    return <OverlayStackContext.Provider value={value}>{children}</OverlayStackContext.Provider>
}

export interface OverlayStackInfo {
    /** 0-based index of this overlay in open-order (0 when closed or no provider). */
    depth: number
    /** True when this is the top-most (last-opened) open overlay. */
    isTop: boolean
    /** Total number of open overlays (1 in the single-overlay / no-provider case). */
    count: number
}

/**
 * Register `id` in the overlay stack while `open`, and read back this overlay's
 * position. Unregisters on close or unmount.
 *
 * @param id   Stable per-overlay id (pass a React `useId()` from the caller).
 * @param open Whether this overlay is currently open.
 *
 * No provider, or `open === false` → `{ depth: 0, isTop: true, count: 1 }` (the
 * single-overlay sentinel — a lone overlay always reads as the top).
 */
export function useOverlayStack(id: string, open: boolean): OverlayStackInfo {
    const { hasProvider, register, unregister, stack } = useContext(OverlayStackContext)

    // Keep the latest register/unregister without retriggering the register effect on
    // every provider state change (the effect must depend only on id/open/hasProvider).
    const registerRef = useRef(register)
    const unregisterRef = useRef(unregister)
    registerRef.current = register
    unregisterRef.current = unregister

    useEffect(() => {
        if (!hasProvider || !open) return
        registerRef.current(id)
        return () => unregisterRef.current(id)
    }, [hasProvider, open, id])

    // No provider (or not open): a lone overlay is, by definition, the top of a stack
    // of one. Byte-identical to pre-stacking behavior.
    if (!hasProvider || !open) {
        return { depth: 0, isTop: true, count: 1 }
    }

    const idx = stack.indexOf(id)
    // Not yet registered in this render pass (registration runs in an effect AFTER the
    // first open render) → treat as the top so the very first paint behaves like a lone
    // overlay; the next render (post-effect) reflects the true depth.
    if (idx === -1) {
        return { depth: stack.length, isTop: true, count: stack.length + 1 }
    }
    return { depth: idx, isTop: idx === stack.length - 1, count: stack.length }
}
