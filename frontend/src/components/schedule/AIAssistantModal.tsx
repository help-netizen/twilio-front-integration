/**
 * AIAssistantModal — Modal overlay for AI Schedule Assistant.
 * Phase 1: UI-only stub (onSubmit → console.log).
 */

import React, { useState, useEffect } from 'react';
import { X, Wand2, Sparkles, Send } from 'lucide-react';

interface AIAssistantModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSubmit?: (input: string) => void;
}

export const AIAssistantModal: React.FC<AIAssistantModalProps> = ({ isOpen, onClose, onSubmit }) => {
    const [input, setInput] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);

    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) onClose();
        };
        window.addEventListener('keydown', handleEscape);
        return () => window.removeEventListener('keydown', handleEscape);
    }, [isOpen, onClose]);

    useEffect(() => {
        if (isOpen) {
            setInput('');
            setIsProcessing(false);
        }
    }, [isOpen]);

    const handleSubmit = async () => {
        if (!input.trim()) return;
        setIsProcessing(true);
        // Phase 1 stub — just log
        console.log('[AI Schedule Assistant] Input:', input);
        if (onSubmit) onSubmit(input);
        await new Promise(r => setTimeout(r, 1500));
        setInput('');
        setIsProcessing(false);
        onClose();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit();
    };

    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 z-50 transition-opacity"
                style={{ background: 'rgba(32, 39, 52, 0.65)', backdropFilter: 'blur(8px)' }}
                onClick={onClose}
            />

            {/* Modal */}
            <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
                <div
                    className="w-full max-w-[680px] overflow-hidden pointer-events-auto"
                    style={{
                        background: 'linear-gradient(135deg, rgba(255, 251, 245, 0.98), rgba(252, 246, 237, 0.96))',
                        border: '1px solid rgba(178, 106, 29, 0.22)',
                        borderRadius: 'var(--sched-radius-xl)',
                        backdropFilter: 'blur(24px)',
                        boxShadow: '0 24px 80px rgba(48, 39, 28, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.7)',
                    }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="px-6 py-5">
                        {/* Header */}
                        <div className="flex items-center justify-between mb-5">
                            <div className="flex items-center gap-3">
                                <div
                                    className="flex items-center justify-center w-10 h-10"
                                    style={{
                                        background: 'linear-gradient(135deg, rgba(255, 200, 100, 0.28), rgba(255, 220, 150, 0.18))',
                                        border: '1px solid rgba(178, 106, 29, 0.18)',
                                        borderRadius: '12px',
                                    }}
                                >
                                    <Wand2 className="size-5" style={{ color: 'var(--sched-lead)' }} />
                                </div>
                                <div>
                                    <h2 className="text-[20px] font-bold leading-none" style={{ color: 'var(--sched-ink-1)', fontFamily: 'Manrope, sans-serif' }}>
                                        AI Schedule Assistant
                                    </h2>
                                    <p className="text-[12px] font-medium mt-1" style={{ color: 'var(--sched-ink-3)' }}>
                                        Describe the work and let AI handle the rest
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={onClose}
                                className="flex items-center justify-center w-9 h-9 transition-all hover:bg-black/5"
                                style={{ borderRadius: '10px', color: 'var(--sched-ink-2)' }}
                            >
                                <X className="size-5" />
                            </button>
                        </div>

                        {/* Processing indicator */}
                        {isProcessing && (
                            <div className="flex items-center gap-2 mb-4 px-4 py-2.5" style={{ background: 'rgba(178, 106, 29, 0.08)', borderRadius: '14px' }}>
                                <Sparkles className="size-4 animate-pulse" style={{ color: 'var(--sched-lead)' }} />
                                <span className="text-[13px] font-semibold" style={{ color: 'var(--sched-lead)' }}>
                                    AI is analyzing your request...
                                </span>
                            </div>
                        )}

                        {/* Input area */}
                        <div className="mb-4">
                            <textarea
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Example: '123 Main St, water heater replacement, customer prefers afternoon, urgent priority'"
                                disabled={isProcessing}
                                autoFocus
                                className="w-full min-h-[140px] px-4 py-3.5 resize-none text-[15px] leading-relaxed outline-none transition-all"
                                style={{
                                    background: 'rgba(255, 255, 255, 0.82)',
                                    border: '1px solid var(--sched-line)',
                                    borderRadius: 'var(--sched-radius-md)',
                                    color: 'var(--sched-ink-1)',
                                    fontFamily: 'inherit',
                                }}
                            />
                        </div>

                        {/* Info banner */}
                        <div className="mb-5 px-4 py-3" style={{
                            background: 'rgba(255, 255, 255, 0.5)',
                            border: '1px solid rgba(117, 106, 89, 0.12)',
                            borderRadius: '14px',
                        }}>
                            <p className="text-[12px] font-medium leading-relaxed" style={{ color: 'var(--sched-ink-3)' }}>
                                <strong style={{ color: 'var(--sched-ink-1)' }}>What AI will do:</strong> Automatically parse address, identify work type, find optimal time slot, and assign the most suitable technician based on skills and availability.
                            </p>
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                onClick={onClose}
                                className="flex-1 min-h-[52px] px-5 text-[15px] font-semibold transition-all hover:bg-black/5"
                                style={{
                                    background: 'rgba(255, 255, 255, 0.72)',
                                    border: '1px solid var(--sched-line)',
                                    borderRadius: 'var(--sched-radius-md)',
                                    color: 'var(--sched-ink-2)',
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleSubmit}
                                disabled={!input.trim() || isProcessing}
                                className="flex-1 flex items-center justify-center gap-2.5 min-h-[52px] px-5 text-[15px] font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                style={{
                                    background: input.trim() && !isProcessing
                                        ? 'linear-gradient(135deg, #b26a1d, #c97e2a)'
                                        : 'rgba(178, 106, 29, 0.2)',
                                    border: '1px solid ' + (input.trim() && !isProcessing ? 'rgba(178, 106, 29, 0.3)' : 'var(--sched-line)'),
                                    borderRadius: 'var(--sched-radius-md)',
                                    color: input.trim() && !isProcessing ? '#fff' : '#9a7a5c',
                                    boxShadow: input.trim() && !isProcessing ? '0 10px 32px rgba(178, 106, 29, 0.32)' : 'none',
                                }}
                            >
                                <Send className="size-4" />
                                <span>{isProcessing ? 'Processing...' : 'Create with AI'}</span>
                            </button>
                        </div>

                        {/* Keyboard shortcut hint */}
                        <p className="mt-3 text-center text-[11px] font-medium" style={{ color: '#9a7a5c' }}>
                            Press <kbd className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(0,0,0,0.08)', fontFamily: 'monospace' }}>Cmd/Ctrl + Enter</kbd> to submit
                        </p>
                    </div>
                </div>
            </div>
        </>
    );
};
