'use client';

import { useState, useEffect } from 'react';
import { NotesPanel } from '@/features/team-notes/components/notes-panel';
import { SummaryTab } from './summary-tab';
import { ScoreTab } from './score-tab';
import { apiFetch } from '@/lib/api';
import {
  IconFileText,
  IconFlame,
  IconMessageCircle
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';

type SidebarTab = 'summary' | 'score' | 'notes';

interface ConversationSidebarProps {
  conversationId: string;
  leadId: string;
  leadName: string;
  leadHandle: string;
  platform: string;
  status: string;
  aiActive: boolean;
  qualityScore: number;
  priorityScore: number;
  tags?: Array<{ id: string; name: string; color: string }>;
  messages: Array<{
    id: string;
    sender: string;
    content: string;
    timestamp: string;
    stage?: string | null;
    sentimentScore?: number | null;
    objectionType?: string | null;
    stallType?: string | null;
    gotResponse?: boolean | null;
    responseTimeSeconds?: number | null;
  }>;
  createdAt?: string;
}

const TABS: { key: SidebarTab; label: string; icon: typeof IconFlame }[] = [
  { key: 'summary', label: 'Summary', icon: IconFileText },
  { key: 'score', label: 'Score', icon: IconFlame },
  { key: 'notes', label: 'Notes', icon: IconMessageCircle }
];

export function ConversationSidebar({
  conversationId,
  leadId,
  leadName,
  leadHandle,
  platform,
  status,
  aiActive,
  qualityScore,
  priorityScore,
  tags,
  messages,
  createdAt
}: ConversationSidebarProps) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('summary');
  const [detail, setDetail] = useState<any>(null);

  // Fetch enriched conversation detail for summary/score tabs
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    apiFetch(`/api/conversations/${conversationId}`)
      .then((data: any) => {
        if (!cancelled) {
          setDetail(data?.conversation ?? data ?? null);
        }
      })
      .catch(() => {
        // Non-critical — tabs still work with basic data
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  return (
    <div className='flex h-full flex-col'>
      {/* Tab Bar */}
      <div className='flex shrink-0 border-b'>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium transition-colors',
              activeTab === tab.key
                ? 'border-primary text-primary border-b-2'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <tab.icon className='h-3.5 w-3.5' />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
        {activeTab === 'summary' && (
          <SummaryTab
            leadName={leadName}
            leadHandle={leadHandle}
            platform={platform}
            status={status}
            aiActive={aiActive}
            tags={tags}
            messages={messages}
            detail={detail}
            createdAt={createdAt}
          />
        )}
        {activeTab === 'score' && (
          <ScoreTab
            qualityScore={qualityScore}
            priorityScore={priorityScore}
            status={status}
            messages={messages}
            detail={detail}
          />
        )}
        {activeTab === 'notes' && (
          <NotesPanel leadId={leadId} leadName={leadName} />
        )}
      </div>
    </div>
  );
}
