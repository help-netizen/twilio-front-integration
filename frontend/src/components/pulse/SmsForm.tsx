/**
 * SmsForm — SMS composition form with quick messages, file attachments,
 * AI formatting button (Wand2), character counter, ⌘+Enter to send.
 * Supports {Field Name} variable placeholders in quick messages.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Wand2, ChevronDown, Paperclip, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { authedFetch } from '../../services/apiClient';
import type { Lead } from '../../types/lead';

const API_BASE = import.meta.env.VITE_API_URL || '';

interface QuickMessage {
    id: string;
    title: string;
    content: string;
    sort_order: number;
}

interface SmsFormProps {
    onSend: (message: string, files?: File[]) => void;
    onAiFormat?: (message: string) => Promise<string>;
    disabled?: boolean;
    lead?: Lead | null;
}

const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
};

// ── Variable resolution ────────────────────────────────────────────────

/** Core lead fields mapped from display name → Lead property key */
const CORE_FIELD_MAP: Record<string, keyof Lead> = {
    'First Name': 'FirstName',
    'Last Name': 'LastName',
    'Phone': 'Phone',
    'Email': 'Email',
    'Company': 'Company',
    'Address': 'Address',
    'City': 'City',
    'State': 'State',
    'Postal Code': 'PostalCode',
    'Job Type': 'JobType',
    'Job Source': 'JobSource',
    'Description': 'Description',
    'Created Date': 'CreatedDate',
};

/**
 * Replace {Field Name} placeholders with actual lead values.
 * If lead is null or the field value is empty, the placeholder stays as-is.
 */
function resolveVariables(text: string, lead: Lead | null | undefined): string {
    if (!lead) return text;
    return text.replace(/\{([^}]+)\}/g, (_match, fieldName: string) => {
        const trimmed = fieldName.trim();
        // 1. Try core fields
        const coreKey = CORE_FIELD_MAP[trimmed];
        if (coreKey) {
            const val = lead[coreKey];
            if (val != null && String(val).trim() !== '') return String(val);
            return `{${trimmed}}`;
        }
        // 2. Try Metadata
        const metaVal = lead.Metadata?.[trimmed];
        if (metaVal != null && metaVal.trim() !== '') return metaVal;
        return `{${trimmed}}`;
    });
}

