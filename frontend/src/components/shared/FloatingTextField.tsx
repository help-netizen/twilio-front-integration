import * as React from 'react';
import { ArrowUp, Check, Loader2 } from 'lucide-react';
import { FloatingField } from '../ui/floating-field';
import { NoteComposerOverlay } from './NoteComposerOverlay';
import { useIsMobile } from '../../hooks/useIsMobile';

interface FloatingTextFieldProps {
    label: string;
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    type?: string;
    inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
    textarea?: boolean;
    rows?: number;
    disabled?: boolean;
    name?: string;
    /**
     * Optional primary action rendered INSIDE the mobile overlay (e.g. "send receipt"): a round
     * violet send button that runs this then closes. Omit → a plain "Done" that just closes
     * (the value is already written live through onChange, so the parent form keeps it).
     */
    onSubmit?: () => void;
    submitting?: boolean;
    /** Enables the overlay's submit button. Defaults to value-non-empty. */
    canSubmit?: boolean;
}

/**
 * INPUT-KBD pattern A — a FloatingField whose real editing, ON MOBILE, happens in a floating card
 * docked above the on-screen keyboard instead of in place (where iOS would cover it). The rendered
 * field is a read-only TRIGGER (readOnly ⇒ iOS never raises the keyboard on it); tapping it opens
 * the proven {@link NoteComposerOverlay} with a DUPLICATE input bound to the same value — the owner's
 * rule: "the original field is only there to summon the real input above the keyboard." Desktop keeps
 * the plain inline FloatingField (no keyboard problem there).
 */
export function FloatingTextField({
    label, value, onChange, type, inputMode, textarea, rows, disabled, name,
    onSubmit, submitting, canSubmit,
}: FloatingTextFieldProps) {
    const isMobile = useIsMobile();
    const [open, setOpen] = React.useState(false);

    if (!isMobile) {
        return (
            <FloatingField
                label={label} value={value} onChange={onChange} type={type}
                inputMode={inputMode} textarea={textarea} rows={rows} disabled={disabled} name={name}
            />
        );
    }

    const submittable = canSubmit ?? Boolean(value.trim());
    const close = () => setOpen(false);
    const doSubmit = () => {
        if (onSubmit) {
            if (!submittable || submitting) return;
            onSubmit();
        }
        close();
    };

    return (
        <>
            <FloatingField
                label={label} value={value} type={type} inputMode={inputMode}
                textarea={textarea} rows={rows} disabled={disabled} name={name}
                readOnly
                onClick={disabled ? undefined : () => setOpen(true)}
            />
            <NoteComposerOverlay open={open} onClose={close}>
                <div style={{ background: 'var(--blanc-field)', borderRadius: 16, padding: '10px 12px' }}>
                    <div className="flex items-end gap-3">
                        {textarea ? (
                            <textarea
                                autoFocus rows={rows ?? 3} value={value} onChange={onChange} placeholder={label}
                                className="flex-1 resize-none bg-transparent outline-none"
                                style={{ border: 'none', fontSize: 16, lineHeight: 1.5, color: 'var(--blanc-ink-1)', minHeight: 72, padding: '2px 2px 0' }}
                            />
                        ) : (
                            <input
                                autoFocus type={type} inputMode={inputMode} value={value} onChange={onChange} placeholder={label}
                                className="flex-1 bg-transparent outline-none"
                                style={{ border: 'none', fontSize: 16, color: 'var(--blanc-ink-1)', height: 36, padding: '0 2px' }}
                                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); doSubmit(); } }}
                            />
                        )}
                        <button
                            type="button"
                            onClick={doSubmit}
                            disabled={onSubmit ? !submittable || submitting : false}
                            aria-label={onSubmit ? 'Send' : 'Done'}
                            className="flex shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-40"
                            style={{ width: 40, height: 40, background: 'var(--blanc-accent)', color: '#fff' }}
                        >
                            {submitting ? <Loader2 className="size-5 animate-spin" /> : onSubmit ? <ArrowUp className="size-5" /> : <Check className="size-5" />}
                        </button>
                    </div>
                </div>
            </NoteComposerOverlay>
        </>
    );
}
