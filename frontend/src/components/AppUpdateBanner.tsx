import { useAppUpdate } from '../hooks/useAppUpdate';

/**
 * PWA-UPDATE-001 — a quiet top pill shown when a newer build is deployed while the app is still
 * running the old one (common in installed PWAs). Tapping Reload loads the fresh build.
 */
export function AppUpdateBanner() {
    const { updateAvailable, reload } = useAppUpdate();
    if (!updateAvailable) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            style={{
                position: 'fixed',
                top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 2147483000,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '9px 10px 9px 16px',
                borderRadius: 9999,
                maxWidth: 'calc(100vw - 24px)',
                background: 'var(--blanc-surface-strong, #ffffff)',
                border: '1px solid var(--blanc-line, rgba(25,25,25,0.08))',
                boxShadow: '0 10px 30px rgba(25,25,25,0.16)',
            }}
        >
            <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--blanc-ink-1, #191919)' }}>
                A new version is available.
            </span>
            <button
                type="button"
                onClick={reload}
                style={{
                    flexShrink: 0,
                    padding: '7px 18px',
                    borderRadius: 9999,
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 14,
                    fontWeight: 600,
                    color: '#ffffff',
                    background: 'var(--blanc-accent, #7F42E1)',
                }}
            >
                Reload
            </button>
        </div>
    );
}
