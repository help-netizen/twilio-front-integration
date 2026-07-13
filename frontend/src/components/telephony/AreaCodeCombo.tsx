import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FloatingField } from '../ui/floating-field';
import { authedFetch } from '../../services/apiClient';
import {
    detectSearchKind,
    formatAreaCode,
    suggestAreaCodes,
    type AreaCode,
    type AreaCodeLocale,
    type AreaCodeSearchCriterion,
} from '../../data/areaCodes';

interface AreaCodeComboProps {
    value: AreaCodeSearchCriterion | null;
    onChange: (value: AreaCodeSearchCriterion | null) => void;
    onIncompleteChange?: (incomplete: boolean) => void;
    disabled?: boolean;
}

function nullableString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nullableNumber(value: unknown): number | null {
    if (value == null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export function AreaCodeCombo({
    value,
    onChange,
    onIncompleteChange,
    disabled = false,
}: AreaCodeComboProps) {
    const reactId = useId();
    const inputId = `area-code-combo-${reactId}`;
    const listboxId = `${inputId}-listbox`;
    const rootRef = useRef<HTMLDivElement>(null);
    const emittedValueRef = useRef<AreaCodeSearchCriterion | null>(value);
    const [inputValue, setInputValue] = useState(value?.value ?? '');
    const [open, setOpen] = useState(false);
    const [highlightedIndex, setHighlightedIndex] = useState(-1);

    const localeQ = useQuery({
        queryKey: ['telephony-twilio-wizard', 'locale'],
        queryFn: async (): Promise<AreaCodeLocale> => {
            const response = await authedFetch('/api/telephony/numbers/locale');
            const json = await response.json().catch(() => ({}));
            if (!response.ok) return {};
            return {
                city: nullableString(json.city),
                state: nullableString(json.state),
                zip: nullableString(json.zip),
                lat: nullableNumber(json.lat),
                lon: nullableNumber(json.lon),
            };
        },
        retry: false,
        staleTime: Infinity,
    });

    const suggestions = useMemo(
        () => suggestAreaCodes(inputValue, localeQ.data),
        [inputValue, localeQ.data],
    );
    const incomplete = /^\d{1,2}$/.test(inputValue.trim());

    useEffect(() => {
        if (value === emittedValueRef.current) return;
        emittedValueRef.current = value;
        setInputValue(value?.value ?? '');
    }, [value]);

    useEffect(() => {
        setHighlightedIndex(-1);
    }, [inputValue, suggestions.length]);

    useEffect(() => {
        if (!open) return;
        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', closeOnOutsidePointer);
        return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
    }, [open]);

    const emit = (next: AreaCodeSearchCriterion | null) => {
        emittedValueRef.current = next;
        onChange(next);
    };

    const selectAreaCode = (areaCode: AreaCode) => {
        const display = formatAreaCode(areaCode);
        setInputValue(display);
        setOpen(false);
        onIncompleteChange?.(false);
        emit(detectSearchKind(display, areaCode));
    };

    const handleInputChange = (rawValue: string) => {
        const nextValue = /^\d+$/.test(rawValue) ? rawValue.slice(0, 3) : rawValue;
        const nextIncomplete = /^\d{1,2}$/.test(nextValue.trim());
        setInputValue(nextValue);
        setOpen(true);
        onIncompleteChange?.(nextIncomplete);
        emit(detectSearchKind(nextValue));
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (event.key === 'Escape') {
            setOpen(false);
            setHighlightedIndex(-1);
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (suggestions.length === 0) return;
            event.preventDefault();
            setOpen(true);
            setHighlightedIndex(current => {
                if (event.key === 'ArrowDown') return current >= suggestions.length - 1 ? 0 : current + 1;
                return current <= 0 ? suggestions.length - 1 : current - 1;
            });
            return;
        }
        if (event.key === 'Enter' && open && highlightedIndex >= 0) {
            const areaCode = suggestions[highlightedIndex];
            if (!areaCode) return;
            event.preventDefault();
            selectAreaCode(areaCode);
        }
    };

    return (
        <div
            ref={rootRef}
            className="relative"
            role="combobox"
            aria-expanded={open && suggestions.length > 0}
            aria-haspopup="listbox"
            aria-owns={listboxId}
        >
            <FloatingField
                id={inputId}
                label="Area code or city"
                value={inputValue}
                disabled={disabled}
                inputMode={/^\d*$/.test(inputValue) ? 'numeric' : 'text'}
                onChange={event => handleInputChange(event.target.value)}
                onFocus={() => setOpen(true)}
                onBlur={event => {
                    if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
                }}
                onKeyDown={handleKeyDown}
            />
            {incomplete && (
                <p className="mt-1.5 px-1 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                    Finish the 3-digit area code.
                </p>
            )}
            {open && suggestions.length > 0 && (
                <div
                    id={listboxId}
                    role="listbox"
                    className="absolute left-0 right-0 z-30 mt-2 overflow-hidden rounded-xl border bg-[var(--blanc-surface-strong)] py-1"
                    style={{ borderColor: 'var(--blanc-line)' }}
                >
                    {suggestions.map((areaCode, index) => (
                        <button
                            key={areaCode.code}
                            type="button"
                            role="option"
                            aria-selected={index === highlightedIndex}
                            className="block w-full px-3.5 py-2 text-left text-sm"
                            style={{
                                color: 'var(--blanc-ink-1)',
                                background: index === highlightedIndex ? 'var(--blanc-field)' : 'transparent',
                            }}
                            onMouseDown={event => event.preventDefault()}
                            onMouseEnter={() => setHighlightedIndex(index)}
                            onClick={() => selectAreaCode(areaCode)}
                        >
                            {formatAreaCode(areaCode)}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
