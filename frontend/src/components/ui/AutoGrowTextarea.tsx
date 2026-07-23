import { forwardRef, useLayoutEffect, useRef } from 'react';

interface AutoGrowTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    /** Growth cap in rows; beyond it the textarea scrolls (default 10). */
    maxRows?: number;
}

/**
 * OB-25: description fields must grow with their content instead of clipping
 * it at a fixed rows count. Height tracks scrollHeight up to maxRows, then
 * scrolls. `rows` still sets the MINIMUM height.
 */
export const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, AutoGrowTextareaProps>(
    function AutoGrowTextarea({ maxRows = 10, value, style, ...rest }, forwardedRef) {
        const innerRef = useRef<HTMLTextAreaElement | null>(null);

        useLayoutEffect(() => {
            const el = innerRef.current;
            if (!el) return;
            el.style.height = 'auto';
            const cs = getComputedStyle(el);
            const line = parseFloat(cs.lineHeight) || 20;
            const padding = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
            const max = line * maxRows + padding;
            el.style.height = `${Math.min(el.scrollHeight, max)}px`;
            el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
        }, [value, maxRows]);

        return (
            <textarea
                ref={node => {
                    innerRef.current = node;
                    if (typeof forwardedRef === 'function') forwardedRef(node);
                    else if (forwardedRef) forwardedRef.current = node;
                }}
                value={value}
                style={style}
                {...rest}
            />
        );
    },
);
