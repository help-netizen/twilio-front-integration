/**
 * SmsForm — SMS composition form with quick messages, file attachments,
 * AI formatting button (Wand2), character counter, ⌘+Enter to send.
 * Supports {Field Name} variable placeholders in quick messages.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Wand2, ChevronDown, Paperclip, X, ChevronUp } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { authedFetch } from '../../services/apiClient';
import { formatFileSize, formatDisplayPhone, resolveVariables } from './smsFormHelpers';
import type { SmsFormProps, QuickMessage } from './smsFormHelpers';

const API_BASE = import.meta.env.VITE_API_URL || '';

export function SmsForm({ onSend, onAiFormat, disabled, lead, mainPhone, secondaryPhone, secondaryPhoneName, selectedPhone, onPhoneChange }: SmsFormProps) {
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

    const handleSend = () => { if (message.trim() || attachedFiles.length > 0) { onSend(message, attachedFiles, selectedPhone); setMessage(''); setAttachedFiles([]); } };
    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => { const files = Array.from(e.target.files || []); setAttachedFiles(prev => [...prev, ...files]); if (fileInputRef.current) fileInputRef.current.value = ''; };
    const handleRemoveFile = (index: number) => { setAttachedFiles(prev => prev.filter((_, i) => i !== index)); };
    const handlePresetSelect = (presetText: string) => { setMessage(resolveVariables(presetText, lead)); setIsPresetsOpen(false); };
    const handleAiFormat = async () => { if (message.trim() && onAiFormat) { setIsAiFormatting(true); try { setMessage(await onAiFormat(message)); } catch (error) { console.error('AI formatting failed:', error); } finally { setIsAiFormatting(false); } } };
    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); } };

    const hasSecondary = !!(secondaryPhone && mainPhone && secondaryPhone !== mainPhone);

    return (
        <div className="border-t p-4" style={{ borderTopColor: 'var(--blanc-line)', background: 'var(--blanc-surface-strong)' }}>
            {hasSecondary && (
                <div className="mb-2 relative">
                    <div className="flex items-center gap-2 text-xs">
                        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--blanc-ink-3)' }}>To</span>
                        <button type="button" onClick={() => setToDropdownOpen(!toDropdownOpen)} className="flex items-center gap-1.5 px-2 py-1 rounded-lg border hover:bg-muted/60 transition-colors" style={{ borderColor: 'var(--blanc-line)', background: 'var(--blanc-surface-muted)', color: 'var(--blanc-ink-1)' }}>
                            <span>{selectedPhone === secondaryPhone ? `${formatDisplayPhone(secondaryPhone)}${secondaryPhoneName ? ` — ${secondaryPhoneName}` : ''}` : `${formatDisplayPhone(mainPhone)} — Main number`}</span>
                            {toDropdownOpen ? <ChevronUp className="w-3 h-3" style={{ color: 'var(--blanc-ink-3)' }} /> : <ChevronDown className="w-3 h-3" style={{ color: 'var(--blanc-ink-3)' }} />}
                        </button>
                    </div>
                    {toDropdownOpen && (<><div className="fixed inset-0 z-10" onClick={() => setToDropdownOpen(false)} /><div className="absolute left-0 top-full mt-1 rounded-xl shadow-lg z-20 py-1 min-w-[260px]" style={{ background: 'var(--blanc-surface-strong)', border: '1px solid var(--blanc-line)' }}><button onClick={() => { onPhoneChange?.(mainPhone); setToDropdownOpen(false); }} className={`w-full text-left px-3 py-2 hover:bg-muted/50 text-sm flex items-center justify-between ${selectedPhone !== secondaryPhone ? 'text-primary' : ''}`} style={{ color: selectedPhone !== secondaryPhone ? 'var(--blanc-info)' : 'var(--blanc-ink-1)' }}><span>{formatDisplayPhone(mainPhone)} — Main number</span>{selectedPhone !== secondaryPhone && <span className="text-xs">✓</span>}</button><button onClick={() => { onPhoneChange?.(secondaryPhone); setToDropdownOpen(false); }} className={`w-full text-left px-3 py-2 hover:bg-muted/50 text-sm flex items-center justify-between`} style={{ color: selectedPhone === secondaryPhone ? 'var(--blanc-info)' : 'var(--blanc-ink-1)' }}><span>{formatDisplayPhone(secondaryPhone)}{secondaryPhoneName ? ` — ${secondaryPhoneName}` : ''}</span>{selectedPhone === secondaryPhone && <span className="text-xs">✓</span>}</button></div></>)}
                </div>
            )}
            {attachedFiles.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">{attachedFiles.map((file, index) => <div key={index} className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm" style={{ background: 'var(--blanc-surface-muted)', border: '1px solid var(--blanc-line)' }}><Paperclip className="w-3.5 h-3.5" style={{ color: 'var(--blanc-ink-3)' }} /><span className="max-w-[150px] truncate" style={{ color: 'var(--blanc-ink-1)' }}>{file.name}</span><span className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>({formatFileSize(file.size)})</span><button onClick={() => handleRemoveFile(index)} className="ml-1 hover:text-red-600 transition-colors" style={{ color: 'var(--blanc-ink-3)' }}><X className="w-3.5 h-3.5" /></button></div>)}</div>
            )}
            <div className="relative mb-3">
                <div aria-hidden className="absolute inset-0 px-3 py-2 pr-20 text-sm pointer-events-none overflow-hidden rounded-lg border border-transparent" style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word', color: 'transparent', lineHeight: textareaRef.current ? getComputedStyle(textareaRef.current).lineHeight : '1.5', fontFamily: textareaRef.current ? getComputedStyle(textareaRef.current).fontFamily : 'inherit' }} dangerouslySetInnerHTML={{ __html: message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{([^}]+)\}/g, '<mark style="background:#fef3c7;color:transparent;border-radius:3px;padding:1px 0">$&</mark>') + '\n' }} />
                <textarea ref={textareaRef} value={message} onChange={e => setMessage(e.target.value)} onKeyDown={handleKeyDown} placeholder="Type your message... (Cmd/Ctrl + Enter to send)" className="w-full px-3 py-2 pr-20 rounded-lg resize-none focus:outline-none focus:ring-2 focus:border-transparent text-sm" style={{ overflow: 'auto', background: 'transparent', position: 'relative', border: '1px solid var(--blanc-line-strong)', '--tw-ring-color': 'rgba(47,99,216,0.25)' } as React.CSSProperties} rows={3} disabled={disabled} />
                {/* Show char count only when > 0 */}
                {message.length > 0 && (
                    <div
                        className="absolute top-2 right-3 text-[11px] font-mono"
                        style={{ color: message.length > 300 ? 'var(--blanc-danger)' : 'var(--blanc-ink-3)' }}
                    >
                        {message.length}
                    </div>
                )}
            </div>
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <div className="relative">
                        <button
                            ref={quickBtnRef}
                            onClick={() => setIsPresetsOpen(!isPresetsOpen)}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium hover:bg-muted/60 rounded-lg transition-colors border"
                            style={{ color: 'var(--blanc-ink-2)', borderColor: 'var(--blanc-line)' }}
                            title="Quick Messages"
                        >
                            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isPresetsOpen ? 'rotate-180' : ''}`} />
                            Quick
                        </button>
                        {isPresetsOpen && (<div ref={quickDropdownRef} className="fixed w-72 rounded-xl shadow-lg z-[101] py-1 flex flex-col" style={{ background: 'var(--blanc-surface-strong)', border: '1px solid var(--blanc-line)', maxHeight: '50vh', left: quickBtnRef.current ? quickBtnRef.current.getBoundingClientRect().left : 0, bottom: quickBtnRef.current ? window.innerHeight - quickBtnRef.current.getBoundingClientRect().top + 4 : 0 }}><div className="overflow-y-auto flex-1">{quickMessages.map(qm => <button key={qm.id} onClick={() => handlePresetSelect(qm.content)} className="w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors"><div className="text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>{qm.title}</div><div className="text-xs line-clamp-1" style={{ color: 'var(--blanc-ink-3)' }}>{qm.content}</div></button>)}</div><div className="border-t my-1 flex-shrink-0" style={{ borderColor: 'var(--blanc-line)' }} /><button onClick={() => { setIsPresetsOpen(false); navigate('/settings/quick-messages'); }} className="w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors flex-shrink-0"><div className="text-sm font-medium" style={{ color: 'var(--blanc-info)' }}>+ Add New</div></button></div>)}
                    </div>
                    <button onClick={() => fileInputRef.current?.click()} className="p-1.5 hover:bg-muted/60 rounded-lg transition-colors" style={{ color: 'var(--blanc-ink-2)' }} title="Attach file"><Paperclip className="w-4 h-4" /></button>
                    <input ref={fileInputRef} type="file" multiple onChange={handleFileSelect} className="hidden" />
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={handleAiFormat} disabled={!message.trim() || isAiFormatting || !onAiFormat} className="p-1.5 hover:bg-purple-50 hover:text-purple-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed" style={{ color: 'var(--blanc-ink-2)' }} title="Format with AI"><Wand2 className={`w-4 h-4 ${isAiFormatting ? 'animate-spin' : ''}`} /></button>
                    <button
                        onClick={handleSend}
                        disabled={(!message.trim() && attachedFiles.length === 0) || disabled}
                        className="flex items-center gap-1.5 px-3.5 py-1.5 text-sm rounded-xl font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ background: 'var(--blanc-info)', color: '#fff' }}
                    >
                        <Send className="w-3.5 h-3.5" />
                        Send
                    </button>
                </div>
            </div>
        </div>
    );
}
