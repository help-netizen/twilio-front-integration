// Call List Item Component
// This component displays individual call records with detailed information
// Import and use: <CallListItem call={callData} />

import { useState, useRef, useEffect } from 'react';
import { 
  PhoneIncoming, 
  PhoneOutgoing, 
  Play, 
  Pause, 
  RotateCcw,
  RotateCw,
  Settings2,
  Clock,
  DollarSign,
  Hash,
  GitBranch,
  Navigation,
  Timer
} from 'lucide-react';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Slider } from './ui/slider';
import { ScrollArea } from './ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

// TypeScript interfaces for call data
export interface CallData {
  id: string;
  direction: 'incoming' | 'outgoing';
  from: string;
  to: string;
  totalDuration: number;
  talkTime: number;
  waitTime: number;
  status: 'completed' | 'no-answer' | 'busy' | 'failed';
  startTime: Date;
  endTime: Date;
  cost?: number;
  callSid: string;
  queueTime: number;
  twilioDirection: 'inbound' | 'outbound';
  audioUrl?: string;
  summary?: string;
  transcription?: string;
}

interface CallListItemProps {
  call: CallData;
}

export function CallListItem({ call }: CallListItemProps) {
  // Component implementation here
  // See full source code in the original file
}