# Timeline Components Export

This archive contains all the React components used in the timeline column of the phone system interface.

## Components Included:

1. **call-list-item.tsx** - Displays call records with play/pause controls, transcriptions, and system information
2. **sms-list-item.tsx** - Displays SMS messages with media attachment support (images, PDFs, etc.)
3. **date-separator.tsx** - Displays date bubbles between timeline items (like in messengers)
4. **sms-form.tsx** - SMS composition form with quick messages, file attachments, and AI formatting

## Required Dependencies:

```json
{
  "dependencies": {
    "lucide-react": "^0.487.0",
    "@radix-ui/react-collapsible": "^1.1.3",
    "@radix-ui/react-slider": "^1.2.3",
    "@radix-ui/react-scroll-area": "^1.2.3",
    "@radix-ui/react-tooltip": "^1.1.8"
  }
}
```

## UI Components Required:

These components use shadcn/ui components. You'll need:
- Card
- Button
- Badge
- Collapsible
- Slider
- ScrollArea
- Tooltip

## Usage Example:

```tsx
import { CallListItem } from './components/call-list-item';
import { SmsListItem } from './components/sms-list-item';
import { DateSeparator } from './components/date-separator';
import { SmsForm } from './components/sms-form';

// In your component:
<div className="timeline">
  <DateSeparator date="February 9, 2026" />
  <CallListItem call={callData} />
  <SmsListItem sms={smsData} />
  <SmsForm onSend={handleSend} onAiFormat={handleAiFormat} />
</div>
```

## Features:

- **Call List Item:**
  - Audio playback with controls
  - Transcription viewer
  - Call summary
  - System information (collapsible)
  - Status indicators

- **SMS List Item:**
  - Message bubbles (like WhatsApp/Telegram)
  - Media attachments (images with preview, documents with download)
  - Delivery status indicators
  - Auto-split for media+text messages

- **Date Separator:**
  - Messenger-style date bubbles
  - Auto-inserted between different dates

- **SMS Form:**
  - Quick message presets
  - File attachments with preview
  - AI formatting button
  - Character counter
  - Keyboard shortcuts (Cmd/Ctrl+Enter to send)

## Notes:

- All timestamps are displayed in local timezone
- Media files support images (JPEG, PNG) and documents (PDF, etc.)
- Components use Tailwind CSS for styling
- Full TypeScript support with proper interfaces

Exported on: 2/16/2026, 2:11:46 AM
