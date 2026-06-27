/**
 * SmsForm — SMS composition form with quick messages, file attachments,
 * AI formatting button (Wand2), character counter, ⌘+Enter to send.
 * Supports {Field Name} variable placeholders in quick messages.
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Send, Wand2, ChevronDown, Paperclip, X, ChevronUp, Mail, MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuthz } from '../../hooks/useAuthz';
import { authedFetch } from '../../services/apiClient';
import { formatFileSize, resolveVariables, buildMessageTargets } from './smsFormHelpers';
import type { SmsFormProps, QuickMessage, MessageTarget } from './smsFormHelpers';
import { isMobileViewport, clampToViewport } from '../../hooks/useViewportSafePosition';

const API_BASE = import.meta.env.VITE_API_URL || '';

export function SmsForm({ onSend, onAiFormat, disabled, lead, mainPhone, secondaryPhone, secondaryPhoneName, emails, emailConnected, selectedTarget, onTargetChange }: SmsFormProps) {
    const [message, setMessage] = useState('');
    const [isPresetsOpen, setIsPresetsOpen] = useState(false);
    const [isAiFormatting, setIsAiFormatting] = useState(false);
    const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
    const [toDropdownOpen, setToDropdownOpen] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const quickBtnRef = useRef<HTMLButtonElement>(null);
    const quickDropdownRef = useRef<HTMLDivElement>(null);
    const [quickMessages, setQuickMessages] = useState<QuickMessage[]>([]);
    const navigate = useNavigate();
    const { hasPermission } = useAuthz();
    // Only admins can reach /settings/email (gated by tenant.integrations.manage);
    // non-admins get a non-clickable hint instead of a dead-end CTA.
    const canManageIntegrations = hasPermission('tenant.integrations.manage');

    useEffect(() => { const ta = textareaRef.current; if (!ta) return; ta.style.height = 'auto'; const lh = parseInt(getComputedStyle(ta).lineHeight) || 20; ta.style.height = `${Math.min(Math.max(ta.scrollHeight, lh * 3 + 16), lh * 10 + 16)}px`; }, [message]);

    const fetchQuickMessages = useCallback(async () => { try { const res = await authedFetch(`${API_BASE}/api/quick-messages`); const data = await res.json(); setQuickMessages(data.messages || []); } catch (err) { console.error('Failed to load quick messages:', err); } }, []);
    useEffect(() => { fetchQuickMessages(); }, [fetchQuickMessages]);

    // Close quick messages dropdown on click outside (no overlay blocking scroll)
    useEffect(() => {
        if (!isPresetsOpen) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            if (quickDropdownRef.current?.contains(target) || quickBtnRef.current?.contains(target)) return;
            setIsPresetsOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [isPresetsOpen]);

    const targets = useMemo(
        () => buildMessageTargets(mainPhone, secondaryPhone, secondaryPhoneName, emails),
        [mainPhone, secondaryPhone, secondaryPhoneName, emails],
    );
    const activeTarget: MessageTarget | undefined = selectedTarget
        ?? targets.find(t => t.channel === 'sms')
        ?? targets[0];
    const isEmail = activeTarget?.channel === 'email';
    const emailTargets = targets.filter(t => t.channel === 'email');
    // Show the To-selector when there's more than one phone OR any email option exists.
    const phoneCount = targets.filter(t => t.channel === 'sms').length;
    const showToSelector = phoneCount > 1 || emailTargets.length > 0;

    const handleSend = () => {
        if (!activeTarget) return;
        if (message.trim() || (!isEmail && attachedFiles.length > 0)) {
            onSend(message, isEmail ? undefined : attachedFiles, { channel: activeTarget.channel, value: activeTarget.value });
            setMessage('');
            setAttachedFiles([]);
        }
    };
    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => { const files = Array.from(e.target.files || []); setAttachedFiles(prev => [...prev, ...files]); if (fileInputRef.current) fileInputRef.current.value = ''; };
    const handleRemoveFile = (index: number) => { setAttachedFiles(prev => prev.filter((_, i) => i !== index)); };
    const handlePresetSelect = (presetText: string) => { setMessage(resolveVariables(presetText, lead)); setIsPresetsOpen(false); };
    const handleAiFormat = async () => { if (message.trim() && onAiFormat) { setIsAiFormatting(true); try { setMessage(await onAiFormat(message)); } catch (error) { console.error('AI formatting failed:', error); } finally { setIsAiFormatting(false); } } };
    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); } };

    return (
        <div className="border-t p-4" style={{ borderTopColor: 'var(--blanc-line)', background: 'var(--blanc-surface-strong)' }}>
            {showToSelector && activeTarget && (
                <div className="mb-2 relative">
                    <div className="flex items-center gap-2 text-xs">
                        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--blanc-ink-3)' }}>To</span>
                        <button type="button" onClick={() => setToDropdownOpen(!toDropdownOpen)} className="flex items-center gap-1.5 px-2 py-1 rounded-lg border hover:bg-muted/60 transition-colors" style={{ borderColor: 'var(--blanc-line)', background: 'var(--blanc-surface-muted)', color: 'var(--blanc-ink-1)' }}>
                            {activeTarget.channel === 'email'
                                ? <Mail className="w-3 h-3" style={{ color: 'var(--blanc-ink-3)' }} />
                                : <MessageSquare className="w-3 h-3" style={{ color: 'var(--blanc-ink-3)' }} />}
                            <span>{activeTarget.label}</span>
                            {toDropdownOpen ? <ChevronUp className="w-3 h-3" style={{ color: 'var(--blanc-ink-3)' }} /> : <ChevronDown className="w-3 h-3" style={{ color: 'var(--blanc-ink-3)' }} />}
                        </button>
                    </div>
                    {toDropdownOpen && (
                        <>
                            <div className="fixed inset-0 z-10" onClick={() => setToDropdownOpen(false)} />
                            <div className="absolute left-0 top-full mt-1 rounded-xl shadow-lg z-20 py-1 min-w-[260px] max-w-[calc(100vw-32px)]" style={{ background: 'var(--blanc-surface-strong)', border: '1px solid var(--blanc-line)' }}>
                                {targets.filter(t => t.channel === 'sms').map(t => {
                                    const selected = activeTarget.channel === 'sms' && activeTarget.value === t.value;
                                    return (
                                        <button key={`sms-${t.value}`} onClick={() => { onTargetChange?.(t); setToDropdownOpen(false); }} className="w-full text-left px-3 py-2 hover:bg-muted/50 text-sm flex items-center justify-between gap-2" style={{ color: selected ? 'var(--blanc-info)' : 'var(--blanc-ink-1)' }}>
                                            <span className="flex items-center gap-2 min-w-0"><MessageSquare className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} /><span className="truncate">{t.label}</span></span>
                                            {selected && <span className="text-xs shrink-0">✓</span>}
                                        </button>
                                    );
                                })}
                                {emailTargets.length > 0 && emailConnected && emailTargets.map(t => {
                                    const selected = activeTarget.channel === 'email' && activeTarget.value === t.value;
                                    return (
                                        <button key={`email-${t.value}`} onClick={() => { onTargetChange?.(t); setToDropdownOpen(false); }} className="w-full text-left px-3 py-2 hover:bg-muted/50 text-sm flex items-center justify-between gap-2" style={{ color: selected ? 'var(--blanc-info)' : 'var(--blanc-ink-1)' }}>
                                            <span className="flex items-center gap-2 min-w-0"><Mail className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} /><span className="truncate">{t.label}</span></span>
                                            {selected && <span className="text-xs shrink-0">✓</span>}
                                        </button>
                                    );
                                })}
                                {emailTargets.length > 0 && !emailConnected && (
                                    canManageIntegrations ? (
                                        <button onClick={() => { setToDropdownOpen(false); navigate('/settings/email'); }} className="w-full text-left px-3 py-2 hover:bg-muted/50 text-sm flex items-start gap-2">
                                            <Mail className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: 'var(--blanc-ink-3)' }} />
                                            <span style={{ color: 'var(--blanc-info)' }}>Connect Google email to message clients by email →</span>
                                        </button>
                                    ) : (
                                        <div className="w-full text-left px-3 py-2 text-sm flex items-start gap-2">
                                            <Mail className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: 'var(--blanc-ink-3)' }} />
                                            <span style={{ color: 'var(--blanc-ink-3)' }}>Email unavailable — ask an admin to connect Google email</span>
                                        </div>
                                    )
                                )}
                            </div>
                        </>
                    )}
                </div>
            )}
            {attachedFiles.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">{attachedFiles.map((file, index) => <div key={index} className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm" style={{ background: 'var(--blanc-surface-muted)', border: '1px solid var(--blanc-line)' }}><Paperclip className="w-3.5 h-3.5" style={{ color: 'var(--blanc-ink-3)' }} /><span className="max-w-[150px] truncate" style={{ color: 'var(--blanc-ink-1)' }}>{file.name}</span><span className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>({formatFileSize(file.size)})</span><button onClick={() => handleRemoveFile(index)} className="ml-1 hover:text-red-600 transition-colors" style={{ color: 'var(--blanc-ink-3)' }}><X className="w-3.5 h-3.5" /></button></div>)}</div>
            )}
            <div className="relative mb-3">
                <div aria-hidden className="absolute inset-0 px-3 py-2 pr-20 text-sm pointer-events-none overflow-hidden rounded-lg border border-transparent" style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word', color: 'transparent', lineHeight: textareaRef.current ? getComputedStyle(textareaRef.current).lineHeight : '1.5', fontFamily: textareaRef.current ? getComputedStyle(textareaRef.current).fontFamily : 'inherit' }} dangerouslySetInnerHTML={{ __html: message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{([^}]+)\}/g, '<mark style="background:#fef3c7;color:transparent;border-radius:3px;padding:1px 0">$&</mark>') + '\n' }} />
                <textarea ref={textareaRef} value={message} onChange={e => setMessage(e.target.value)} onKeyDown={handleKeyDown} placeholder={isEmail ? 'Write an email... (Cmd/Ctrl + Enter to send)' : 'Type your message... (Cmd/Ctrl + Enter to send)'} className="w-full px-3 py-2 pr-20 rounded-lg resize-none focus:outline-none focus:ring-2 focus:border-transparent text-sm" style={{ overflow: 'auto', background: 'transparent', position: 'relative', border: '1px solid var(--blanc-line-strong)', '--tw-ring-color': 'rgba(47,99,216,0.25)' } as React.CSSProperties} rows={3} disabled={disabled} />
                {/* SMS char count only (emails have no segment limit) */}
                {!isEmail && message.length > 0 && (
                    <div
                        className="absolute top-2 right-3 text-[11px] font-mono"
                        style={{ color: message.length > 300 ? 'var(--blanc-danger)' : 'var(--blanc-ink-3)' }}
                    >
                        {message.length}
                    </div>
                )}
            </div>
            <div className="flex items-center justify-between gap-2 max-md:flex-wrap">
                <div className="flex items-center gap-2">
                    <div className="relative">
                        <button
                            ref={quickBtnRef}
                            onClick={() => setIsPresetsOpen(!isPresetsOpen)}
                            className="flex items-center gap-1.5 px-4 text-sm font-semibold transition-opacity hover:opacity-70"
                            style={{ color: 'var(--blanc-ink-1)', borderColor: 'rgba(104, 95, 80, 0.14)', background: 'var(--blanc-surface-strong)', border: '1px solid rgba(104, 95, 80, 0.14)', borderRadius: 14, minHeight: 42, boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px' }}
                            title="Quick Messages"
                        >
                            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isPresetsOpen ? 'rotate-180' : ''}`} />
                            Quick
                        </button>
                        {isPresetsOpen && (() => {
                            const quickContent = (
                                <>
                                    <div className="overflow-y-auto flex-1">
                                        {quickMessages.map(qm => (
                                            <button key={qm.id} onClick={() => handlePresetSelect(qm.content)} className="w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors">
                                                <div className="text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>{qm.title}</div>
                                                <div className="text-xs line-clamp-1" style={{ color: 'var(--blanc-ink-3)' }}>{qm.content}</div>
                                            </button>
                                        ))}
                                    </div>
                                    <div className="border-t my-1 flex-shrink-0" style={{ borderColor: 'var(--blanc-line)' }} />
                                    <button onClick={() => { setIsPresetsOpen(false); navigate('/settings/quick-messages'); }} className="w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors flex-shrink-0">
                                        <div className="text-sm font-medium" style={{ color: 'var(--blanc-info)' }}>+ Add New</div>
                                    </button>
                                </>
                            );
                            if (isMobileViewport()) {
                                return (
                                    <>
                                        <div className="blanc-mobile-sheet-backdrop" onClick={() => setIsPresetsOpen(false)} />
                                        <div ref={quickDropdownRef} className="blanc-mobile-sheet flex flex-col">
                                            <div className="blanc-mobile-sheet-header">
                                                <h3>Quick Messages</h3>
                                                <button onClick={() => setIsPresetsOpen(false)} className="p-1 rounded-lg" style={{ color: 'var(--blanc-ink-3)' }}><X className="size-5" /></button>
                                            </div>
                                            {quickContent}
                                        </div>
                                    </>
                                );
                            }
                            const btnRect = quickBtnRef.current?.getBoundingClientRect();
                            const pos = btnRect ? clampToViewport(btnRect, 288, 320, false) : { left: 0, top: 0 };
                            return (
                                <div ref={quickDropdownRef} className="fixed w-72 rounded-xl shadow-lg z-[101] py-1 flex flex-col" style={{ background: 'var(--blanc-surface-strong)', border: '1px solid var(--blanc-line)', maxHeight: '50vh', left: pos.left, bottom: btnRect ? window.innerHeight - btnRect.top + 4 : 0 }}>
                                    {quickContent}
                                </div>
                            );
                        })()}
                    </div>
                    {!isEmail && (
                        <>
                            <button onClick={() => fileInputRef.current?.click()} className="flex items-center justify-center transition-opacity hover:opacity-70" style={{ width: 42, height: 42, borderRadius: 14, border: '1px solid rgba(104, 95, 80, 0.14)', background: 'var(--blanc-surface-strong)', color: 'var(--blanc-ink-2)', boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px' }} title="Attach file"><Paperclip className="w-4 h-4" /></button>
                            <input ref={fileInputRef} type="file" multiple onChange={handleFileSelect} className="hidden" />
                        </>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={handleAiFormat} disabled={!message.trim() || isAiFormatting || !onAiFormat} className="flex items-center justify-center transition-opacity hover:opacity-70 disabled:opacity-40 disabled:cursor-not-allowed" style={{ width: 42, height: 42, borderRadius: 14, border: '1px solid rgba(104, 95, 80, 0.14)', background: 'var(--blanc-surface-strong)', color: 'var(--blanc-ink-2)', boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px' }} title="Format with AI"><Wand2 className={`w-4 h-4 ${isAiFormatting ? 'animate-spin' : ''}`} /></button>
                    <button
                        onClick={handleSend}
                        disabled={(!message.trim() && (isEmail || attachedFiles.length === 0)) || disabled || !activeTarget}
                        className="flex items-center gap-1.5 px-5 text-sm font-semibold transition-opacity hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ background: 'var(--blanc-info)', color: '#fff', minHeight: 42, borderRadius: 14, border: 'none', boxShadow: 'rgba(48, 39, 28, 0.06) 0px 6px 16px' }}
                    >
                        <Send className="w-3.5 h-3.5" />
                        {isEmail ? 'Email' : 'Send'}
                    </button>
                </div>
            </div>
        </div>
    );
}
