# Timeline Column - Complete Documentation

## Overview

The Timeline column is a comprehensive communication interface that displays a chronological feed of calls and SMS messages, similar to modern messaging applications. It combines call records with audio playback, SMS conversations with media support, and a message composition interface.

---

## Architecture

```yaml
timeline_column:
  structure:
    - scrollable_content:
        items:
          - date_separator
          - call_list_item
          - sms_list_item
    - footer:
        - sms_form
  
  layout:
    display: "flex flex-col"
    height: "100vh"
    background: "bg-gray-50"
    overflow: "hidden"
```

---

## Components

### 1. Date Separator

```yaml
component: DateSeparator
path: "/src/app/components/date-separator.tsx"
description: "Visual separator displaying date in messenger-style bubble"

props:
  date:
    type: "string"
    format: "Long date format (e.g., 'February 9, 2026')"
    required: true

structure:
  container:
    styles: "flex items-center justify-center my-6"
    purpose: "Centers the date bubble with vertical spacing"
  
  bubble:
    styles: "bg-gray-200 text-gray-600 px-4 py-1.5 rounded-full text-xs font-medium shadow-sm"
    content: "{{date}}"

visual_specs:
  background: "#E5E7EB (gray-200)"
  text_color: "#4B5563 (gray-600)"
  padding: "6px 16px"
  border_radius: "9999px (full rounded)"
  font_size: "12px (text-xs)"
  font_weight: "500 (medium)"
  shadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)"
  margin_vertical: "24px (my-6)"

usage_logic:
  trigger: "Automatically inserted when date changes between timeline items"
  comparison: "Compare current item date with previous item date"
  format: "toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })"

dependencies:
  external: []
  internal: []
```

---

### 2. Call List Item

