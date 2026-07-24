import { useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '../ui/button';

/**
 * AVATARS-001 — the "Connect your avatar" wizard: pick the base model, then how
 * it works. v1 exposes only ChatGPT + the MCP (ChatGPT-interface) mode; the
 * other bases and the autonomous mode are visible-but-disabled "Soon" so the
 * shape of the product is clear. Continue advances to the ChatGPT connect steps.
 */

export type AvatarBase = 'chatgpt' | 'claude' | 'gemini';
export type AvatarMode = 'mcp' | 'autonomous';

interface ConnectAvatarWizardProps {
    onCancel: () => void;
    onContinue: (choice: { base: AvatarBase; mode: AvatarMode }) => void;
}

interface Choice {
    id: string;
    title: string;
    desc: string;
    icon: string;
    iconClass?: string;
    soon?: boolean;
}

const BASES: Choice[] = [
    { id: 'chatgpt', title: 'ChatGPT', desc: 'OpenAI — available now.', icon: 'GPT', iconClass: 'bg-[#10a37f] text-white' },
    { id: 'claude', title: 'Claude', desc: 'Anthropic.', icon: 'Cl', soon: true },
    { id: 'gemini', title: 'Gemini', desc: 'Google.', icon: 'G', soon: true },
];

const MODES: Choice[] = [
    { id: 'mcp', title: 'Through ChatGPT (MCP)', desc: 'You chat in ChatGPT; it reads and acts in Albusto on your behalf, asking you to confirm changes.', icon: '↔', iconClass: 'bg-[#10a37f] text-white' },
    { id: 'autonomous', title: 'Autonomous', desc: 'Runs on its own from an instruction you write — no chat needed.', icon: '⚙', soon: true },
];

function OptionCard({
    choice,
    selected,
    onSelect,
    children,
}: {
    choice: Choice;
    selected: boolean;
    onSelect?: () => void;
    children?: React.ReactNode;
}) {
    const clickable = !choice.soon && onSelect;
    return (
        <button
            type="button"
            disabled={choice.soon}
            aria-pressed={selected}
            onClick={clickable ? onSelect : undefined}
            className={[
                'flex w-full items-start gap-3 rounded-2xl border px-3.5 py-3 text-left transition-colors',
                choice.soon ? 'cursor-default opacity-60' : 'cursor-pointer',
                selected ? 'border-[var(--blanc-accent)] bg-[color-mix(in_srgb,var(--blanc-accent)_6%,transparent)]' : 'border-[var(--blanc-line)]',
            ].join(' ')}
        >
            <div
                className={[
                    'grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] text-[13px] font-bold',
                    choice.iconClass ?? 'bg-[var(--blanc-surface-muted)] text-[var(--blanc-ink-2)]',
                ].join(' ')}
                style={{ fontFamily: 'var(--blanc-font-heading)' }}
                aria-hidden
            >
                {choice.icon}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-[var(--blanc-ink-1)]">
                    {choice.title}
                    {choice.soon && (
                        <span className="rounded-md bg-[rgba(178,106,29,0.12)] px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-wide text-[var(--blanc-warning)]">
                            Soon
                        </span>
                    )}
                </div>
                <p className="mt-0.5 text-sm text-[var(--blanc-ink-2)]">{choice.desc}</p>
                {children}
            </div>
            {!choice.soon && (
                <span
                    aria-hidden
                    className={[
                        'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2',
                        selected ? 'border-[var(--blanc-accent)]' : 'border-[var(--blanc-line-strong)]',
                    ].join(' ')}
                >
                    {selected && <Check className="h-3 w-3 text-[var(--blanc-accent)]" />}
                </span>
            )}
        </button>
    );
}

export function ConnectAvatarWizard({ onCancel, onContinue }: ConnectAvatarWizardProps) {
    const [base, setBase] = useState<AvatarBase>('chatgpt');
    const [mode, setMode] = useState<AvatarMode>('mcp');

    return (
        <div className="flex h-full flex-col">
            <div className="flex-1 space-y-6">
                <section className="space-y-2.5">
                    <div className="blanc-eyebrow">Step 1 · Based on</div>
                    <div className="space-y-2.5">
                        {BASES.map(b => (
                            <OptionCard
                                key={b.id}
                                choice={b}
                                selected={base === b.id}
                                onSelect={() => setBase(b.id as AvatarBase)}
                            />
                        ))}
                    </div>
                </section>

                <section className="space-y-2.5">
                    <div className="blanc-eyebrow">Step 2 · How it works</div>
                    <div className="space-y-2.5">
                        {MODES.map(m => (
                            <OptionCard
                                key={m.id}
                                choice={m}
                                selected={mode === m.id}
                                onSelect={() => setMode(m.id as AvatarMode)}
                            >
                                {m.id === 'autonomous' && (
                                    <div className="mt-2 min-h-[64px] rounded-[10px] bg-[var(--blanc-field)] px-3 py-2.5 text-sm text-[var(--blanc-ink-3)]">
                                        Instruction to your avatar… (e.g. “Every morning, review overdue jobs and text the customer a reschedule option.”)
                                    </div>
                                )}
                            </OptionCard>
                        ))}
                    </div>
                </section>
            </div>

            <div className="mt-6 flex items-center gap-3 border-t border-[var(--blanc-line)] pt-4">
                <Button variant="ghost" onClick={onCancel}>Cancel</Button>
                <span className="flex-1" />
                <Button onClick={() => onContinue({ base, mode })}>
                    Continue → connect in ChatGPT
                </Button>
            </div>
        </div>
    );
}
