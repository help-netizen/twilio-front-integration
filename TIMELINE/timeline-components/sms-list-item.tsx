// SMS List Item Component
// This component displays SMS messages with media attachments support
// Import and use: <SmsListItem sms={smsData} />

import { MessageSquare, Check, CheckCheck, X, Download, FileText, FileIcon } from 'lucide-react';
import { Card } from './ui/card';

export interface MediaAttachment {
  id: string;
  url: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface SmsData {
  id: string;
  direction: 'incoming' | 'outgoing';
  from: string;
  to: string;
  message: string;
  timestamp: Date;
  status: 'delivered' | 'sent' | 'failed';
  media?: MediaAttachment[];
}

interface SmsListItemProps {
  sms: SmsData;
}

export function SmsListItem({ sms }: SmsListItemProps) {
  const isOutgoing = sms.direction === 'outgoing';
  const hasMedia = sms.media && sms.media.length > 0;
  const hasMessage = sms.message && sms.message.trim().length > 0;
  
  // Component implementation here
  // See full source code in the original file
}