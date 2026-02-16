import { useState, useRef } from 'react';
import { Send, Wand2, ChevronDown, Paperclip, X } from 'lucide-react';

interface SmsFormProps {
    onSend: (message: string, file?: File) => void;
    disabled?: boolean;
}

const MESSAGE_PRESETS = [
    { id: 'follow-up', label: 'Follow-up', text: 'Hi! Just following up on our previous conversation. Let me know if you have any questions.' },
    { id: 'thank-you', label: 'Thank You', text: 'Thank you for your time today! Looking forward to speaking with you again soon.' },
    { id: 'meeting', label: 'Schedule Meeting', text: 'Would you be available for a quick call this week? Let me know what time works best for you.' },
    { id: 'info', label: 'Send Info', text: "As promised, here's the information we discussed. Feel free to reach out if you need anything else." },
];

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SmsForm({ onSend, disabled }: SmsFormProps) {
    const [message, setMessage] = useState('');
    const [isPresetsOpen, setIsPresetsOpen] = useState(false);
    const [isSending, setIsSending] = useState(false);
    const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const canSend = (message.trim() || attachedFiles.length > 0) && !disabled && !isSending;

    // ── Handlers ────────────────────────────────────────────────────────────

    const handleSend = async () => {
        if (!canSend) return;
        setIsSending(true);
        try {
            await onSend(message, attachedFiles[0]);
            setMessage('');
            setAttachedFiles([]);
        } finally {
            setIsSending(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSend();
        }
    };

    const handlePresetSelect = (text: string) => {
        setMessage(text);
        setIsPresetsOpen(false);
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            setAttachedFiles(prev => [...prev, ...Array.from(e.target.files!)]);
        }
        e.target.value = '';
    };

    const handleRemoveFile = (index: number) => {
        setAttachedFiles(prev => prev.filter((_, i) => i !== index));
    };

    // ── Render ──────────────────────────────────────────────────────────────

    return (
        <div className="border-t border-gray-200 bg-white p-4">
            {/* Attached file chips */}
            {attachedFiles.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                    {attachedFiles.map((file, i) => (
                        <div
                            key={i}
                            className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 border border-gray-200 rounded-lg text-sm"
                        >
                            <Paperclip className="w-3.5 h-3.5 text-gray-500" />
                            <span className="text-gray-700 max-w-[150px] truncate">{file.name}</span>
                            <span className="text-gray-500 text-xs">({formatFileSize(file.size)})</span>
                            <button
                                onClick={() => handleRemoveFile(i)}
                                className="ml-1 text-gray-400 hover:text-red-600 transition-colors"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* Textarea */}
            <div className="relative mb-3">
                <textarea
                    rows={3}
                    placeholder="Type your message... (⌘ + Enter to send)"
                    value={message}
                    onChange={e => setMessage(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={disabled || isSending}
                    className="w-full px-3 py-2 pr-20 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                />
                <span className="absolute bottom-2 left-3 text-xs text-gray-400">
                    {message.length} characters
                </span>
            </div>

            {/* Action buttons */}
            <div className="flex items-center justify-between gap-2">
                {/* Left: Quick Messages + Attach */}
                <div className="flex items-center gap-2 relative">
                    <button
                        onClick={() => setIsPresetsOpen(!isPresetsOpen)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                    >
                        <ChevronDown
                            className="w-4 h-4 transition-transform"
                            style={{ transform: isPresetsOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
                        />
                        Quick Messages
                    </button>

                    {/* Presets dropdown */}
                    {isPresetsOpen && (
                        <>
                            {/* Backdrop */}
                            <div className="fixed inset-0 z-10" onClick={() => setIsPresetsOpen(false)} />
                            <div className="absolute left-0 bottom-full mb-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1">
                                {MESSAGE_PRESETS.map(p => (
                                    <button
                                        key={p.id}
                                        onClick={() => handlePresetSelect(p.text)}
                                        className="w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors"
                                    >
                                        <div className="text-sm font-medium text-gray-900">{p.label}</div>
                                        <div className="text-xs text-gray-500 line-clamp-1">{p.text}</div>
                                    </button>
                                ))}
                            </div>
                        </>
                    )}

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
                        className="hidden"
                        onChange={handleFileSelect}
                    />
                </div>

                {/* Right: Send */}
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleSend}
                        disabled={!canSend}
                        className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Send className="w-4 h-4" />
                        {isSending ? 'Sending...' : 'Send SMS'}
                    </button>
                </div>
            </div>
        </div>
    );
}