```yaml
component: CallListItem
path: "/src/app/components/call-list-item.tsx"
description: "Comprehensive call record display with audio playback, transcription, and system information"

props:
  call:
    type: "CallData"
    required: true
    interface:
      id: "string"
      direction: "'incoming' | 'outgoing'"
      from: "string (phone number)"
      to: "string (phone number)"
      totalDuration: "number (seconds)"
      talkTime: "number (seconds)"
      waitTime: "number (seconds)"
      status: "'completed' | 'no-answer' | 'busy' | 'failed'"
      startTime: "Date"
      endTime: "Date"
      cost: "number (optional, in dollars)"
      callSid: "string (Twilio identifier)"
      queueTime: "number (seconds)"
      twilioDirection: "'inbound' | 'outbound'"
      audioUrl: "string (optional, URL to audio recording)"
      summary: "string (optional, AI-generated summary)"
      transcription: "string (optional, call transcript)"

structure:
  main_card:
    component: "Card (shadcn/ui)"
    styles: "bg-white border border-gray-200 shadow-sm"
    padding: "p-4"
    sections:
      - header
      - audio_player
      - call_summary
      - transcription
      - system_info

  header:
    layout: "flex items-center justify-between"
    elements:
      left_side:
        - direction_icon:
            incoming: "PhoneIncoming (lucide-react)"
            outgoing: "PhoneOutgoing (lucide-react)"
            colors:
              incoming: "text-green-600"
              outgoing: "text-blue-600"
        - phone_number:
            display: "from number (incoming) or to number (outgoing)"
            styles: "text-sm font-medium text-gray-900"
        - timestamp:
            format: "MMM DD, YYYY • HH:MM AM/PM"
            styles: "text-xs text-gray-500"
      
      right_side:
        - status_badge:
            component: "Badge (shadcn/ui)"
            variants:
              completed:
                text: "Completed"
                styles: "bg-green-100 text-green-800"
              no-answer:
                text: "No Answer"
                styles: "bg-yellow-100 text-yellow-800"
              busy:
                text: "Busy"
                styles: "bg-orange-100 text-orange-800"
              failed:
                text: "Failed"
                styles: "bg-red-100 text-red-800"
        
        - duration_badge:
            display: "formatDuration(totalDuration)"
            format: "MM:SS or HH:MM:SS"
            styles: "bg-gray-100 text-gray-700"

  audio_player:
    condition: "audioUrl exists"
    styles: "bg-gray-50 rounded-lg p-3"
    elements:
      - controls:
          layout: "flex items-center gap-3"
          buttons:
            play_pause:
              icon: "Play / Pause (lucide-react)"
              size: "w-5 h-5"
              toggle_state: "isPlaying"
              action: "handlePlayPause()"
            
            rewind:
              icon: "RotateCcw (lucide-react)"
              label: "-10s"
              action: "skip(-10)"
              styles: "hover:bg-gray-200"
            
            forward:
              icon: "RotateCw (lucide-react)"
              label: "+10s"
              action: "skip(10)"
              styles: "hover:bg-gray-200"
      
      - progress_bar:
          component: "Slider (radix-ui)"
          styles: "flex-1"
          range: "[0, duration]"
          value: "currentTime"
          onChange: "handleSeek()"
          visual:
            track: "bg-gray-300"
            filled_track: "bg-blue-600"
            thumb: "bg-blue-600 border-2 border-white shadow"
      
      - time_display:
          format: "currentTime / totalDuration"
          example: "01:23 / 03:45"
          styles: "text-xs text-gray-600 font-mono"

  call_summary:
    condition: "summary exists"
    styles: "mt-3 p-3 bg-blue-50 rounded-lg"
    structure:
      header:
        icon: "MessageSquare (lucide-react)"
        text: "Call Summary"
        styles: "text-sm font-semibold text-gray-900"
      content:
        text: "{{summary}}"
        styles: "text-sm text-gray-700 leading-relaxed"
        max_lines: "initially collapsed, expandable"

  transcription:
    condition: "transcription exists"
    component: "Collapsible (radix-ui)"
    structure:
      trigger:
        text: "View Transcription"
        icon: "ChevronDown (animated on toggle)"
        styles: "text-sm text-blue-600 hover:text-blue-700"
      
      content:
        component: "ScrollArea (radix-ui)"
        max_height: "200px"
        styles: "mt-2 p-3 bg-gray-50 rounded-lg text-sm text-gray-700 whitespace-pre-line"
        text: "{{transcription}}"
        features:
          - line_breaks_preserved
          - scrollable_overflow

  system_info:
    component: "Collapsible (radix-ui)"
    default_state: "collapsed"
    structure:
      trigger:
        icon: "Settings2 (lucide-react)"
        text: "System Information"
        styles: "text-sm text-gray-600 hover:text-gray-900"
      
      content:
        layout: "grid grid-cols-2 gap-3"
        fields:
          - cost:
              label: "Cost"
              icon: "DollarSign"
              value: "${{cost.toFixed(3)}}"
              condition: "cost exists"
          
          - call_sid:
              label: "Call SID"
              icon: "Hash"
              value: "{{callSid}}"
              styles: "font-mono text-xs"
          
          - queue_time:
              label: "Queue Time"
              icon: "Clock"
              value: "{{queueTime}}s"
          
          - twilio_direction:
              label: "Twilio Direction"
              icon: "Navigation"
              value: "{{twilioDirection}}"
              transform: "capitalize"

states:
  audio_player:
    isPlaying:
      type: "boolean"
      default: false
      affects: "Play/Pause button icon"
    
    currentTime:
      type: "number"
      default: 0
      updates: "Every 100ms when playing"
      range: "[0, duration]"
    
    duration:
      type: "number"
      source: "audio.duration metadata"
      loaded_on: "audio file load"
  
  collapsible_sections:
    transcription_open:
      type: "boolean"
      default: false
    
    system_info_open:
      type: "boolean"
      default: false

interactions:
  audio:
    play_pause:
      action: "Toggle audio playback"
      updates: "isPlaying state"
      side_effects: "Start/stop time update interval"
    
    seek:
      action: "Drag slider or click on progress bar"
      updates: "currentTime and audio.currentTime"
    
    skip:
      action: "Click -10s or +10s buttons"
      calculation: "currentTime +/- 10 (clamped to [0, duration])"
  
  expand_collapse:
    transcription:
      trigger: "Click trigger button"
      animation: "Slide down/up"
    
    system_info:
      trigger: "Click trigger button"
      animation: "Slide down/up"

dependencies:
  external:
    - "lucide-react": "Icons (PhoneIncoming, PhoneOutgoing, Play, Pause, RotateCcw, RotateCw, Settings2, etc.)"
    - "@radix-ui/react-collapsible": "Collapsible sections"
    - "@radix-ui/react-slider": "Audio progress bar"
    - "@radix-ui/react-scroll-area": "Scrollable transcription"
    - "@radix-ui/react-tooltip": "Tooltips for buttons"
  
  internal:
    - "./ui/card": "Card container"
    - "./ui/button": "Action buttons"
    - "./ui/badge": "Status and duration badges"

styling:
  theme:
    primary_color: "blue-600"
    success_color: "green-600"
    warning_color: "yellow-600"
    error_color: "red-600"
    neutral_bg: "gray-50"
    card_bg: "white"
    border_color: "gray-200"
  
  spacing:
    card_padding: "16px"
    section_gap: "12px"
    element_gap: "8px"
  
  typography:
    title: "text-sm font-semibold"
    body: "text-sm"
    caption: "text-xs"
    mono: "font-mono"
```

---

### 3. SMS List Item

