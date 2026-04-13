'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  getLeads,
  getConversations,
  getConversation as fetchConversation,
  getMessages,
  getOverviewStats,
  getLeadVolume,
  getFunnel,
  getTriggerPerformance,
  getRevenue,
  getTeam,
  getNotifications,
  getTags,
  getTeamNotes,
  getContentAttributions,
  getContentAnalytics,
  getTeamAnalytics,
  getLeadStageHistory
} from '@/lib/api';
import type {
  Lead,
  Conversation,
  Message,
  OverviewStats,
  LeadVolumePoint,
  FunnelStep,
  TriggerPerformanceItem,
  RevenuePoint,
  TeamMember,
  Notification,
  Tag,
  TeamNote,
  ContentAttribution,
  ContentAnalytics,
  TeamAnalytics
} from '@/lib/api';

// ---------------------------------------------------------------------------
// Generic fetcher helper
// ---------------------------------------------------------------------------

function useApiFetch<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback((silent = false) => {
    let cancelled = false;
    if (!silent) {
      setLoading(true);
      setError(null);
    }

    fetcher()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled && !silent)
          setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    const cleanup = fetch(false);
    return cleanup;
  }, [fetch]);

  // Silent refetch — updates data without showing loading state
  const refetch = useCallback(() => {
    fetch(true);
  }, [fetch]);

  return { data, loading, error, refetch };
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export function useLeads(params?: {
  stage?: string;
  platform?: string;
  search?: string;
  tag?: string;
  page?: number;
  limit?: number;
}) {
  const { data, loading, error, refetch } = useApiFetch(() => {
    const stringParams = params
      ? Object.fromEntries(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)])
        )
      : undefined;
    return getLeads(stringParams);
  }, [
    params?.stage,
    params?.platform,
    params?.search,
    params?.tag,
    params?.page,
    params?.limit
  ]);

  return {
    leads: data?.leads ?? ([] as Lead[]),
    total: data?.total ?? 0,
    loading,
    error,
    refetch
  };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export function useConversations(
  search?: string,
  priority?: boolean,
  unread?: boolean,
  platform?: string
) {
  const {
    data: raw,
    loading,
    error,
    refetch
  } = useApiFetch(() => {
    const p: Record<string, string> = {};
    if (search) p.search = search;
    if (priority) p.priority = 'true';
    if (unread) p.unread = 'true';
    if (platform) p.platform = platform;
    return getConversations(Object.keys(p).length ? p : undefined);
  }, [search, priority, unread, platform]);
  // API returns { conversations: [...] } — unwrap
  const conversations = Array.isArray(raw)
    ? raw
    : ((raw as any)?.conversations ?? []);

  return {
    conversations: conversations as Conversation[],
    loading,
    error,
    refetch
  };
}

export function useConversation(id: string | undefined) {
  const {
    data: raw,
    loading,
    error,
    refetch
  } = useApiFetch(
    () => (id ? fetchConversation(id) : Promise.resolve(null)),
    [id]
  );
  // API returns { conversation: {...} } — unwrap
  const conversation =
    ((raw as any)?.conversation ?? (raw as any)?.id) ? raw : null;

  return {
    conversation: conversation as Conversation | null,
    loading,
    error,
    refetch
  };
}

