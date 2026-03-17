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
    const [quickMessages, setQuickMessages] = useState<QuickMessage[]>([]);
    const navigate = useNavigate();

    useEffect(() => { const ta = textareaRef.current; if (!ta) return; ta.style.height = 'auto'; const lh = parseInt(getComputedStyle(ta).lineHeight) || 20; ta.style.height = `${Math.min(Math.max(ta.scrollHeight, lh * 3 + 16), lh * 10 + 16)}px`; }, [message]);

    const fetchQuickMessages = useCallback(async () => { try { const res = await authedFetch(`${API_BASE}/api/quick-messages`); const data = await res.json(); setQuickMessages(data.messages || []); } catch (err) { console.error('Failed to load quick messages:', err); } }, []);
    useEffect(() => { fetchQuickMessages(); }, [fetchQuickMessages]);

    const handleSend = () => { if (message.trim() || attachedFiles.length > 0) { onSend(message, attachedFiles, selectedPhone); setMessage(''); setAttachedFiles([]); } };
    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => { const files = Array.from(e.target.files || []); setAttachedFiles(prev => [...prev, ...files]); if (fileInputRef.current) fileInputRef.current.value = ''; };
    const handleRemoveFile = (index: number) => { setAttachedFiles(prev => prev.filter((_, i) => i !== index)); };
    const handlePresetSelect = (presetText: string) => { setMessage(resolveVariables(presetText, lead)); setIsPresetsOpen(false); };
    const handleAiFormat = async () => { if (message.trim() && onAiFormat) { setIsAiFormatting(true); try { setMessage(await onAiFormat(message)); } catch (error) { console.error('AI formatting failed:', error); } finally { setIsAiFormatting(false); } } };
    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); } };

    const hasSecondary = !!(secondaryPhone && mainPhone && secondaryPhone !== mainPhone);

    return (
        <div className="border-t border-gray-200 bg-white p-4">
            {hasSecondary && (
                <div className="mb-2 relative">
                    <div className="flex items-center gap-2 text-xs">
                        <span className="text-gray-500 font-medium uppercase">To:</span>
                        <button type="button" onClick={() => setToDropdownOpen(!toDropdownOpen)} className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-gray-200 hover:border-gray-300 bg-gray-50 hover:bg-gray-100 transition-colors text-sm text-gray-800">
                            <span>{selectedPhone === secondaryPhone ? `${formatDisplayPhone(secondaryPhone)}${secondaryPhoneName ? ` — ${secondaryPhoneName}` : ''}` : `${formatDisplayPhone(mainPhone)} — Main number`}</span>
                            {toDropdownOpen ? <ChevronUp className="w-3 h-3 text-gray-400" /> : <ChevronDown className="w-3 h-3 text-gray-400" />}
                        </button>
                    </div>
                    {toDropdownOpen && (<><div className="fixed inset-0 z-10" onClick={() => setToDropdownOpen(false)} /><div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1 min-w-[260px]"><button onClick={() => { onPhoneChange?.(mainPhone); setToDropdownOpen(false); }} className={`w-full text-left px-3 py-2 hover:bg-gray-50 text-sm flex items-center justify-between ${selectedPhone !== secondaryPhone ? 'bg-blue-50 text-blue-700' : 'text-gray-700'}`}><span>{formatDisplayPhone(mainPhone)} — Main number</span>{selectedPhone !== secondaryPhone && <span className="text-xs">✓</span>}</button><button onClick={() => { onPhoneChange?.(secondaryPhone); setToDropdownOpen(false); }} className={`w-full text-left px-3 py-2 hover:bg-gray-50 text-sm flex items-center justify-between ${selectedPhone === secondaryPhone ? 'bg-blue-50 text-blue-700' : 'text-gray-700'}`}><span>{formatDisplayPhone(secondaryPhone)}{secondaryPhoneName ? ` — ${secondaryPhoneName}` : ''}</span>{selectedPhone === secondaryPhone && <span className="text-xs">✓</span>}</button></div></>)}
                </div>
            )}
            {attachedFiles.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">{attachedFiles.map((file, index) => <div key={index} className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 border border-gray-200 rounded-lg text-sm"><Paperclip className="w-3.5 h-3.5 text-gray-500" /><span className="text-gray-700 max-w-[150px] truncate">{file.name}</span><span className="text-gray-500 text-xs">({formatFileSize(file.size)})</span><button onClick={() => handleRemoveFile(index)} className="ml-1 text-gray-400 hover:text-red-600 transition-colors"><X className="w-3.5 h-3.5" /></button></div>)}</div>
            )}
            <div className="relative mb-3">
                <div aria-hidden className="absolute inset-0 px-3 py-2 pr-20 text-sm pointer-events-none overflow-hidden rounded-lg border border-transparent" style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word', color: 'transparent', lineHeight: textareaRef.current ? getComputedStyle(textareaRef.current).lineHeight : '1.5', fontFamily: textareaRef.current ? getComputedStyle(textareaRef.current).fontFamily : 'inherit' }} dangerouslySetInnerHTML={{ __html: message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{([^}]+)\}/g, '<mark style="background:#fef3c7;color:transparent;border-radius:3px;padding:1px 0">$&</mark>') + '\n' }} />
                <textarea ref={textareaRef} value={message} onChange={e => setMessage(e.target.value)} onKeyDown={handleKeyDown} placeholder="Type your message... (Cmd/Ctrl + Enter to send)" className="w-full px-3 py-2 pr-20 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" rows={3} style={{ overflow: 'auto', background: 'transparent', position: 'relative' }} disabled={disabled} />
                <div className="absolute top-2 right-3 text-xs text-gray-400">{message.length} characters</div>
            </div>
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <div className="relative">
                        <button onClick={() => setIsPresetsOpen(!isPresetsOpen)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"><ChevronDown className={`w-4 h-4 transition-transform ${isPresetsOpen ? 'rotate-180' : ''}`} /><span>Quick Messages</span></button>
                        {isPresetsOpen && (<><div className="fixed inset-0 z-10" onClick={() => setIsPresetsOpen(false)} /><div className="absolute left-0 bottom-full mb-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1">{quickMessages.map(qm => <button key={qm.id} onClick={() => handlePresetSelect(qm.content)} className="w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors"><div className="text-sm font-medium text-gray-900">{qm.title}</div><div className="text-xs text-gray-500 line-clamp-1">{qm.content}</div></button>)}<div className="border-t border-gray-200 my-1" /><button onClick={() => { setIsPresetsOpen(false); navigate('/settings/quick-messages'); }} className="w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors"><div className="text-sm font-medium text-blue-600">+ Add New</div></button></div></>)}
                    </div>
                    <button onClick={() => fileInputRef.current?.click()} className="p-1.5 text-gray-700 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Attach file"><Paperclip className="w-4 h-4" /></button>
                    <input ref={fileInputRef} type="file" multiple onChange={handleFileSelect} className="hidden" />
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={handleAiFormat} disabled={!message.trim() || isAiFormatting || !onAiFormat} className="p-1.5 text-gray-700 hover:text-purple-600 hover:bg-purple-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed" title="Format with AI"><Wand2 className={`w-4 h-4 ${isAiFormatting ? 'animate-spin' : ''}`} /></button>
                    <button onClick={handleSend} disabled={(!message.trim() && attachedFiles.length === 0) || disabled} className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"><Send className="w-4 h-4" /><span>Send SMS</span></button>
                </div>
            </div>
        </div>
    );
}