```yaml
component: SmsListItem
path: "/src/app/components/sms-list-item.tsx"
description: "Message bubble component with support for text and media attachments (images, PDFs, documents)"

props:
  sms:
    type: "SmsData"
    required: true
    interface:
      id: "string"
      direction: "'incoming' | 'outgoing'"
      from: "string (phone number)"
      to: "string (phone number)"
      message: "string"
      timestamp: "Date"
      status: "'delivered' | 'sent' | 'failed'"
      media: "MediaAttachment[] (optional)"

  media_attachment_interface:
    id: "string"
    url: "string"
    filename: "string"
    contentType: "string (MIME type)"
    size: "number (bytes)"

structure:
  container:
    alignment:
      outgoing: "justify-end (right-aligned)"
      incoming: "justify-start (left-aligned)"
    styles: "flex"
  
  card:
    component: "Card (shadcn/ui)"
    max_width: "80%"
    styles:
      outgoing: "bg-blue-600 text-white border-blue-700"
      incoming: "bg-white text-gray-900 border-gray-200"
    padding:
      with_text: "p-4"
      media_only: "p-2"
  
  header:
    condition: "hasMessage OR (hasMedia AND isOutgoing)"
    layout: "flex items-center gap-2 mb-2"
    elements:
      - icon:
          component: "MessageSquare (lucide-react)"
          size: "w-4 h-4"
          color:
            outgoing: "text-blue-200"
            incoming: "text-gray-400"
      
      - phone_number:
          display: "to (outgoing) or from (incoming)"
          styles:
            outgoing: "text-xs font-mono text-blue-100"
            incoming: "text-xs font-mono text-gray-500"
      
      - status_indicator:
          condition: "isOutgoing"
          position: "ml-auto"
          icons:
            delivered:
              icon: "CheckCheck (lucide-react)"
              color: "text-blue-200"
            sent:
              icon: "Check (lucide-react)"
              color: "text-blue-300"
            failed:
              icon: "X (lucide-react)"
              color: "text-red-300"
  
  media_attachments:
    condition: "hasMedia"
    layout: "space-y-2"
    margin_bottom: "mb-3 (if hasMessage), none otherwise"
    
    image_preview:
      condition: "contentType.startsWith('image/')"
      structure:
        container:
          styles: "relative group"
        
        image:
          component: "img"
          styles: "w-full rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
          onClick: "handleDownload(media)"
        
        download_button:
          position: "absolute top-2 right-2"
          styles: "p-2 rounded-full shadow-lg transition-opacity opacity-0 group-hover:opacity-100"
          background:
            outgoing: "bg-blue-700 hover:bg-blue-800"
            incoming: "bg-gray-800 hover:bg-gray-900"
          icon: "Download (lucide-react)"
          size: "w-4 h-4"
        
        size_badge:
          position: "absolute bottom-2 left-2"
          styles: "px-2 py-1 rounded text-xs text-white"
          background:
            outgoing: "bg-blue-700/90"
            incoming: "bg-gray-800/90"
          content: "formatFileSize(size)"
    
    document_button:
      condition: "!contentType.startsWith('image/')"
      component: "button"
      styles: "w-full flex items-center gap-3 p-3 rounded-lg border transition-colors"
      background:
        outgoing: "bg-blue-700 border-blue-800 hover:bg-blue-800"
        incoming: "bg-gray-50 border-gray-200 hover:bg-gray-100"
      onClick: "handleDownload(media)"
      
      structure:
        icon_container:
          styles: "p-2 rounded"
          background:
            outgoing: "bg-blue-800"
            incoming: "bg-gray-200"
          icon:
            pdf:
              component: "FileText (lucide-react)"
              color:
                outgoing: "text-blue-200"
                incoming: "text-red-600"
            other:
              component: "FileIcon (lucide-react)"
              color:
                outgoing: "text-blue-200"
                incoming: "text-gray-600"
        
        file_info:
          layout: "flex-1 text-left"
          filename:
            styles:
              outgoing: "text-sm font-medium truncate text-white"
              incoming: "text-sm font-medium truncate text-gray-900"
          size:
            styles:
              outgoing: "text-xs text-blue-200"
              incoming: "text-xs text-gray-500"
        
        download_icon:
          component: "Download (lucide-react)"
          size: "w-4 h-4"
          color:
            outgoing: "text-blue-200"
            incoming: "text-gray-400"
  
  message_text:
    condition: "hasMessage"
    styles:
      outgoing: "text-sm leading-relaxed mb-2 text-white"
      incoming: "text-sm leading-relaxed mb-2 text-gray-700"
    content: "{{message}}"
  
  timestamp:
    condition: "hasMessage"
    position: "text-right"
    styles:
      outgoing: "text-xs text-blue-200"
      incoming: "text-xs text-gray-500"
    format: "MMM DD, YYYY, HH:MM AM/PM"

logic:
  message_splitting:
    description: "Messages with both media and text are automatically split into two separate bubbles"
    location: "App.tsx timeline formation"
    process:
      - check: "if (sms.media && sms.media.length > 0 && sms.message)"
      - split:
          media_message:
            id: "{{sms.id}}-media"
            message: ""
            media: "original media array"
            timestamp: "original timestamp"
          
          text_message:
            id: "{{sms.id}}-text"
            message: "original message"
            media: "undefined"
            timestamp: "original timestamp + 100ms"
      - result: "Two separate SmsListItem components rendered"

interactions:
  media:
    image_click:
      action: "Click on image"
      result: "Download image file"
    
    download_button:
      action: "Click download button (hover on image)"
      result: "Download image file"
      prevents: "Event propagation to image click"
    
    document_click:
      action: "Click on document button"
      result: "Download document file"
  
  download_function:
    method: "handleDownload(media)"
    implementation:
      - create: "Temporary <a> element"
      - set_href: "media.url"
      - set_download: "media.filename"
      - set_target: "_blank"
      - trigger: "click()"
      - cleanup: "Remove element"

utilities:
  formatFileSize:
    input: "number (bytes)"
    output: "string"
    logic:
      - "< 1024 bytes": "{{bytes}} B"
      - "< 1MB": "{{(bytes / 1024).toFixed(1)}} KB"
      - ">= 1MB": "{{(bytes / 1024 / 1024).toFixed(1)}} MB"
  
  formatTime:
    input: "Date"
    output: "string"
    format: "toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })"
    example: "Feb 9, 2026, 9:15 AM"
  
  isImage:
    input: "string (contentType)"
    output: "boolean"
    check: "contentType.startsWith('image/')"

dependencies:
  external:
    - "lucide-react": "Icons (MessageSquare, Check, CheckCheck, X, Download, FileText, FileIcon)"
  
  internal:
    - "./ui/card": "Card container"

styling:
  bubble_colors:
    outgoing:
      background: "#2563EB (blue-600)"
      text: "#FFFFFF (white)"
      border: "#1D4ED8 (blue-700)"
      accent: "#BFDBFE (blue-200)"
    
    incoming:
      background: "#FFFFFF (white)"
      text: "#111827 (gray-900)"
      border: "#E5E7EB (gray-200)"
      accent: "#6B7280 (gray-500)"
  
  media:
    border_radius: "8px (rounded-lg)"
    hover_opacity: "0.9"
    transition: "opacity 200ms"
  
  alignment:
    outgoing: "Right side (justify-end)"
    incoming: "Left side (justify-start)"
    max_width: "80% of parent"
```