export function SmsForm({ onSend, onAiFormat, disabled, lead }: SmsFormProps) {
    const [message, setMessage] = useState('');
    const [isPresetsOpen, setIsPresetsOpen] = useState(false);
    const [isAiFormatting, setIsAiFormatting] = useState(false);
    const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Auto-resize textarea: min 3 rows, max 10 rows
    useEffect(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.style.height = 'auto';
        const lineHeight = parseInt(getComputedStyle(ta).lineHeight) || 20;
        const minH = lineHeight * 3 + 16; // 3 rows + padding
        const maxH = lineHeight * 10 + 16; // 10 rows + padding
        ta.style.height = `${Math.min(Math.max(ta.scrollHeight, minH), maxH)}px`;
    }, [message]);
    const [quickMessages, setQuickMessages] = useState<QuickMessage[]>([]);
    const navigate = useNavigate();

    const fetchQuickMessages = useCallback(async () => {
        try {
            const res = await authedFetch(`${API_BASE}/api/quick-messages`);
            const data = await res.json();
            setQuickMessages(data.messages || []);
        } catch (err) {
            console.error('Failed to load quick messages:', err);
        }
    }, []);

    useEffect(() => {
        fetchQuickMessages();
    }, [fetchQuickMessages]);

    const handleSend = () => {
        if (message.trim() || attachedFiles.length > 0) {
            onSend(message, attachedFiles);
            setMessage('');
            setAttachedFiles([]);
        }
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        setAttachedFiles(prev => [...prev, ...files]);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    const handleRemoveFile = (index: number) => {
        setAttachedFiles(prev => prev.filter((_, i) => i !== index));
    };

    const handlePresetSelect = (presetText: string) => {
        setMessage(resolveVariables(presetText, lead));
        setIsPresetsOpen(false);
    };

    const handleAiFormat = async () => {
        if (message.trim() && onAiFormat) {
            setIsAiFormatting(true);
            try {
                const formatted = await onAiFormat(message);
                setMessage(formatted);
            } catch (error) {
                console.error('AI formatting failed:', error);
            } finally {
                setIsAiFormatting(false);
            }
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="border-t border-gray-200 bg-white p-4">
            {/* Attached Files Preview */}
            {attachedFiles.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                    {attachedFiles.map((file, index) => (
                        <div
                            key={index}
                            className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 border border-gray-200 rounded-lg text-sm"
                        >
                            <Paperclip className="w-3.5 h-3.5 text-gray-500" />
                            <span className="text-gray-700 max-w-[150px] truncate">{file.name}</span>
                            <span className="text-gray-500 text-xs">({formatFileSize(file.size)})</span>
                            <button
                                onClick={() => handleRemoveFile(index)}
                                className="ml-1 text-gray-400 hover:text-red-600 transition-colors"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* Message Input Area */}
            <div className="relative mb-3">
                {/* Highlight backdrop — mirrors textarea content, highlights {variables} */}
                <div
                    aria-hidden
                    className="absolute inset-0 px-3 py-2 pr-20 text-sm pointer-events-none overflow-hidden rounded-lg border border-transparent"
                    style={{
                        whiteSpace: 'pre-wrap',
                        wordWrap: 'break-word',
                        color: 'transparent',
                        lineHeight: textareaRef.current ? getComputedStyle(textareaRef.current).lineHeight : '1.5',
                        fontFamily: textareaRef.current ? getComputedStyle(textareaRef.current).fontFamily : 'inherit',
                    }}
                    dangerouslySetInnerHTML={{
                        __html: message
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')
                            .replace(
                                /\{([^}]+)\}/g,
                                '<mark style="background:#fef3c7;color:transparent;border-radius:3px;padding:1px 0">$&</mark>'
                            ) + '\n',
                    }}
                />
                <textarea
                    ref={textareaRef}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Type your message... (Cmd/Ctrl + Enter to send)"
                    className="w-full px-3 py-2 pr-20 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    rows={3}
                    style={{ overflow: 'auto', background: 'transparent', position: 'relative' }}
                    disabled={disabled}
                />

                {/* Character Count */}
                <div className="absolute top-2 right-3 text-xs text-gray-400">
                    {message.length} characters
                </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-between gap-2">
                {/* Left Side Buttons */}
                <div className="flex items-center gap-2">
                    {/* Quick Messages Button with Dropdown */}
                    <div className="relative">
                        <button
                            onClick={() => setIsPresetsOpen(!isPresetsOpen)}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                        >
                            <ChevronDown className={`w-4 h-4 transition-transform ${isPresetsOpen ? 'rotate-180' : ''}`} />
                            <span>Quick Messages</span>
                        </button>

                        {/* Presets Menu */}
                        {isPresetsOpen && (
                            <>
                                <div
                                    className="fixed inset-0 z-10"
                                    onClick={() => setIsPresetsOpen(false)}
                                />
                                <div className="absolute left-0 bottom-full mb-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1">
                                    {quickMessages.map((qm) => (
                                        <button
                                            key={qm.id}
                                            onClick={() => handlePresetSelect(qm.content)}
                                            className="w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors"
                                        >
                                            <div className="text-sm font-medium text-gray-900">{qm.title}</div>
                                            <div className="text-xs text-gray-500 line-clamp-1">{qm.content}</div>
                                        </button>
                                    ))}

                                    <div className="border-t border-gray-200 my-1"></div>

                                    <button
                                        onClick={() => {
                                            setIsPresetsOpen(false);
                                            navigate('/settings/quick-messages');
                                        }}
                                        className="w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors"
                                    >
                                        <div className="text-sm font-medium text-blue-600">+ Add New</div>
                                    </button>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Attach File Button */}
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="p-1.5 text-gray-700 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                        title="Attach file"
                    >
                        <Paperclip className="w-4 h-4" />
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        onChange={handleFileSelect}
                        className="hidden"
                    />
                </div>

                {/* Right Side Buttons */}
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleAiFormat}
                        disabled={!message.trim() || isAiFormatting || !onAiFormat}
                        className="p-1.5 text-gray-700 hover:text-purple-600 hover:bg-purple-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Format with AI"
                    >
                        <Wand2 className={`w-4 h-4 ${isAiFormatting ? 'animate-spin' : ''}`} />
                    </button>

                    <button
                        onClick={handleSend}
                        disabled={(!message.trim() && attachedFiles.length === 0) || disabled}
                        className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Send className="w-4 h-4" />
                        <span>Send SMS</span>
                    </button>
                </div>
            </div>
        </div>
    );
}