export function useMessages(
  conversationId: string | undefined,
  limit?: number
) {
  const {
    data: raw,
    loading,
    error,
    refetch
  } = useApiFetch(
    () =>
      conversationId
        ? getMessages(
            conversationId,
            limit ? { limit: String(limit) } : undefined
          )
        : Promise.resolve({ messages: [] as Message[] }),
    [conversationId, limit]
  );
  // API returns { messages: [...] } — unwrap and normalize field names
  const rawMessages = Array.isArray(raw) ? raw : ((raw as any)?.messages ?? []);
  const messages = rawMessages.map((m: any) => ({
    ...m,
    sentAt: m.sentAt || m.timestamp // Prisma returns `timestamp`, frontend expects `sentAt`
  }));

  return {
    messages: messages as Message[],
    loading,
    error,
    refetch
  };
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export function useOverviewStats() {
  const { data, loading, error } = useApiFetch(() => getOverviewStats(), []);

  return {
    stats: data as OverviewStats | null,
    loading,
    error
  };
}

export function useLeadVolume() {
  const { data: raw, loading, error } = useApiFetch(() => getLeadVolume(), []);
  // API returns { data: [...] } — unwrap the array
  const data = Array.isArray(raw) ? raw : ((raw as any)?.data ?? []);

  return {
    data: data as LeadVolumePoint[],
    loading,
    error
  };
}

export function useFunnel() {
  const { data: raw, loading, error } = useApiFetch(() => getFunnel(), []);

  // API returns { totalLeads, qualified, booked, showedUp, closed } — transform to FunnelStep[]
  let data: FunnelStep[] = [];
  if (raw && !Array.isArray(raw)) {
    const r = raw as any;
    const total = r.totalLeads || 1;
    data = [
      { stage: 'Total Leads', count: r.totalLeads || 0, percentage: 100 },
      {
        stage: 'Qualified',
        count: r.qualified || 0,
        percentage: Math.round(((r.qualified || 0) / total) * 100)
      },
      {
        stage: 'Booked',
        count: r.booked || 0,
        percentage: Math.round(((r.booked || 0) / total) * 100)
      },
      {
        stage: 'Showed Up',
        count: r.showedUp || 0,
        percentage: Math.round(((r.showedUp || 0) / total) * 100)
      },
      {
        stage: 'Closed',
        count: r.closed || 0,
        percentage: Math.round(((r.closed || 0) / total) * 100)
      }
    ];
  } else if (Array.isArray(raw)) {
    data = raw as FunnelStep[];
  }

  return {
    data,
    loading,
    error
  };
}

export function useTriggerPerformance() {
  const {
    data: raw,
    loading,
    error
  } = useApiFetch(() => getTriggerPerformance(), []);
  const data = Array.isArray(raw) ? raw : ((raw as any)?.data ?? []);

  return {
    data: data as TriggerPerformanceItem[],
    loading,
    error
  };
}

export function useRevenueData() {
  const { data: raw, loading, error } = useApiFetch(() => getRevenue(), []);
  const data = Array.isArray(raw) ? raw : ((raw as any)?.data ?? []);

  return {
    data: data as RevenuePoint[],
    loading,
    error
  };
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export function useTeam() {
  const {
    data: raw,
    loading,
    error,
    refetch
  } = useApiFetch(() => getTeam(), []);
  // API may return array directly or { members: [...] } or { data: [...] }
  const members = Array.isArray(raw)
    ? raw
    : ((raw as any)?.members ?? (raw as any)?.data ?? []);

  return {
    members: members as TeamMember[],
    loading,
    error,
    refetch
  };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function useNotifications(userId?: string) {
  const { data, loading, error, refetch } = useApiFetch(
    () => getNotifications(),
    [userId]
  );

  const notifications = Array.isArray(data)
    ? data
    : ((data as any)?.notifications ?? []);
  const unreadCount = notifications.filter((n: any) => !n.isRead).length;

  return {
    notifications: notifications as Notification[],
    unreadCount,
    loading,
    error,
    refetch
  };
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export function useTags() {
  const { data, loading, error, refetch } = useApiFetch(() => getTags(), []);
  const tags = (data as any)?.tags ?? ([] as Tag[]);

  return {
    tags: tags as Tag[],
    loading,
    error,
    refetch
  };
}

// ---------------------------------------------------------------------------
// Team Notes
// ---------------------------------------------------------------------------

export function useTeamNotes(leadId: string | undefined, page?: number) {
  const {
    data: raw,
    loading,
    error,
    refetch
  } = useApiFetch(
    () => (leadId ? getTeamNotes(leadId) : Promise.resolve([] as TeamNote[])),
    [leadId, page]
  );

  const notes = Array.isArray(raw) ? raw : ((raw as any)?.notes ?? []);

  return {
    notes: notes as TeamNote[],
    total: notes.length,
    loading,
    error,
    refetch
  };
}

// ---------------------------------------------------------------------------
// Content Attribution
// ---------------------------------------------------------------------------

export function useContentAttributions(params?: {
  contentType?: string;
  platform?: string;
  sortBy?: string;
  page?: number;
  limit?: number;
}) {
  const { data, loading, error, refetch } = useApiFetch(
    () => getContentAttributions(),
    [
      params?.contentType,
      params?.platform,
      params?.sortBy,
      params?.page,
      params?.limit
    ]
  );

  return {
    content: (data as any)?.content ?? ([] as ContentAttribution[]),
    total: (data as any)?.total ?? 0,
    totals: (data as any)?.totals ?? {
      totalLeads: 0,
      totalRevenue: 0,
      totalCallsBooked: 0
    },
    loading,
    error,
    refetch
  };
}

export function useContentAnalytics(from?: string, to?: string) {
  const { data, loading, error } = useApiFetch(
    () => getContentAnalytics(),
    [from, to]
  );

  return {
    analytics: data as ContentAnalytics | null,
    loading,
    error
  };
}

// ---------------------------------------------------------------------------
// Team Performance Analytics
// ---------------------------------------------------------------------------

export function useTeamAnalytics(from?: string, to?: string) {
  const { data, loading, error } = useApiFetch(
    () => getTeamAnalytics(),
    [from, to]
  );

  return {
    analytics: data as TeamAnalytics | null,
    loading,
    error
  };
}

// ---------------------------------------------------------------------------
// Lead Stage History
// ---------------------------------------------------------------------------

export function useLeadStageHistory(leadId: string | undefined) {
  const {
    data: raw,
    loading,
    error,
    refetch
  } = useApiFetch(
    () =>
      leadId
        ? getLeadStageHistory(leadId)
        : Promise.resolve({ transitions: [] }),
    [leadId]
  );

  const transitions = Array.isArray(raw)
    ? raw
    : ((raw as any)?.transitions ?? []);

  return {
    transitions,
    loading,
    error,
    refetch
  };
}