---

### 4. SMS Form

```yaml
component: SmsForm
path: "/src/app/components/sms-form.tsx"
description: "Message composition interface with quick message presets, file attachments, AI formatting, and send functionality"

props:
  onSend:
    type: "function"
    signature: "(message: string, files: File[]) => void"
    required: true
    description: "Callback when message is sent"
  
  onAiFormat:
    type: "function"
    signature: "(message: string) => Promise<string>"
    required: true
    description: "Async callback for AI formatting"

structure:
  container:
    styles: "border-t border-gray-200 bg-white p-4"
    sections:
      - file_preview
      - message_input
      - action_buttons
  
  file_preview:
    condition: "attachedFiles.length > 0"
    styles: "mb-3 flex flex-wrap gap-2"
    
    file_chip:
      layout: "flex items-center gap-2"
      styles: "px-3 py-1.5 bg-gray-100 border border-gray-200 rounded-lg text-sm"
      elements:
        - icon:
            component: "Paperclip (lucide-react)"
            size: "w-3.5 h-3.5"
            color: "text-gray-500"
        
        - filename:
            styles: "text-gray-700 max-w-[150px] truncate"
            content: "{{file.name}}"
        
        - size:
            styles: "text-gray-500 text-xs"
            content: "({{formatFileSize(file.size)}})"
        
        - remove_button:
            icon: "X (lucide-react)"
            size: "w-3.5 h-3.5"
            styles: "ml-1 text-gray-400 hover:text-red-600 transition-colors"
            onClick: "handleRemoveFile(index)"
  
  message_input:
    container:
      styles: "relative mb-3"
    
    textarea:
      component: "textarea"
      rows: 3
      placeholder: "Type your message... (Cmd/Ctrl + Enter to send)"
      styles: "w-full px-3 py-2 pr-20 border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
      value: "{{message}}"
      onChange: "setMessage(e.target.value)"
      onKeyDown: "handleKeyDown(e)"
    
    character_counter:
      position: "absolute bottom-2 left-3"
      styles: "text-xs text-gray-400"
      content: "{{message.length}} characters"
  
  action_buttons:
    layout: "flex items-center justify-between gap-2"
    sections:
      - left_side
      - right_side
    
    left_side:
      layout: "flex items-center gap-2"
      buttons:
        - quick_messages:
            type: "dropdown"
            trigger:
              icon: "ChevronDown (lucide-react, animated on toggle)"
              text: "Quick Messages"
              styles: "flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
            
            dropdown:
              position: "absolute left-0 bottom-full mb-1"
              width: "256px (w-64)"
              styles: "bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1"
              
              preset_items:
                presets:
                  - id: "follow-up"
                    label: "Follow-up"
                    text: "Hi! Just following up on our previous conversation. Let me know if you have any questions."
                  
                  - id: "thank-you"
                    label: "Thank You"
                    text: "Thank you for your time today! Looking forward to speaking with you again soon."
                  
                  - id: "meeting"
                    label: "Schedule Meeting"
                    text: "Would you be available for a quick call this week? Let me know what time works best for you."
                  
                  - id: "info"
                    label: "Send Info"
                    text: "As promised, here's the information we discussed. Feel free to reach out if you need anything else."
                
                item_structure:
                  styles: "w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors"
                  onClick: "handlePresetSelect(preset.text)"
                  layout:
                    label: "text-sm font-medium text-gray-900"
                    preview: "text-xs text-gray-500 line-clamp-1"
              
              add_new_button:
                styles: "w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors"
                text: "+ Add New"
                color: "text-blue-600"
        
        - attach_file:
            type: "button"
            icon: "Paperclip (lucide-react)"
            styles: "p-1.5 text-gray-700 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
            title: "Attach file"
            onClick: "fileInputRef.current?.click()"
            
            hidden_input:
              type: "file"
              multiple: true
              ref: "fileInputRef"
              onChange: "handleFileSelect(e)"
    
    right_side:
      layout: "flex items-center gap-2"
      buttons:
        - ai_format:
            type: "button"
            icon: "Wand2 (lucide-react, animated spin when active)"
            styles: "p-1.5 text-gray-700 hover:text-purple-600 hover:bg-purple-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title: "Format with AI"
            disabled: "!message.trim() || isAiFormatting"
            onClick: "handleAiFormat()"
        
        - send:
            type: "button"
            icon: "Send (lucide-react)"
            text: "Send SMS"
            styles: "flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled: "!message.trim() && attachedFiles.length === 0"
            onClick: "handleSend()"

states:
  message:
    type: "string"
    default: ""
    updates: "On textarea onChange"
  
  attachedFiles:
    type: "File[]"
    default: "[]"
    updates: "On file selection or removal"
  
  isPresetsOpen:
    type: "boolean"
    default: false
    controls: "Quick Messages dropdown visibility"
  
  isAiFormatting:
    type: "boolean"
    default: false
    duration: "During AI format request"
    effects:
      - "Disables AI Format button"
      - "Shows spinner animation on Wand2 icon"

interactions:
  message_input:
    typing:
      updates: "message state"
      shows: "character counter"
    
    keyboard_shortcut:
      keys: "Cmd/Ctrl + Enter"
      action: "handleSend()"
      condition: "Prevents default behavior"
  
  quick_messages:
    open:
      action: "Click trigger button"
      updates: "isPresetsOpen = true"
      shows: "Dropdown menu"
    
    select:
      action: "Click preset item"
      updates: "message = preset.text"
      closes: "Dropdown (isPresetsOpen = false)"
    
    close:
      triggers:
        - "Click outside (backdrop)"
        - "Select preset"
        - "Click Add New"
  
  file_attachment:
    add:
      trigger: "Click attach button"
      action: "Open file picker"
      accepts: "Multiple files"
      updates: "attachedFiles array (append)"
      resets: "Input value for re-selection"
    
    remove:
      trigger: "Click X button on file chip"
      action: "handleRemoveFile(index)"
      updates: "Filter out file at index"
  
  ai_formatting:
    trigger: "Click AI Format button"
    conditions:
      - "message.trim() exists"
      - "!isAiFormatting"
    process:
      - set: "isAiFormatting = true"
      - call: "await onAiFormat(message)"
      - update: "message = formatted result"
      - set: "isAiFormatting = false"
      - error_handling: "console.error + reset isAiFormatting"
  
  send_message:
    trigger:
      - "Click Send button"
      - "Keyboard shortcut (Cmd/Ctrl + Enter)"
    conditions: "message.trim() OR attachedFiles.length > 0"
    process:
      - call: "onSend(message, attachedFiles)"
      - reset: "message = ''"
      - reset: "attachedFiles = []"

utilities:
  formatFileSize:
    description: "Same as SmsListItem"
    implementation: "Shared logic"
  
  handleKeyDown:
    input: "React.KeyboardEvent<HTMLTextAreaElement>"
    logic:
      - check: "e.key === 'Enter' && (e.metaKey || e.ctrlKey)"
      - prevent_default: "Prevents newline"
      - trigger: "handleSend()"

dependencies:
  external:
    - "lucide-react": "Icons (Send, Wand2, ChevronDown, Paperclip, X)"
  
  internal: []

styling:
  container:
    background: "#FFFFFF (white)"
    border_top: "1px solid #E5E7EB (gray-200)"
    padding: "16px"
  
  textarea:
    border: "#D1D5DB (gray-300)"
    focus_ring: "2px #3B82F6 (blue-500)"
    border_radius: "8px (rounded-lg)"
  
  buttons:
    default:
      text: "#374151 (gray-700)"
      hover_bg: "#EFF6FF (blue-50) or #FAF5FF (purple-50)"
      hover_text: "#2563EB (blue-600) or #9333EA (purple-600)"
    
    send:
      bg: "#2563EB (blue-600)"
      hover_bg: "#1D4ED8 (blue-700)"
      text: "#FFFFFF (white)"
  
  dropdown:
    background: "#FFFFFF (white)"
    border: "#E5E7EB (gray-200)"
    shadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)"
    item_hover: "#F9FAFB (gray-50)"
```

