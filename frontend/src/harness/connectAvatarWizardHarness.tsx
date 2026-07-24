/**
 * ConnectAvatarWizard harness (AVATARS-001) — the real wizard inside a
 * FORM-CANON panel shell. No backend. Run: slot-harness (npx vite in frontend/)
 * → /connect-avatar-wizard-harness.html
 */
import { createRoot } from 'react-dom/client';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { ConnectAvatarWizard } from '../components/settings/ConnectAvatarWizard';

function Harness() {
    return (
        <div className="min-h-screen bg-[var(--blanc-bg)] p-6">
            <div className="mx-auto w-[460px] max-w-full overflow-hidden rounded-[22px] border border-[var(--blanc-line)] bg-[var(--blanc-panel-surface,#fff)] shadow-[0_18px_60px_rgba(31,23,45,0.14)]">
                <div className="border-b border-[var(--blanc-line)] px-7 pb-4 pt-6">
                    <div className="blanc-eyebrow">Connect your avatar</div>
                    <h2 className="text-[1.4rem] font-bold leading-tight tracking-[-0.02em] text-[var(--blanc-ink-1)]" style={{ fontFamily: 'var(--blanc-font-heading)' }}>New avatar</h2>
                    <p className="mt-1 text-sm text-[var(--blanc-ink-2)]">A digital copy of you that works inside Albusto with your access.</p>
                </div>
                <div className="px-7 py-6">
                    <ConnectAvatarWizard
                        onCancel={() => console.log('[harness] cancel')}
                        onContinue={(c) => console.log('[harness] continue', c)}
                    />
                </div>
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
