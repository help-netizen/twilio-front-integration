# Timeline Column - Complete Technical Specification

> **Detailed implementation guide for reproducing the Timeline column functionality**

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Complete Component Code](#complete-component-code)
3. [Visual Specifications](#visual-specifications)
4. [State Management](#state-management)
5. [Styling Reference](#styling-reference)
6. [Implementation Checklist](#implementation-checklist)

---

## Architecture Overview

### Column Structure

```
┌─────────────────────────────────────────┐
│ HEADER (Fixed)                          │
│ ┌─────────────────────────────────────┐ │
│ │ Timeline        [Export Components] │ │
│ └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│ SCROLLABLE CONTENT (flex-1)             │
│ ┌─────────────────────────────────────┐ │
│ │  Date Separator: "February 7, 2026" │ │
│ ├─────────────────────────────────────┤ │
│ │  Call Item (Incoming, Failed)       │ │
│ ├─────────────────────────────────────┤ │
│ │  Call Item (Outgoing, No Answer)    │ │
│ ├─────────────────────────────────────┤ │
│ │  Date Separator: "February 8, 2026" │ │
│ ├─────────────────────────────────────┤ │
│ │  SMS Item (Outgoing)                │ │
│ ├─────────────────────────────────────┤ │
│ │  SMS Item (Incoming with media)     │ │
│ │  ...                                │ │
│ └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│ SMS FORM (Fixed Bottom)                 │
│ ┌─────────────────────────────────────┐ │
│ │ File Preview Area                   │ │
│ │ Textarea (3 rows)                   │ │
│ │ [Quick] [Attach] [AI] [Send SMS]   │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### Layout Implementation

```tsx
<div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
  {/* Header - Fixed */}
  <div className="flex-shrink-0 bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
    <h2 className="text-lg font-semibold text-gray-900">Timeline</h2>
    <button onClick={handleExportComponents} className="...">
      <Download className="w-4 h-4" />
      <span>Export Components</span>
    </button>
  </div>

  {/* Scrollable Content - flex-1 */}
  <div className="flex-1 overflow-y-auto" ref={callsContainerRef}>
    <div className="p-6 space-y-4">
      {/* Timeline items render here */}
    </div>
  </div>

  {/* SMS Form - Fixed Bottom */}
  <div className="flex-shrink-0">
    <SmsForm onSend={...} onAiFormat={...} />
  </div>
</div>
```

---

## Complete Component Code

### 1. DateSeparator Component

**File**: `/src/app/components/date-separator.tsx`

```tsx
interface DateSeparatorProps {
  date: string;
}

export function DateSeparator({ date }: DateSeparatorProps) {
  return (
    <div className="flex items-center justify-center my-6">
      <div className="bg-gray-200 text-gray-600 px-4 py-1.5 rounded-full text-xs font-medium shadow-sm">
        {date}
      </div>
    </div>
  );
}
```

**Visual Breakdown**:
```
┌─────────────────────────────────────────┐
│                                         │
│        ╭───────────────────────╮        │  ← my-6 (24px top/bottom)
│        │  February 9, 2026     │        │  ← bg-gray-200, rounded-full
│        ╰───────────────────────╯        │  ← px-4 py-1.5, text-xs
│                                         │
└─────────────────────────────────────────┘
```

---

### 2. CallListItem Component (Detailed)

**File**: `/src/app/components/call-list-item.tsx`

#### Structure Breakdown

```
╔═══════════════════════════════════════════════════════════╗
║ CARD (border border-gray-200 hover:shadow-md)            ║
║ ┌─────────────────────────────────────────────────────┐ ║
║ │ HEADER (p-4 pb-0)                                   │ ║
║ │ [Icon] +1(508)290-4442    Feb 9, 2026, 9:15 AM [⚙] │ ║
║ └─────────────────────────────────────────────────────┘ ║
║ ┌─────────────────────────────────────────────────────┐ ║
║ │ AUDIO PLAYER (bg-white px-4 pb-4)                   │ ║
║ │ [Summary] [Transcript]  [◄10] [▶] [10►]  01:23/03:45│ ║
║ │ ─────────────────────────────────────────────────── │ ║ ← Slider
║ │                                                     │ ║
║ │ {Active Section Content}                           │ ║
║ └─────────────────────────────────────────────────────┘ ║
║ ┌─────────────────────────────────────────────────────┐ ║
║ │ SYSTEM INFO (bg-gray-50 p-4 pt-0) - Collapsible    │ ║
║ │ Duration: 4m 5s                                     │ ║
║ │ Talk: 3m 50s                                        │ ║
║ │ Wait: 15s                                           │ ║
║ │ Cost: $0.0250 USD                                   │ ║
║ │ Call SID: CA5e37798268a2d9a269249468cd971906       │ ║
║ └─────────────────────────────────────────────────────┘ ║
╚═══════════════════════════════════════════════════════════╝
```

#### Header Section (Exact Implementation)

```tsx
{/* Main Call Info */}
<div className="p-4 pb-0">
  <div className="flex items-center gap-3">
    {/* Direction Icon with Status Color */}
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={`flex items-center justify-center w-9 h-9 rounded-full border ${getStatusColor(call.status)}`}>
            {call.direction === 'incoming' ? (
              <PhoneIncoming className="w-4 h-4" />
            ) : (
              <PhoneOutgoing className="w-4 h-4" />
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>{directionLabel} - {call.status.replace('-', ' ').charAt(0).toUpperCase() + call.status.replace('-', ' ').slice(1)}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>

    {/* Phone Number */}
    <p className="text-xs text-gray-600 font-mono">{otherPartyNumber}</p>

    {/* Spacer */}
    <div className="flex-1" />

    {/* Date */}
    <div className="text-xs text-gray-500">
      {formatTime(call.startTime)}
    </div>

    {/* System Info Toggle */}
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowSystemInfo(!showSystemInfo)}
            className="h-6 w-6 hover:bg-gray-100"
          >
            <Settings2 className={`w-4 h-4 transition-transform ${showSystemInfo ? 'rotate-90' : ''}`} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>System Information</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
</div>
```

**Status Colors Function**:
```tsx
const getStatusColor = (status: string) => {
  switch (status) {
    case 'completed':
      return 'bg-green-500/10 text-green-700 border-green-200';
    case 'no-answer':
      return 'bg-yellow-500/10 text-yellow-700 border-yellow-200';
    case 'busy':
      return 'bg-orange-500/10 text-orange-700 border-orange-200';
    case 'failed':
      return 'bg-red-500/10 text-red-700 border-red-200';
    default:
      return 'bg-gray-500/10 text-gray-700 border-gray-200';
  }
};
```

#### Audio Player Section (Exact Implementation)

```tsx
{call.audioUrl && (
  <div className="px-4 pb-4 bg-white">
    <audio ref={audioRef} src={call.audioUrl} />
    
    <div className="space-y-3">
      {/* Action buttons and Controls in one row */}
      <div className="flex items-center gap-3">
        {/* Summary and Transcription buttons on the left */}
        <div className="flex items-center gap-3 shrink-0">
          {call.summary && (
            <button
              onClick={() => setActiveSection(activeSection === 'summary' ? null : 'summary')}
              className={`text-xs transition-colors ${
                activeSection === 'summary' 
                  ? 'text-gray-700 border-b-2 border-gray-700' 
                  : 'text-gray-500 border-b border-dashed border-gray-400 hover:text-gray-700 hover:border-gray-600'
              }`}
            >
              Summary
            </button>
          )}
          
          {call.transcription && (
            <button
              onClick={() => setActiveSection(activeSection === 'transcription' ? null : 'transcription')}
              className={`text-xs transition-colors ${
                activeSection === 'transcription' 
                  ? 'text-gray-700 border-b-2 border-gray-700' 
                  : 'text-gray-500 border-b border-dashed border-gray-400 hover:text-gray-700 hover:border-gray-600'
              }`}
            >
              Transcript
            </button>
          )}
        </div>

        {/* Audio Controls */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => handleSkip(-10)}
            title="Rewind 10 seconds"
            className="h-7 w-7 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors relative"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span className="absolute text-[9px] font-semibold">10</span>
          </button>
          
          <button
            onClick={handlePlayPause}
            className="h-7 w-7 flex items-center justify-center text-gray-500 hover:text-gray-700 transition-colors"
          >
            {isPlaying ? (
              <Pause className="w-3.5 h-3.5" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
          </button>
          
          <button
            onClick={() => handleSkip(10)}
            title="Forward 10 seconds"
            className="h-7 w-7 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors relative"
          >
            <RotateCw className="w-3.5 h-3.5" />
            <span className="absolute text-[9px] font-semibold">10</span>
          </button>
        </div>

        {/* Time Display */}
        <div className="flex items-center">
          <span className="text-xs text-gray-500 font-mono">
            {formatAudioTime(currentTime)} / {formatAudioTime(duration)}
          </span>
        </div>
      </div>

      {/* Summary - Show only when active */}
      {activeSection === 'summary' && call.summary && (
        <div className="pt-2">
          <p className="text-sm text-gray-700 leading-relaxed">
            {call.summary}
          </p>
        </div>
      )}

      {/* Transcription - Show only when active */}
      {activeSection === 'transcription' && call.transcription && (
        <div className="pt-2">
          <ScrollArea className="h-48 bg-gray-50 p-3 rounded-md">
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
              {call.transcription}
            </p>
          </ScrollArea>
        </div>
      )}
    </div>
  </div>
)}
```

**Audio Controls Visual**:
```
┌────────────────────────────────────────────────────────┐
│ [Summary] [Transcript]   [◄10] [▶] [10►]   01:23/03:45│
│  └─ tabs with underline   └─ audio controls  └─ time  │
│                                                        │
│  Active:   border-b-2 border-gray-700                 │
│  Inactive: border-b border-dashed border-gray-400     │
└────────────────────────────────────────────────────────┘
```

#### System Information Section

```tsx
{showSystemInfo && (
  <div className="p-4 pt-0 space-y-2 text-sm bg-gray-50">
    <div className="flex items-center gap-2">
      <Clock className="w-4 h-4 text-gray-400" />
      <span className="text-gray-600">Duration:</span>
      <span className="font-mono text-gray-900">
        {formatDuration(call.totalDuration || call.duration)}
      </span>
    </div>

    {call.talkTime !== undefined && (
      <div className="flex items-center gap-2">
        <Timer className="w-4 h-4 text-gray-400" />
        <span className="text-gray-600">Talk:</span>
        <span className="font-mono text-gray-900">
          {formatDuration(call.talkTime)}
        </span>
      </div>
    )}
    
    {call.waitTime !== undefined && (
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-gray-400" />
        <span className="text-gray-600">Wait:</span>
        <span className="font-mono text-gray-900">
          {formatDuration(call.waitTime)}
        </span>
      </div>
    )}

    {call.cost !== undefined && (
      <div className="flex items-center gap-2">
        <DollarSign className="w-4 h-4 text-gray-400" />
        <span className="text-gray-600">Cost:</span>
        <span className="font-mono text-gray-900">
          ${call.cost.toFixed(4)} USD
        </span>
      </div>
    )}
    
    <div className="flex items-center gap-2">
      <Hash className="w-4 h-4 text-gray-400" />
      <span className="text-gray-600">Call SID:</span>
      <code className="text-xs bg-gray-200 px-2 py-1 rounded font-mono text-gray-800">
        {call.callSid}
      </code>
    </div>
    
    <div className="flex items-center gap-2">
      <Clock className="w-4 h-4 text-gray-400" />
      <span className="text-gray-600">Queue Time:</span>
      <span className="font-mono text-gray-900">{call.queueTime}s</span>
    </div>
    
    <div className="flex items-center gap-2">
      <Navigation className="w-4 h-4 text-gray-400" />
      <span className="text-gray-600">Twilio Direction:</span>
      <span className="font-mono text-gray-900">{call.twilioDirection}</span>
    </div>
  </div>
)}
```

**System Info Visual**:
```
┌────────────────────────────────────────┐
│ bg-gray-50, p-4 pt-0, space-y-2       │
│ ┌────────────────────────────────────┐ │
│ │ [🕐] Duration: 4m 5s               │ │
│ │ [⏱] Talk: 3m 50s                   │ │
│ │ [🕐] Wait: 15s                     │ │
│ │ [$] Cost: $0.0250 USD              │ │
│ │ [#] Call SID: CA5e37...            │ │
│ │ [🕐] Queue Time: 3s                │ │
│ │ [➤] Twilio Direction: inbound      │ │
│ └────────────────────────────────────┘ │
└────────────────────────────────────────┘
```

---

### 3. SmsListItem Component

**File**: `/src/app/components/sms-list-item.tsx`

#### Message Bubble Layout

```
OUTGOING (Right-aligned):
                    ┌──────────────────────────┐
                    │ bg-blue-600, text-white  │
                    │ border-blue-700          │
                    │ ┌──────────────────────┐ │
                    │ │ [📧] +1(617)500-6181 │ │  ← Header
                    │ │              [✓✓]    │ │  ← Status
                    │ └──────────────────────┘ │
                    │                          │
                    │ Message text here...     │  ← Text (if any)
                    │                          │
                    │ Feb 9, 2026, 9:15 AM    │  ← Timestamp
                    └──────────────────────────┘
                    max-w-[80%]

INCOMING (Left-aligned):
┌──────────────────────────┐
│ bg-white, text-gray-900  │
│ border-gray-200          │
│ ┌──────────────────────┐ │
│ │ [📧] +1(508)290-4442 │ │  ← Header
│ └──────────────────────┘ │
│                          │
│ Message text here...     │  ← Text (if any)
│                          │
│ Feb 9, 2026, 9:15 AM    │  ← Timestamp
└──────────────────────────┘
max-w-[80%]
```

#### Complete Implementation

```tsx
export function SmsListItem({ sms }: SmsListItemProps) {
  const isOutgoing = sms.direction === 'outgoing';
  const hasMedia = sms.media && sms.media.length > 0;
  const hasMessage = sms.message && sms.message.trim().length > 0;
  
  const formatTime = (date: Date) => {
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const isImage = (contentType: string) => {
    return contentType.startsWith('image/');
  };

  const handleDownload = (media: MediaAttachment) => {
    const link = document.createElement('a');
    link.href = media.url;
    link.download = media.filename;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className={`flex ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
      <Card 
        className={`max-w-[80%] overflow-hidden border ${
          isOutgoing 
            ? 'bg-blue-600 text-white border-blue-700' 
            : 'bg-white text-gray-900 border-gray-200'
        }`}
      >
        <div className={hasMedia && !hasMessage ? 'p-2' : 'p-4'}>
          {/* Header - only show if there's a text message or it's a media-only with status */}
          {(hasMessage || (hasMedia && isOutgoing)) && (
            <div className="flex items-center gap-2 mb-2">
              <MessageSquare className={`w-4 h-4 ${isOutgoing ? 'text-blue-200' : 'text-gray-400'}`} />
              <span className={`text-xs font-mono ${isOutgoing ? 'text-blue-100' : 'text-gray-500'}`}>
                {isOutgoing ? sms.to : sms.from}
              </span>
              {isOutgoing && (
                <span className={`ml-auto ${
                  sms.status === 'delivered' ? 'text-blue-200' : 
                  sms.status === 'sent' ? 'text-blue-300' : 
                  'text-red-300'
                }`}>
                  {sms.status === 'delivered' ? (
                    <CheckCheck className="w-3.5 h-3.5" />
                  ) : sms.status === 'sent' ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    <X className="w-3.5 h-3.5" />
                  )}
                </span>
              )}
            </div>
          )}

          {/* Media Attachments */}
          {hasMedia && (
            <div className={hasMessage ? 'mb-3 space-y-2' : 'space-y-2'}>
              {sms.media!.map((media) => (
                <div key={media.id}>
                  {isImage(media.contentType) ? (
                    // Image preview with download button
                    <div className="relative group">
                      <img
                        src={media.url}
                        alt={media.filename}
                        className="w-full rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                        onClick={() => handleDownload(media)}
                      />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDownload(media);
                        }}
                        className={`absolute top-2 right-2 p-2 rounded-full shadow-lg transition-opacity opacity-0 group-hover:opacity-100 ${
                          isOutgoing ? 'bg-blue-700 hover:bg-blue-800' : 'bg-gray-800 hover:bg-gray-900'
                        }`}
                        title="Download"
                      >
                        <Download className="w-4 h-4 text-white" />
                      </button>
                      <div className={`absolute bottom-2 left-2 px-2 py-1 rounded text-xs ${
                        isOutgoing ? 'bg-blue-700/90' : 'bg-gray-800/90'
                      } text-white`}>
                        {formatFileSize(media.size)}
                      </div>
                    </div>
                  ) : (
                    // Non-image file with download
                    <button
                      onClick={() => handleDownload(media)}
                      className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                        isOutgoing 
                          ? 'bg-blue-700 border-blue-800 hover:bg-blue-800' 
                          : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                      }`}
                    >
                      <div className={`p-2 rounded ${
                        isOutgoing ? 'bg-blue-800' : 'bg-gray-200'
                      }`}>
                        {media.contentType.includes('pdf') ? (
                          <FileText className={`w-5 h-5 ${isOutgoing ? 'text-blue-200' : 'text-red-600'}`} />
                        ) : (
                          <FileIcon className={`w-5 h-5 ${isOutgoing ? 'text-blue-200' : 'text-gray-600'}`} />
                        )}
                      </div>
                      <div className="flex-1 text-left">
                        <div className={`text-sm font-medium truncate ${
                          isOutgoing ? 'text-white' : 'text-gray-900'
                        }`}>
                          {media.filename}
                        </div>
                        <div className={`text-xs ${
                          isOutgoing ? 'text-blue-200' : 'text-gray-500'
                        }`}>
                          {formatFileSize(media.size)}
                        </div>
                      </div>
                      <Download className={`w-4 h-4 flex-shrink-0 ${
                        isOutgoing ? 'text-blue-200' : 'text-gray-400'
                      }`} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Message */}
          {hasMessage && (
            <p className={`text-sm leading-relaxed mb-2 ${isOutgoing ? 'text-white' : 'text-gray-700'}`}>
              {sms.message}
            </p>
          )}

          {/* Timestamp - hide for media-only messages */}
          {hasMessage && (
            <div className={`text-xs ${isOutgoing ? 'text-blue-200' : 'text-gray-500'} text-right`}>
              {formatTime(sms.timestamp)}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
```

#### Media Attachment Visual Details

**Image Preview**:
```
┌─────────────────────────────────────┐
│ relative group                      │
│ ┌─────────────────────────────────┐ │
│ │                                 │ │
│ │  [IMAGE]                    [⬇] │ │ ← Download button (opacity-0 group-hover:opacity-100)
│ │                                 │ │
│ │  [2.4 MB]                       │ │ ← Size badge (bottom-2 left-2)
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
  rounded-lg, cursor-pointer, hover:opacity-90
```

**Document Button**:
```
┌─────────────────────────────────────────────────┐
│ flex items-center gap-3 p-3 rounded-lg         │
│ ┌───────┐                                      │
│ │ [📄] │  invoice-2026-02.pdf        [⬇]      │
│ │ p-2  │  524 KB                               │
│ └───────┘                                      │
└─────────────────────────────────────────────────┘
  bg-gray-50 (incoming) or bg-blue-700 (outgoing)
```

---

### 4. SmsForm Component

**File**: `/src/app/components/sms-form.tsx`

#### Complete Layout Visual

```
┌──────────────────────────────────────────────────────────────┐
│ border-t border-gray-200 bg-white p-4                        │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ FILE PREVIEW AREA (mb-3, flex flex-wrap gap-2)          │ │
│ │ [📎 file1.pdf (524 KB) ✕] [📎 image.jpg (2.4 MB) ✕]   │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ TEXTAREA (relative mb-3)                                 │ │
│ │ ┌────────────────────────────────────────────────────┐   │ │
│ │ │ Type your message... (Cmd/Ctrl + Enter to send)    │   │ │
│ │ │                                                     │   │ │
│ │ │                                                     │   │ │
│ │ │ 123 characters                                      │   │ │ ← bottom-2 left-3
│ │ └────────────────────────────────────────────────────┘   │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ ACTION BUTTONS (flex justify-between gap-2)             │ │
│ │ [▼ Quick Messages] [📎]         [✨] [Send SMS ➤]     │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

#### Complete Implementation

```tsx
const MESSAGE_PRESETS = [
  { id: 'follow-up', label: 'Follow-up', text: 'Hi! Just following up on our previous conversation. Let me know if you have any questions.' },
  { id: 'thank-you', label: 'Thank You', text: 'Thank you for your time today! Looking forward to speaking with you again soon.' },
  { id: 'meeting', label: 'Schedule Meeting', text: 'Would you be available for a quick call this week? Let me know what time works best for you.' },
  { id: 'info', label: 'Send Info', text: 'As promised, here\'s the information we discussed. Feel free to reach out if you need anything else.' },
];

export function SmsForm({ onSend, onAiFormat }: SmsFormProps) {
  const [message, setMessage] = useState('');
  const [isPresetsOpen, setIsPresetsOpen] = useState(false);
  const [isAiFormatting, setIsAiFormatting] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const handlePresetSelect = (presetText: string) => {
    setMessage(presetText);
    setIsPresetsOpen(false);
  };

  const handleAiFormat = async () => {
    if (message.trim()) {
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
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your message... (Cmd/Ctrl + Enter to send)"
          className="w-full px-3 py-2 pr-20 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
          rows={3}
        />
        
        {/* Character Count */}
        <div className="absolute bottom-2 left-3 text-xs text-gray-400">
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
                  {MESSAGE_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      onClick={() => handlePresetSelect(preset.text)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors"
                    >
                      <div className="text-sm font-medium text-gray-900">{preset.label}</div>
                      <div className="text-xs text-gray-500 line-clamp-1">{preset.text}</div>
                    </button>
                  ))}
                  
                  <div className="border-t border-gray-200 my-1"></div>
                  
                  <button
                    onClick={() => {
                      setIsPresetsOpen(false);
                      // Logic for creating new preset
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
            disabled={!message.trim() || isAiFormatting}
            className="p-1.5 text-gray-700 hover:text-purple-600 hover:bg-purple-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Format with AI"
          >
            <Wand2 className={`w-4 h-4 ${isAiFormatting ? 'animate-spin' : ''}`} />
          </button>
          
          <button
            onClick={handleSend}
            disabled={!message.trim() && attachedFiles.length === 0}
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
```

#### Quick Messages Dropdown Visual

```
                  ┌────────────────────────────────┐
                  │ w-64, bg-white, border         │
                  │ absolute left-0 bottom-full    │
                  │ shadow-lg, rounded-lg          │
                  ├────────────────────────────────┤
                  │ Follow-up                      │
                  │ Hi! Just following up on...    │ ← hover:bg-gray-50
                  ├────────────────────────────────┤
                  │ Thank You                      │
                  │ Thank you for your time...     │
                  ├────────────────────────────────┤
                  │ Schedule Meeting               │
                  │ Would you be available...      │
                  ├────────────────────────────────┤
                  │ Send Info                      │
                  │ As promised, here's...         │
                  ├────────────────────────────────┤
                  │ + Add New                      │ ← text-blue-600
                  └────────────────────────────────┘
[▼ Quick Messages]
```

---

## Visual Specifications

### Color Palette

```yaml
Primary Colors:
  - Blue-50: #EFF6FF    (hover backgrounds)
  - Blue-100: #DBEAFE   (light accents)
  - Blue-200: #BFDBFE   (text on blue bg)
  - Blue-600: #2563EB   (primary buttons, outgoing SMS)
  - Blue-700: #1D4ED8   (hover states)
  - Blue-800: #1E40AF   (dark accents)

Status Colors:
  - Green-100: #DCFCE7  (success bg)
  - Green-200: #BBF7D0  (success border)
  - Green-500: #22C55E  (success)
  - Green-700: #15803D  (success text)
  
  - Yellow-100: #FEF3C7 (warning bg)
  - Yellow-200: #FDE68A (warning border)
  - Yellow-500: #EAB308 (warning)
  - Yellow-700: #A16207 (warning text)
  
  - Orange-100: #FFEDD5 (busy bg)
  - Orange-200: #FED7AA (busy border)
  - Orange-500: #F97316 (busy)
  - Orange-700: #C2410C (busy text)
  
  - Red-100: #FEE2E2   (error bg)
  - Red-200: #FECACA   (error border)
  - Red-300: #FCA5A5   (light error)
  - Red-600: #DC2626   (error)
  - Red-800: #991B1B   (error text)

Neutral Colors:
  - Gray-50: #F9FAFB    (light bg)
  - Gray-100: #F3F4F6   (elements bg)
  - Gray-200: #E5E7EB   (borders, date separator)
  - Gray-300: #D1D5DB   (input borders)
  - Gray-400: #9CA3AF   (icons, secondary text)
  - Gray-500: #6B7280   (labels)
  - Gray-600: #4B5563   (text)
  - Gray-700: #374151   (dark text)
  - Gray-800: #1F2937   (darker text)
  - Gray-900: #111827   (primary text)
  - White: #FFFFFF      (card backgrounds)
```

### Typography

```yaml
Font Sizes:
  - text-xs: 12px (0.75rem)    - timestamps, labels, captions
  - text-sm: 14px (0.875rem)   - body text, buttons
  - text-base: 16px (1rem)     - default
  - text-lg: 18px (1.125rem)   - headings

Font Weights:
  - font-normal: 400           - body text
  - font-medium: 500           - labels, semi-emphasis
  - font-semibold: 600         - headings
  - font-bold: 700             - strong emphasis

Font Families:
  - font-sans: System default  - all text
  - font-mono: Monospace       - phone numbers, time, code
```

### Spacing

```yaml
Padding:
  - p-2: 8px       - tight spacing (media-only SMS)
  - p-3: 12px      - compact (scroll areas)
  - p-4: 16px      - standard (cards, form)
  - p-6: 24px      - spacious (timeline container)
  
  - px-3: 12px horizontal  - buttons, inputs
  - py-1.5: 6px vertical   - buttons
  - py-2: 8px vertical     - inputs

Margins:
  - mb-2: 8px      - small gaps
  - mb-3: 12px     - medium gaps
  - my-6: 24px vertical - date separator

Gaps:
  - gap-1: 4px     - tight flex gaps
  - gap-2: 8px     - standard flex gaps
  - gap-3: 12px    - loose flex gaps
  - space-y-2: 8px vertical children
  - space-y-3: 12px vertical children
  - space-y-4: 16px vertical children
```

### Border Radius

```yaml
Borders:
  - rounded: 4px          - default
  - rounded-md: 6px       - medium
  - rounded-lg: 8px       - large (cards, inputs, buttons)
  - rounded-full: 9999px  - circles (date separator, status icon)
```

### Shadows

```yaml
Shadows:
  - shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05)         - subtle
  - shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1)             - default
  - shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1)       - cards hover
  - shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1)     - dropdown
```

### Icons

```yaml
Icon Sizes:
  - w-3.5 h-3.5: 14px  - small buttons (audio controls, file chips)
  - w-4 h-4: 16px      - standard icons (buttons, indicators)
  - w-5 h-5: 20px      - larger icons (file type icons)
  - w-9 h-9: 36px      - large circular backgrounds (status icon)

Icon Colors:
  - text-gray-400: secondary icons
  - text-gray-500: standard icons
  - text-gray-600: emphasized icons
  - text-blue-200: icons on blue bg
  - text-blue-600: primary action icons
  - text-red-600: delete/error icons
```

---

## State Management

### Call List Item States

```typescript
// Local state
const [showSystemInfo, setShowSystemInfo] = useState(false);
const [activeSection, setActiveSection] = useState<'summary' | 'transcription' | null>(() => {
  // Show summary by default for completed calls with summary
  if (call.status === 'completed' && call.summary) {
    return 'summary';
  }
  return null;
});

// Audio player state
const [isPlaying, setIsPlaying] = useState(false);
const [currentTime, setCurrentTime] = useState(0);
const [duration, setDuration] = useState(0);
const audioRef = useRef<HTMLAudioElement>(null);
```

**State Transitions**:
```
showSystemInfo: false ←→ true (toggle on Settings icon click)
activeSection: null ←→ 'summary' ←→ 'transcription' (toggle on tab click)
isPlaying: false ←→ true (toggle on play/pause)
currentTime: 0 → duration (updates during playback every 100ms)
```

### SMS Form States

```typescript
const [message, setMessage] = useState('');
const [isPresetsOpen, setIsPresetsOpen] = useState(false);
const [isAiFormatting, setIsAiFormatting] = useState(false);
const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
const fileInputRef = useRef<HTMLInputElement>(null);
```

**State Transitions**:
```
message: '' ←→ 'user input' ←→ '' (on send)
isPresetsOpen: false ←→ true (toggle dropdown)
isAiFormatting: false → true → false (during AI request)
attachedFiles: [] ←→ [File, File, ...] (add/remove files)
```

### Timeline Assembly Logic

```typescript
// Combine calls and SMS into timeline
const timeline: TimelineItem[] = (() => {
  const items: TimelineItem[] = [
    ...mockCalls.map(call => ({ 
      type: 'call' as const, 
      data: call, 
      timestamp: call.startTime 
    })),
    // Split SMS with both media and text into separate messages
    ...mockSms.flatMap(sms => {
      if (sms.media && sms.media.length > 0 && sms.message) {
        // Split into two messages: media first, then text
        return [
          { 
            type: 'sms' as const, 
            data: { ...sms, message: '', id: `${sms.id}-media` }, 
            timestamp: sms.timestamp 
          },
          { 
            type: 'sms' as const, 
            data: { ...sms, media: undefined, id: `${sms.id}-text` }, 
            timestamp: new Date(sms.timestamp.getTime() + 100) // 100ms later
          }
        ];
      }
      return [{ type: 'sms' as const, data: sms, timestamp: sms.timestamp }];
    })
  ].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // Insert date separators
  const withSeparators: TimelineItem[] = [];
  let lastDate = '';

  items.forEach((item) => {
    const currentDate = item.timestamp.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });

    if (currentDate !== lastDate) {
      withSeparators.push({
        type: 'date-separator',
        date: currentDate,
        timestamp: item.timestamp
      });
      lastDate = currentDate;
    }

    withSeparators.push(item);
  });

  return withSeparators;
})();
```

**Algorithm**:
1. Map calls to timeline items
2. FlatMap SMS with splitting logic:
   - If media + text: split into 2 items (media first, text 100ms later)
   - Otherwise: single item
3. Sort by timestamp
4. Insert date separators when date changes
5. Render in order

---

## Styling Reference

### Button Styles

```tsx
// Primary Button (Send SMS)
className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"

// Secondary Button (Quick Messages, Attach)
className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"

// Icon Button (AI Format, Attach)
className="p-1.5 text-gray-700 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"

// Ghost Button (Settings icon)
<Button variant="ghost" size="icon" className="h-6 w-6 hover:bg-gray-100" />

// Tab Button (Summary/Transcript)
// Active:
className="text-xs transition-colors text-gray-700 border-b-2 border-gray-700"
// Inactive:
className="text-xs transition-colors text-gray-500 border-b border-dashed border-gray-400 hover:text-gray-700 hover:border-gray-600"
```

### Card Styles

```tsx
// Call Card
<Card className="overflow-hidden border border-gray-200 hover:shadow-md transition-shadow">

// SMS Card (Outgoing)
<Card className="max-w-[80%] overflow-hidden border bg-blue-600 text-white border-blue-700">

// SMS Card (Incoming)
<Card className="max-w-[80%] overflow-hidden border bg-white text-gray-900 border-gray-200">
```

### Input Styles

```tsx
// Textarea
<textarea className="w-full px-3 py-2 pr-20 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />

// File Input (Hidden)
<input type="file" multiple className="hidden" />
```

### Status Badge Styles

```tsx
// Computed status colors
const getStatusColor = (status: string) => {
  switch (status) {
    case 'completed':
      return 'bg-green-500/10 text-green-700 border-green-200';
    case 'no-answer':
      return 'bg-yellow-500/10 text-yellow-700 border-yellow-200';
    case 'busy':
      return 'bg-orange-500/10 text-orange-700 border-orange-200';
    case 'failed':
      return 'bg-red-500/10 text-red-700 border-red-200';
    default:
      return 'bg-gray-500/10 text-gray-700 border-gray-200';
  }
};

// Usage
<div className={`flex items-center justify-center w-9 h-9 rounded-full border ${getStatusColor(call.status)}`}>
```

---

## Implementation Checklist

### Dependencies

```bash
# Install required packages
npm install lucide-react
npm install @radix-ui/react-collapsible
npm install @radix-ui/react-slider
npm install @radix-ui/react-scroll-area
npm install @radix-ui/react-tooltip
npm install jszip
```

### File Structure

```
/src/app/
├── App.tsx                          # Main app with timeline assembly
└── components/
    ├── date-separator.tsx           # Date bubble component
    ├── call-list-item.tsx           # Call record with audio
    ├── sms-list-item.tsx            # SMS bubble with media
    ├── sms-form.tsx                 # Message composition
    └── ui/                          # shadcn/ui components
        ├── card.tsx
        ├── button.tsx
        ├── badge.tsx
        ├── collapsible.tsx
        ├── slider.tsx
        ├── scroll-area.tsx
        └── tooltip.tsx
```

### Setup Steps

1. **Install Dependencies**
   ```bash
   npm install lucide-react @radix-ui/react-collapsible @radix-ui/react-slider @radix-ui/react-scroll-area @radix-ui/react-tooltip jszip
   ```

2. **Create UI Components**
   - Set up shadcn/ui or copy the UI components from `/src/app/components/ui/`

3. **Create DateSeparator**
   - Copy code from section "1. DateSeparator Component"

4. **Create CallListItem**
   - Copy full implementation from `/src/app/components/call-list-item.tsx`
   - Includes audio player, tabs, system info

5. **Create SmsListItem**
   - Copy full implementation from `/src/app/components/sms-list-item.tsx`
   - Handles media attachments and download

6. **Create SmsForm**
   - Copy full implementation from `/src/app/components/sms-form.tsx`
   - Includes presets, file upload, AI format

7. **Implement Timeline Assembly**
   - Copy timeline logic from App.tsx
   - Implements sorting and date separator insertion

8. **Add Export Functionality**
   - Copy `handleExportComponents` function
   - Add export button to header

### Testing Checklist

- [ ] Date separators appear between different dates
- [ ] Call items display with correct status colors
- [ ] Audio player plays/pauses correctly
- [ ] Skip buttons work (-10s, +10s)
- [ ] Summary and transcript tabs toggle
- [ ] System info expands/collapses
- [ ] SMS bubbles align correctly (left/right)
- [ ] Media attachments display and download
- [ ] Image previews show with hover download button
- [ ] Document files show with icon and size
- [ ] SMS form textarea accepts input
- [ ] Quick messages dropdown opens and selects
- [ ] File attachment adds to preview area
- [ ] File removal works
- [ ] Send button enables/disables correctly
- [ ] Keyboard shortcut (Cmd/Ctrl+Enter) sends
- [ ] Export button generates ZIP file
- [ ] Auto-scroll to bottom on load

### Responsive Considerations

Current implementation is **desktop-optimized**. For mobile:

1. **Reduce bubble max-width**: `max-w-[80%]` → `max-w-[90%]`
2. **Adjust form layout**: Stack buttons vertically on small screens
3. **Simplify audio controls**: Larger touch targets
4. **Header adjustments**: Reduce padding, smaller text

---

## Additional Notes

### Audio Player Behavior

- **Play/Pause**: Toggles audio playback
- **Skip Buttons**: Jump ±10 seconds
- **Progress Bar**: Draggable slider (Radix UI)
- **Time Update**: Every 100ms when playing
- **Auto-pause**: On audio end

### SMS Media Splitting

Messages with **both media and text** are automatically split into 2 bubbles:
1. **Media bubble** (first): No text, shows media only
2. **Text bubble** (second): 100ms later, shows text only

This mimics WhatsApp/Telegram behavior.

### Quick Messages

4 default presets:
- Follow-up
- Thank You
- Schedule Meeting
- Send Info

"+ Add New" button placeholder for future functionality.

### Export ZIP Contents

When exporting, ZIP includes:
- `call-list-item.tsx` (template with docs)
- `sms-list-item.tsx` (template with docs)
- `date-separator.tsx` (full code)
- `sms-form.tsx` (template with docs)
- `README.md` (usage instructions)

Filename: `timeline-components-YYYY-MM-DD.zip`

---

**Version**: 1.0.0  
**Last Updated**: 2026-02-16  
**Author**: Figma Make AI Assistant

*This specification provides complete implementation details for reproducing the Timeline column functionality.*
