import { useRef, type ChangeEvent } from 'react';
import { Paperclip, X, FileText, Image as ImageIcon } from 'lucide-react';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 5;
const ACCEPT = 'image/*,application/pdf,.doc,.docx,.xls,.xlsx';

interface NoteAttachmentInputProps {
    files: File[];
    onChange: (files: File[]) => void;
    compact?: boolean;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(file: File): boolean {
    return file.type.startsWith('image/');
}

export function NoteAttachmentInput({ files, onChange, compact }: NoteAttachmentInputProps) {
    const inputRef = useRef<HTMLInputElement>(null);

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        const selected = Array.from(e.target.files || []);
        const totalFiles = [...files, ...selected].slice(0, MAX_FILES);

        const valid = totalFiles.filter(f => {
            if (f.size > MAX_FILE_SIZE) {
                console.warn(`[Attachments] File "${f.name}" too large (${formatSize(f.size)})`);
                return false;
            }
            return true;
        });

        onChange(valid);
        if (inputRef.current) inputRef.current.value = '';
    };

    const removeFile = (index: number) => {
        onChange(files.filter((_, i) => i !== index));
    };

    return (
        <div>
            <input
                ref={inputRef}
                type="file"
                multiple
                accept={ACCEPT}
                onChange={handleChange}
                className="hidden"
            />

            <button
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={() => inputRef.current?.click()}
                disabled={files.length >= MAX_FILES}
                className="inline-flex items-center gap-1 text-xs transition-opacity hover:opacity-70 disabled:opacity-30"
                style={{ color: 'var(--blanc-ink-3)' }}
                title="Attach files"
            >
                <Paperclip className="size-3.5" />
                {!compact && <span>Attach</span>}
            </button>

            {files.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                    {files.map((file, i) => (
                        <div
                            key={`${file.name}-${i}`}
                            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs"
                            style={{
                                background: 'rgba(117,106,89,0.06)',
                                border: '1px solid var(--blanc-line)',
                                color: 'var(--blanc-ink-2)',
                            }}
                        >
                            {isImage(file)
                                ? <ImageIcon className="size-3 shrink-0" />
                                : <FileText className="size-3 shrink-0" />
                            }
                            <span className="max-w-[120px] truncate">{file.name}</span>
                            <span className="text-[10px]" style={{ color: 'var(--blanc-ink-3)' }}>
                                {formatSize(file.size)}
                            </span>
                            <button
                                type="button"
                                onMouseDown={e => e.preventDefault()}
                                onClick={() => removeFile(i)}
                                className="hover:opacity-70"
                                style={{ color: 'var(--blanc-ink-3)' }}
                            >
                                <X className="size-3" />
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
