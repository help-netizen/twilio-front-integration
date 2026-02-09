import { CallListItem, CallData } from './components/call-list-item';
import { ScrollArea } from './components/ui/scroll-area';
import { Phone } from 'lucide-react';

// Mock call data based on the provided examples
const mockCalls: CallData[] = [
  {
    id: '1',
    direction: 'outgoing',
    from: '+1 (508) 514-0320',
    to: '+1 (617) 500-6181',
    duration: null,
    status: 'busy',
    startTime: new Date('2026-02-07T20:02:00'),
    endTime: new Date('2026-02-07T20:02:00'),
    callSid: 'CA5e37798268a2d9a269249468cd971906',
    queueTime: 0,
    twilioDirection: 'inbound (corrected to: external)',
    audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    summary: 'Customer called to inquire about product availability. Call was not answered.',
    transcription: 'No transcription available - call was not answered.'
  },
  {
    id: '2',
    direction: 'incoming',
    from: '+1 (508) 514-0320',
    to: '+1 (617) 500-6181',
    totalDuration: 10,
    talkTime: 6,
    waitTime: 4,
    status: 'completed',
    startTime: new Date('2026-02-07T15:02:00'),
    endTime: new Date('2026-02-07T15:02:10'),
    callSid: 'CA1b8e4c2b5755f6a2e89a15f834574762',
    queueTime: 0,
    parentCall: 'CAd26d212347694aea9948cb8b24a3e839',
    twilioDirection: 'outbound-dial (corrected to: inbound)',
    audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
    summary: 'Quick confirmation call regarding order #12345. Customer confirmed delivery address and requested expedited shipping.',
    transcription: `Agent: Hello, this is John from Customer Service. How can I help you today?
Customer: Hi, I wanted to confirm my order details.
Agent: Of course! Let me pull that up for you.
Customer: Great, thank you!
Agent: Your order is confirmed and will be delivered tomorrow.
Customer: Perfect, thanks!`
  },
  {
    id: '3',
    direction: 'incoming',
    from: '+1 (508) 514-0320',
    to: '+1 (617) 500-6181',
    totalDuration: 17,
    talkTime: 0,
    waitTime: 17,
    status: 'no-answer',
    startTime: new Date('2026-02-07T15:01:00'),
    endTime: new Date('2026-02-07T15:01:17'),
    callSid: 'CA300fd46a1ed504703775418722e80e6a',
    queueTime: 0,
    parentCall: 'CAa037d66a4d975cc4b43c4f290aada726',
    twilioDirection: 'outbound-dial (corrected to: inbound)'
  },
  {
    id: '4',
    direction: 'outgoing',
    from: '+1 (617) 500-6181',
    to: '+1 (508) 514-0320',
    totalDuration: 13,
    talkTime: 11,
    waitTime: 2,
    status: 'completed',
    startTime: new Date('2026-02-07T14:51:00'),
    endTime: new Date('2026-02-07T14:51:13'),
    cost: 0.014,
    callSid: 'CAd3b9d6fcc546a344e0947ec8715c8ab9',
    queueTime: 0,
    parentCall: 'CA6278b89600f05ca95be67287b035c316',
    twilioDirection: 'outbound-dial (corrected to: external)',
    audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
    summary: 'Follow-up call regarding technical support ticket #7890. Issue was resolved by restarting the device.',
    transcription: `Agent: Hi, this is Sarah from Tech Support. I'm calling about your ticket.
Customer: Oh yes, thank you for calling back!
Agent: I see you were having connectivity issues. Have you tried restarting your router?
Customer: Let me try that now... Okay, it's working now!
Agent: Excellent! Let me know if you need anything else.
Customer: Will do, thanks!`
  },
  {
    id: '5',
    direction: 'incoming',
    from: '+1 (508) 514-0320',
    to: '+1 (617) 500-6181',
    totalDuration: 19,
    talkTime: 7,
    waitTime: 12,
    status: 'completed',
    startTime: new Date('2026-02-07T14:43:00'),
    endTime: new Date('2026-02-07T14:44:00'),
    cost: 0.004,
    callSid: 'CA3f78dcf2ee81ad12503329c0bfe2b1f8',
    queueTime: 0,
    parentCall: 'CA8196e422b34040a297527e083d2da93e',
    twilioDirection: 'outbound-dial (corrected to: inbound)',
    audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3',
    summary: 'Billing inquiry about recent charges. Customer was informed about subscription renewal.',
    transcription: `Customer: I have a question about my bill.
Agent: I'd be happy to help. What's your concern?
Customer: There's a charge I don't recognize.
Agent: Let me check... That's your monthly subscription renewal.
Customer: Oh I see, thank you for clarifying!`
  },
  {
    id: '6',
    direction: 'incoming',
    from: '+1 (508) 514-0320',
    to: '+1 (617) 500-6181',
    totalDuration: 13,
    talkTime: 5,
    waitTime: 8,
    status: 'completed',
    startTime: new Date('2026-02-07T14:40:00'),
    endTime: new Date('2026-02-07T14:40:13'),
    cost: 0.004,
    callSid: 'CA1cb4fcf088b36ff2a69e07d7e6765bcb',
    queueTime: 0,
    parentCall: 'CAfe8750f602134120e1e67aec0773c802',
    twilioDirection: 'outbound-dial (corrected to: inbound)'
  },
  {
    id: '7',
    direction: 'incoming',
    from: '+1 (508) 514-0320',
    to: '+1 (617) 500-6181',
    totalDuration: 4,
    talkTime: 0,
    waitTime: 4,
    status: 'no-answer',
    startTime: new Date('2026-02-07T14:38:00'),
    endTime: new Date('2026-02-07T14:38:04'),
    callSid: 'CA6c65f2293fc3b624a7f717187ecbbfc6',
    queueTime: 0,
    parentCall: 'CAa67c67a8cd56d2d4ed0091d4d5ad2772',
    twilioDirection: 'outbound-dial (corrected to: inbound)'
  },
  {
    id: '8',
    direction: 'outgoing',
    from: '+1 (617) 500-6181',
    to: '+1 (508) 514-0320',
    totalDuration: 2,
    talkTime: 0,
    waitTime: 2,
    status: 'no-answer',
    startTime: new Date('2026-02-07T14:36:00'),
    endTime: new Date('2026-02-07T14:36:02'),
    callSid: 'CA49e2d7e353237cdfcba9d27c9c2bf3a8',
    queueTime: 0,
    parentCall: 'CA7777081639263104c0e995c85f696393',
    twilioDirection: 'outbound-dial (corrected to: external)'
  },
  {
    id: '9',
    direction: 'outgoing',
    from: '+1 (617) 500-6181',
    to: '+1 (508) 514-0320',
    totalDuration: 4,
    talkTime: 0,
    waitTime: 4,
    status: 'no-answer',
    startTime: new Date('2026-02-07T14:36:00'),
    endTime: new Date('2026-02-07T14:36:04'),
    callSid: 'CA4688d671a502c53369bdbfc656d43ca0',
    queueTime: 0,
    parentCall: 'CAb268556cc9b471cfedbfab2dfee47af1',
    twilioDirection: 'outbound-dial (corrected to: external)'
  },
  {
    id: '10',
    direction: 'outgoing',
    from: '+1 (617) 500-6181',
    to: '+74715085140320',
    totalDuration: 1,
    talkTime: 0,
    waitTime: 1,
    status: 'failed',
    startTime: new Date('2026-02-07T14:35:00'),
    endTime: new Date('2026-02-07T14:35:01'),
    cost: 0,
    callSid: 'CAa7be521fbaf87ef6eb53648b38b79815',
    queueTime: 0,
    parentCall: 'CA2d17feac70b3f2c95a7d5c99afca24cb',
    twilioDirection: 'outbound-dial (corrected to: external)'
  }
];

export default function App() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <div className="max-w-7xl mx-auto p-6">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-3 bg-blue-600 text-white rounded-lg">
              <Phone className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Call History</h1>
              <p className="text-gray-600">+1 (617) 500-6181</p>
            </div>
          </div>
          <p className="text-sm text-gray-500 mt-2">
            Showing {mockCalls.length} calls from the last 24 hours
          </p>
        </div>

        {/* Call List */}
        <ScrollArea className="h-[calc(100vh-200px)]">
          <div className="space-y-4 pr-4">
            {mockCalls.map((call) => (
              <CallListItem key={call.id} call={call} />
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
