export interface Message {
  id: string;
  sender: 'ai' | 'lead' | 'human';
  content: string;
  timestamp: string;
  isVoiceNote?: boolean;
  voiceNoteUrl?: string;
  imageUrl?: string | null;
  hasImage?: boolean;
  isHumanOverride?: boolean;
  humanOverrideNote?: string | null;
  // Operator identity for HUMAN messages. Populated from Message.sentByUser
  // when the app's POST /messages endpoint is used. NULL for legacy rows
  // and for webhook-originated admin messages (operator sent from Meta
  // Inbox directly, so we don't have their userId). UI renders the name
  // in the "Human Setter" label when present.
  sentByUser?: { id: string; name: string; email?: string } | null;
  // Where a HUMAN message originated:
  //   'DASHBOARD' — typed into the QualifyDMs app (POST /messages)
  //   'PHONE'     — sent from the native Instagram / Messenger app,
  //                 captured via is_echo=true webhook
  // Null on AI / LEAD senders and legacy rows.
  humanSource?: 'DASHBOARD' | 'PHONE' | null;
  // Multi-bubble grouping. Null for legacy / single-message rows — the
  // renderer treats absence as an implicit 1-bubble group. Present
  // rows with the same messageGroupId render together with tight
  // spacing and share a single timestamp on the last bubble.
  messageGroupId?: string | null;
  bubbleIndex?: number | null;
  bubbleTotalCount?: number | null;
}

export interface ConversationTag {
  id: string;
  name: string;
  color: string;
}

export interface Conversation {
  id: string;
  leadName: string;
  leadUsername: string;
  platform: 'instagram' | 'facebook';
  stage: string;
  aiActive: boolean;
  lastMessage: string;
  lastMessageTime: string;
  unread: number;
  messages: Message[];
  tags?: ConversationTag[];
  priorityScore?: number;
  qualityScore?: number;
  /** ISO string of a scheduled call, null if none. Used for sidebar badges. */
  scheduledCallAt?: string | null;
  /** True when the AI has a reply pending operator review (⚡ icon in list). */
  hasPendingSuggestion?: boolean;
}