---

## Timeline Logic

```yaml
timeline_assembly:
  location: "/src/app/App.tsx"
  description: "Combines calls and SMS into chronological timeline with date separators"
  
  process:
    step_1_combine:
      description: "Merge calls and SMS into single array"
      calls: "Map to { type: 'call', data: call, timestamp: call.startTime }"
      sms: "FlatMap with splitting logic"
      
      sms_splitting:
        condition: "sms.media?.length > 0 && sms.message"
        result:
          - media_bubble:
              type: "sms"
              id: "{{sms.id}}-media"
              message: ""
              media: "original media"
              timestamp: "original timestamp"
          
          - text_bubble:
              type: "sms"
              id: "{{sms.id}}-text"
              message: "original message"
              media: "undefined"
              timestamp: "original timestamp + 100ms"
        
        else: "Single SMS item"
    
    step_2_sort:
      method: "Array.sort((a, b) => a.timestamp - b.timestamp)"
      order: "Chronological (oldest first)"
    
    step_3_date_separators:
      description: "Insert date separator before date change"
      algorithm:
        - iterate: "Through sorted items"
        - track: "lastDate"
        - compare: "currentDate vs lastDate"
        - insert: "DateSeparator if different"
        - push: "Current item"
      
      date_format:
        function: "toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })"
        example: "February 9, 2026"
    
    step_4_render:
      map: "timeline.map((item, index))"
      render_logic:
        call: "<CallListItem key={item.data.id} call={item.data} />"
        sms: "<SmsListItem key={item.data.id} sms={item.data} />"
        date_separator: "<DateSeparator key={`date-${index}`} date={item.date} />"

auto_scroll:
  description: "Scrolls to bottom on mount (messenger behavior)"
  hook: "useEffect([], once on mount)"
  ref: "callsContainerRef"
  action: "scrollTop = scrollHeight"
```

---

## Styling System

```yaml
design_system:
  color_palette:
    primary:
      blue-50: "#EFF6FF"
      blue-100: "#DBEAFE"
      blue-200: "#BFDBFE"
      blue-600: "#2563EB"
      blue-700: "#1D4ED8"
      blue-800: "#1E40AF"
    
    success:
      green-100: "#DCFCE7"
      green-600: "#16A34A"
      green-800: "#166534"
    
    warning:
      yellow-100: "#FEF3C7"
      yellow-600: "#CA8A04"
      yellow-800: "#854D0E"
    
    error:
      red-100: "#FEE2E2"
      red-300: "#FCA5A5"
      red-600: "#DC2626"
      red-800: "#991B1B"
    
    neutral:
      gray-50: "#F9FAFB"
      gray-100: "#F3F4F6"
      gray-200: "#E5E7EB"
      gray-400: "#9CA3AF"
      gray-500: "#6B7280"
      gray-600: "#4B5563"
      gray-700: "#374151"
      gray-900: "#111827"
      white: "#FFFFFF"
  
  typography:
    font_family: "System default (sans-serif)"
    sizes:
      xs: "12px (0.75rem)"
      sm: "14px (0.875rem)"
      base: "16px (1rem)"
      lg: "18px (1.125rem)"
    
    weights:
      normal: "400"
      medium: "500"
      semibold: "600"
      bold: "700"
  
  spacing:
    scale: "4px base unit"
    values:
      1: "4px"
      1.5: "6px"
      2: "8px"
      3: "12px"
      4: "16px"
      6: "24px"
  
  border_radius:
    lg: "8px"
    full: "9999px"
  
  shadows:
    sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)"
    DEFAULT: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)"
    lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)"

responsive_behavior:
  timeline_column:
    min_width: "400px"
    flex: "1 (grows to fill space)"
  
  message_bubbles:
    max_width: "80% of parent"
    alignment:
      outgoing: "Right-aligned"
      incoming: "Left-aligned"
  
  mobile_considerations:
    note: "Current implementation optimized for desktop"
    recommendations:
      - "Reduce bubble max-width to 90%"
      - "Adjust font sizes for smaller screens"
      - "Simplify audio controls for touch"
```