export const conversations: Conversation[] = [
  {
    id: '1',
    leadName: 'Marcus Johnson',
    leadUsername: 'marcus_johnson',
    platform: 'instagram',
    stage: 'booked',
    aiActive: true,
    lastMessage: "Perfect, you're all set for tomorrow at 2 PM!",
    lastMessageTime: '9:30 AM',
    unread: 0,
    messages: [
      {
        id: 'm1',
        sender: 'lead',
        content:
          'Hey I saw your post about the trading accelerator, interested!',
        timestamp: '2024-03-17T14:00:00Z'
      },
      {
        id: 'm2',
        sender: 'ai',
        content:
          'Yo Marcus! Appreciate you reaching out bro. So what got you interested in trading?',
        timestamp: '2024-03-17T14:07:00Z'
      },
      {
        id: 'm3',
        sender: 'lead',
        content:
          'Been watching forex content for months, tried a few things but nothing sticks',
        timestamp: '2024-03-17T14:12:00Z'
      },
      {
        id: 'm4',
        sender: 'ai',
        content:
          "I feel that 100%. Most people try random strategies from YouTube without a real system. What's your biggest challenge right now?",
        timestamp: '2024-03-17T14:20:00Z'
      },
      {
        id: 'm5',
        sender: 'lead',
        content:
          'Consistency. I can make money some weeks but then give it all back',
        timestamp: '2024-03-17T14:25:00Z'
      },
      {
        id: 'm6',
        sender: 'ai',
        content:
          "That's literally the #1 thing we fix in the accelerator. Let me send you something real quick...",
        timestamp: '2024-03-17T14:33:00Z',
        isVoiceNote: true
      },
      {
        id: 'm7',
        sender: 'lead',
        content: 'Bro that makes so much sense. When can we talk?',
        timestamp: '2024-03-17T14:40:00Z'
      },
      {
        id: 'm8',
        sender: 'ai',
        content:
          'Love the energy! I got some slots open. Tomorrow at 2 PM or Wednesday at 10 AM work?',
        timestamp: '2024-03-17T14:48:00Z'
      },
      {
        id: 'm9',
        sender: 'lead',
        content: 'Tomorrow 2 PM is perfect',
        timestamp: '2024-03-17T14:50:00Z'
      },
      {
        id: 'm10',
        sender: 'ai',
        content:
          "Perfect, you're all set for tomorrow at 2 PM! You'll get a calendar invite. Come ready to talk about your goals.",
        timestamp: '2024-03-17T14:55:00Z'
      }
    ]
  },
  {
    id: '2',
    leadName: 'Sarah Mitchell',
    leadUsername: 'sarah_mitchell',
    platform: 'instagram',
    stage: 'engaged',
    aiActive: true,
    lastMessage: 'That sounds amazing, tell me more about the results',
    lastMessageTime: '10:15 AM',
    unread: 2,
    messages: [
      {
        id: 'm11',
        sender: 'lead',
        content: 'Hi! Your results are insane, how do you do it?',
        timestamp: '2024-03-18T08:00:00Z'
      },
      {
        id: 'm12',
        sender: 'ai',
        content:
          "Hey Sarah! Thanks for the love. It's all about having a proven system. What's your trading experience like?",
        timestamp: '2024-03-18T08:08:00Z'
      },
      {
        id: 'm13',
        sender: 'lead',
        content: "I'm pretty new, been paper trading for about 2 months",
        timestamp: '2024-03-18T08:15:00Z'
      },
      {
        id: 'm14',
        sender: 'ai',
        content:
          "That's actually a great place to start. Most people who come through our program at that stage see the fastest growth.",
        timestamp: '2024-03-18T08:22:00Z'
      },
      {
        id: 'm15',
        sender: 'lead',
        content: 'That sounds amazing, tell me more about the results',
        timestamp: '2024-03-18T10:15:00Z'
      }
    ]
  },
  {
    id: '3',
    leadName: 'Jaylen Williams',
    leadUsername: 'jaylen_williams',
    platform: 'instagram',
    stage: 'qualifying',
    aiActive: false,
    lastMessage: 'I\'ve been burned before by these "gurus"...',
    lastMessageTime: 'Yesterday',
    unread: 1,
    messages: [
      {
        id: 'm16',
        sender: 'lead',
        content: 'Saw your ad. Is this legit or another scam?',
        timestamp: '2024-03-17T15:00:00Z'
      },
      {
        id: 'm17',
        sender: 'ai',
        content:
          "I get it bro, there's a lot of BS out there. I'm not here to sell you dreams. Let me ask you something — what made you stop scrolling on that post?",
        timestamp: '2024-03-17T15:08:00Z'
      },
      {
        id: 'm18',
        sender: 'lead',
        content:
          'The P&L screenshots looked real. But I\'ve been burned before by these "gurus"...',
        timestamp: '2024-03-17T15:15:00Z'
      },
      {
        id: 'm19',
        sender: 'ai',
        content: "Facts. And you should be skeptical. That's actually smart.",
        timestamp: '2024-03-17T15:22:00Z',
        isVoiceNote: true
      },
      {
        id: 'm20',
        sender: 'human',
        content:
          'Hey Jaylen, this is Daniel personally. I understand the skepticism 100%. Let me share some student results with you...',
        timestamp: '2024-03-17T22:00:00Z'
      }
    ]
  },
  {
    id: '4',
    leadName: 'Alex Rodriguez',
    leadUsername: 'alex.rodriguez',
    platform: 'instagram',
    stage: 'qualifying',
    aiActive: true,
    lastMessage: 'I currently work a 9-5 but I want to go full time trading',
    lastMessageTime: '11:00 AM',
    unread: 1,
    messages: [
      {
        id: 'm21',
        sender: 'lead',
        content: 'Hey! I want to learn forex trading seriously',
        timestamp: '2024-03-18T09:00:00Z'
      },
      {
        id: 'm22',
        sender: 'ai',
        content:
          "Respect for being serious about it, Alex! What's your current situation? Are you working, in school, or full-time trading?",
        timestamp: '2024-03-18T09:07:00Z'
      },
      {
        id: 'm23',
        sender: 'lead',
        content: 'I currently work a 9-5 but I want to go full time trading',
        timestamp: '2024-03-18T11:00:00Z'
      }
    ]
  },
  {
    id: '5',
    leadName: 'David Kim',
    leadUsername: 'david.kim',
    platform: 'facebook',
    stage: 'booked',
    aiActive: true,
    lastMessage: 'Awesome, Wed 10 AM works. See you then!',
    lastMessageTime: '8:00 AM',
    unread: 0,
    messages: [
      {
        id: 'm24',
        sender: 'lead',
        content:
          "Your trading journey is inspiring. I'd love to learn more about your program.",
        timestamp: '2024-03-17T10:00:00Z'
      },
      {
        id: 'm25',
        sender: 'ai',
        content:
          "Appreciate that David! The journey's been crazy. Let me ask — what's your #1 goal with trading right now?",
        timestamp: '2024-03-17T10:08:00Z'
      },
      {
        id: 'm26',
        sender: 'lead',
        content:
          'Financial freedom. I want to quit my corporate job within a year.',
        timestamp: '2024-03-17T10:20:00Z'
      },
      {
        id: 'm27',
        sender: 'ai',
        content:
          "That's exactly what our accelerator is built for. We've had 3 students do exactly that in the last 6 months. Ready to hop on a call and map it out?",
        timestamp: '2024-03-17T10:28:00Z'
      },
      {
        id: 'm28',
        sender: 'lead',
        content: 'Yes definitely! When works?',
        timestamp: '2024-03-17T10:35:00Z'
      },
      {
        id: 'm29',
        sender: 'ai',
        content: "Wednesday at 10 AM or Thursday at 3 PM — what's better?",
        timestamp: '2024-03-17T10:42:00Z'
      },
      {
        id: 'm30',
        sender: 'lead',
        content: 'Wednesday 10 AM',
        timestamp: '2024-03-17T10:45:00Z'
      },
      {
        id: 'm31',
        sender: 'ai',
        content:
          'Awesome, Wed 10 AM works. See you then! Calendar invite coming your way.',
        timestamp: '2024-03-18T08:00:00Z'
      }
    ]
  }
];