---

## Performance Considerations

```yaml
performance:
  audio_player:
    optimization: "Single audio element per call"
    state_updates: "Throttled to 100ms intervals"
    cleanup: "Pause and remove listeners on unmount"
  
  timeline_rendering:
    strategy: "Virtualization recommended for 100+ items"
    current: "Renders all items in DOM"
    scroll_behavior: "Smooth, hardware-accelerated"
  
  media_attachments:
    images:
      loading: "Lazy loading via browser native"
      optimization: "Use appropriate image sizes from server"
    
    downloads:
      method: "Browser native download"
      no_buffering: "Direct link download"
  
  file_attachments:
    preview: "File objects stored in memory"
    size_limit: "None enforced (add if needed)"
    validation: "None (add MIME type checks if needed)"

memory_management:
  audio_elements:
    created: "On demand when audioUrl exists"
    destroyed: "On component unmount"
    refs: "useRef to prevent re-creation"
  
  file_objects:
    storage: "React state (attachedFiles)"
    cleared: "On send or manual removal"
  
  event_listeners:
    audio:
      attached: "timeupdate, loadedmetadata, ended"
      cleaned: "useEffect cleanup function"
```

---

## Accessibility

```yaml
accessibility:
  keyboard_navigation:
    buttons: "All interactive elements are <button> elements"
    shortcuts:
      send_message: "Cmd/Ctrl + Enter"
    
    focus_management:
      audio_controls: "Tab-accessible"
      collapsible_triggers: "Enter/Space to toggle"
      slider: "Arrow keys to adjust"
  
  screen_readers:
    icons:
      labels: "title attributes on buttons"
      hidden_text: "sr-only class where needed"
    
    status_indicators:
      call_status: "Badge with descriptive text"
      sms_status: "Icon with aria-label"
    
    audio_player:
      time_display: "Readable format (MM:SS)"
      controls: "Descriptive button labels"
  
  color_contrast:
    text_on_backgrounds:
      white_on_blue: "WCAG AA compliant"
      gray_on_white: "WCAG AA compliant"
    
    status_colors:
      success: "Green with adequate contrast"
      warning: "Yellow/orange with adequate contrast"
      error: "Red with adequate contrast"
  
  focus_indicators:
    style: "ring-2 ring-blue-500"
    visible: "On keyboard navigation"
    removed: "On mouse click (outline-none where appropriate)"

aria_attributes:
  collapsible:
    provided_by: "@radix-ui/react-collapsible"
    attributes: "aria-expanded, aria-controls"
  
  slider:
    provided_by: "@radix-ui/react-slider"
    attributes: "aria-valuemin, aria-valuemax, aria-valuenow"
  
  buttons:
    recommended: "Add aria-label for icon-only buttons"
```

---

## Testing Recommendations

```yaml
testing:
  unit_tests:
    components:
      - DateSeparator:
          tests:
            - "Renders date correctly"
            - "Applies correct styling"
      
      - SmsListItem:
          tests:
            - "Renders outgoing message with correct alignment"
            - "Renders incoming message with correct alignment"
            - "Displays media attachments"
            - "Shows status indicators for outgoing"
            - "Handles media-only messages"
            - "Handles text-only messages"
            - "formatFileSize utility works correctly"
      
      - CallListItem:
          tests:
            - "Renders call direction icon"
            - "Displays status badge"
            - "Shows audio player when audioUrl exists"
            - "Audio play/pause toggle works"
            - "Seek functionality works"
            - "Skip buttons adjust time correctly"
            - "Collapsible sections expand/collapse"
            - "System info displays when available"
      
      - SmsForm:
          tests:
            - "Textarea updates message state"
            - "Character counter displays correctly"
            - "Quick messages dropdown opens/closes"
            - "Preset selection updates message"
            - "File attachment adds to list"
            - "File removal works"
            - "Send button disabled when empty"
            - "Keyboard shortcut triggers send"
            - "AI format button disabled when empty"
            - "AI format shows loading state"
  
  integration_tests:
    timeline:
      - "Timeline sorts chronologically"
      - "Date separators insert correctly"
      - "SMS with media splits into two bubbles"
      - "Auto-scroll to bottom on mount"
    
  
  e2e_tests:
    user_flows:
      - "User plays audio from call record"
      - "User views transcription"
      - "User downloads media from SMS"
      - "User composes and sends SMS"
      - "User attaches files and sends"
      - "User uses quick message preset"


mock_data:
  location: "/src/app/App.tsx"
  calls:
    count: 9
    statuses: ["completed", "no-answer", "busy", "failed"]
    with_audio: 3
    with_transcription: 3
    with_summary: 4
  
  sms:
    count: 13
    directions: ["incoming", "outgoing"]
    with_media: 3
    media_types: ["images", "pdf"]
```

---

## Future Enhancements

```yaml
potential_improvements:
  performance:
    - implement: "Virtual scrolling for large datasets"
    - add: "Image lazy loading with placeholder"
    - optimize: "Audio element pooling"
  
  features:
    - add: "Search/filter timeline"
    - implement: "Real-time updates (WebSocket)"
    - add: "Message reactions"
    - implement: "Reply to specific messages"
    - add: "Voice message recording"
    - implement: "Rich text editor"
    - add: "Emoji picker"
    - implement: "Message edit/delete"
    - add: "Read receipts"
    - implement: "Typing indicators"
  
  ux:
    - add: "Toast notifications for actions"
    - implement: "Drag-and-drop file upload"
    - add: "Image preview modal"
    - implement: "Audio waveform visualization"
    - add: "Keyboard shortcuts guide"
    - implement: "Dark mode support"
  
  accessibility:
    - add: "aria-label to all icon buttons"
    - implement: "Landmark regions (role attributes)"
    - add: "Skip links for keyboard navigation"
    - improve: "Screen reader announcements"
  
  developer_experience:
    - add: "Storybook stories for all components"
    - implement: "Component prop validation"
    - add: "Error boundaries"
    - implement: "Loading states"
    - add: "Empty states"
    - document: "Component API reference"
```

---

## Dependencies Summary

```yaml
all_dependencies:
  npm_packages:
    core:
      - "react": "^18.3.1"
      - "react-dom": "^18.3.1"
    
    ui_primitives:
      - "lucide-react": "^0.487.0"
      - "@radix-ui/react-collapsible": "^1.1.3"
      - "@radix-ui/react-slider": "^1.2.3"
      - "@radix-ui/react-scroll-area": "^1.2.3"
      - "@radix-ui/react-tooltip": "^1.1.8"
    
    
    styling:
      - "tailwindcss": "^4.1.12"
      - "@tailwindcss/vite": "^4.1.12"
  
  internal_components:
    ui:
      - "./ui/card"
      - "./ui/button"
      - "./ui/badge"
      - "./ui/collapsible"
      - "./ui/slider"
      - "./ui/scroll-area"
      - "./ui/tooltip"
    
    custom:
      - "./call-list-item"
      - "./sms-list-item"
      - "./date-separator"
      - "./sms-form"
      - "./customer-card"

file_structure:
  /src/app/:
    - App.tsx: "Main application with timeline assembly"
  
  /src/app/components/:
    - call-list-item.tsx: "Call record component"
    - sms-list-item.tsx: "SMS bubble component"
    - date-separator.tsx: "Date separator component"
    - sms-form.tsx: "Message composition form"
    - customer-card.tsx: "Customer info (external to timeline)"
  
  /src/app/components/ui/:
    - card.tsx: "shadcn/ui Card"
    - button.tsx: "shadcn/ui Button"
    - badge.tsx: "shadcn/ui Badge"
    - collapsible.tsx: "shadcn/ui Collapsible"
    - slider.tsx: "shadcn/ui Slider"
    - scroll-area.tsx: "shadcn/ui ScrollArea"
    - tooltip.tsx: "shadcn/ui Tooltip"
```

---

## Configuration

```yaml
audio_settings:
  update_interval: "100ms"
  skip_duration: "10 seconds"
  volume: "1.0 (100%)"
  preload: "metadata"

message_settings:
  textarea_rows: 3
  max_bubble_width: "80%"
  character_counter: "always visible"
  
  presets:
    count: 4
    editable: false
    location: "MESSAGE_PRESETS constant"

file_upload:
  multiple: true
  accept: "all types (*)"
  max_size: "none (add validation if needed)"
  preview: "filename + size only"

date_format:
  separator: "long format (February 9, 2026)"
  timestamp: "MMM DD, YYYY • HH:MM AM/PM"
  time_ago:
    - "< 24h": "{{hours}}h ago"
    - "< 7d": "{{days}}d ago"
    - ">= 7d": "MMM DD"
```

---

## Changelog & Version

```yaml
version: "1.0.0"
last_updated: "2026-02-16"
author: "Figma Make AI Assistant"

recent_changes:
  - date: "2026-02-16"
    changes:
      - "Added SMS media/text message splitting functionality"
      - "Implemented compact SMS form with icon-only buttons"
      - "Added ZIP export functionality for timeline components"
      - "Created comprehensive documentation"
  
  - date: "2026-02-15"
    changes:
      - "Added media attachment support in SMS"
      - "Implemented file upload with preview"
      - "Added download functionality for images and documents"
  
  - date: "2026-02-14"
    changes:
      - "Initial timeline implementation"
      - "Created CallListItem with audio player"
      - "Implemented SmsListItem with bubble design"
      - "Added DateSeparator component"
      - "Created SmsForm with quick messages"
```

---

*This documentation was automatically generated for the Timeline Column component system. For the latest version and updates, refer to the source code.*
