// ---------------------------------------------------------------------------
// Client-side API helper — wraps fetch calls to the Next.js API routes
// ---------------------------------------------------------------------------

/**
 * Base fetch wrapper with auth credentials.
 */
export async function apiFetch<T = any>(
  url: string,
  options?: RequestInit
): Promise<T> {
  const token =
    typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options?.headers || {})
  };

  const finalUrl =
    url.startsWith('/api/') || url.startsWith('http') ? url : `/api${url}`;

  const res = await fetch(finalUrl, {
    credentials: 'include',
    ...options,
    headers
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || body.message || `API error: ${res.status}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Lead {
  id: string;
  name: string;
  handle: string;
  platform: string;
  status: string;
  qualityScore: number;
  triggerType: string;
  triggerSource?: string | null;
  createdAt: string;
  updatedAt: string;
  conversation?: { id: string; aiActive: boolean; unreadCount: number } | null;
  tags?: Array<{ tag: { id: string; name: string; color: string } }>;
}

export interface Conversation {
  id: string;
  leadId: string;
  leadName: string;
  leadHandle: string;
  platform: string;
  status: string;
  aiActive: boolean;
  lastMessage: string;
  lastMessageAt: string | null;
  unreadCount: number;
  priorityScore: number;
  qualityScore: number;
  tags: Array<{ id: string; name: string; color: string }>;
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  sender: string;
  content: string;
  isVoiceNote?: boolean;
  voiceNoteUrl?: string | null;
  timestamp?: string;
  sentAt?: string;
  stage?: string | null;
  stageConfidence?: number | null;
  sentimentScore?: number | null;
  followUpAttemptNumber?: number | null;
  systemPromptVersion?: string | null;
}

export interface OverviewStats {
  totalLeads: number;
  leadsToday: number;
  leadsThisWeek: number;
  activeConversations: number;
  callsBooked: number;
  callsBookedThisWeek: number;
  revenue: number;
  revenueThisMonth: number;
  conversionRate: number;
  avgResponseTime: number;
  aiReplyRate: number;
  showRate: number;
  closeRate: number;
  noShowRate: number;
  qualifiedRate: number;
  ghostRate: number;
  avgMessagesToBook: number;
  topTrigger: string;
  topTriggerConversion: number;
}

export interface LeadVolumePoint {
  date: string;
  count: number;
}

export interface FunnelStep {
  stage: string;
  count: number;
  percentage: number;
}

export interface TriggerPerformanceItem {
  source: string;
  trigger: string;
  leads: number;
  booked: number;
  conversionRate: number;
}

export interface RevenuePoint {
  date: string;
  revenue: number;
  cumulative: number;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarUrl?: string | null;
  leadsHandled: number;
  callsBooked: number;
  closeRate: number | null;
  avgResponseTime: number | null;
  totalCommission: number;
  isActive: boolean;
  createdAt: string;
}

export interface TeamMemberStats extends TeamMember {
  rank: number;
  messagesSent: number;
  conversionRate: number;
  bookingRate: number;
  score: number;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  leadId?: string | null;
  isRead: boolean;
  createdAt: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  isAuto: boolean;
  leadsCount?: number;
  createdAt?: string;
}

export interface TeamNote {
  id: string;
  content: string;
  leadId: string;
  authorId: string;
  createdAt: string;
  author?: { name: string; role: string; avatarUrl?: string | null };
}

export interface ContentAttribution {
  id: string;
  contentType: string;
  contentId?: string | null;
  contentUrl?: string | null;
  caption?: string | null;
  platform: string;
  leadsCount: number;
  revenue: number;
  callsBooked: number;
  conversionRate: number;
  showRate: number;
  postedAt?: string | null;
  createdAt: string;
}

export interface ContentAnalytics {
  attributions: ContentAttribution[];
  summary: {
    totalContent: number;
    totalLeads: number;
    totalRevenue: number;
    totalCallsBooked: number;
  };
}

export interface TeamAnalytics {
  members: TeamMemberStats[];
  summary: {
    totalLeadsHandled: number;
    totalCallsBooked: number;
    avgCloseRate: number;
    totalCommission: number;
  };
}

// ---------------------------------------------------------------------------
// API Functions
// ---------------------------------------------------------------------------

export async function getLeads(params?: Record<string, string>): Promise<{
  leads: Lead[];
  total: number;
}> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return apiFetch(`/api/leads${qs}`);
}

export async function getConversations(
  params?: Record<string, string>
): Promise<{ conversations: Conversation[] }> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return apiFetch(`/api/conversations${qs}`);
}

export async function getConversation(
  id: string
): Promise<{ conversation: any }> {
  return apiFetch(`/api/conversations/${id}`);
}

export async function getMessages(
  conversationId: string,
  params?: Record<string, string>
): Promise<{ messages: Message[] }> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return apiFetch(`/api/conversations/${conversationId}/messages${qs}`);
}

export async function sendMessage(
  conversationId: string,
  content: string,
  sender: string = 'HUMAN'
): Promise<Message> {
  return apiFetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, sender })
  });
}

export async function toggleAI(
  conversationId: string,
  aiActive: boolean
): Promise<any> {
  return apiFetch(`/api/conversations/${conversationId}/toggle-ai`, {
    method: 'POST',
    body: JSON.stringify({ aiActive })
  });
}

export async function getOverviewStats(): Promise<OverviewStats> {
  return apiFetch('/api/analytics/overview');
}

export async function getLeadVolume(
  params?: Record<string, string>
): Promise<LeadVolumePoint[]> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const data = await apiFetch(`/api/analytics/lead-volume${qs}`);
  return data.points || data;
}

export async function getFunnel(): Promise<FunnelStep[]> {
  const data = await apiFetch('/api/analytics/funnel');
  return data.steps || data;
}

export async function getTriggerPerformance(): Promise<
  TriggerPerformanceItem[]
> {
  const data = await apiFetch('/api/analytics/triggers');
  return data.triggers || data;
}

export async function getRevenue(
  params?: Record<string, string>
): Promise<RevenuePoint[]> {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const data = await apiFetch(`/api/analytics/revenue${qs}`);
  return data.points || data;
}

export async function getTeam(): Promise<TeamMember[]> {
  const data = await apiFetch('/api/team');
  return data.members || data;
}

export async function getNotifications(): Promise<Notification[]> {
  const data = await apiFetch('/api/notifications');
  return data.notifications || data;
}

export async function markAllNotificationsRead(): Promise<void> {
  await apiFetch('/api/notifications/mark-read', { method: 'POST' });
}

export async function getTags(): Promise<Tag[]> {
  const data = await apiFetch('/api/tags');
  return data.tags || data;
}

export async function createTag(
  nameOrObj: string | { name: string; color?: string },
  color?: string
): Promise<Tag> {
  const payload =
    typeof nameOrObj === 'string' ? { name: nameOrObj, color } : nameOrObj;
  return apiFetch('/api/tags', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function deleteTag(id: string): Promise<void> {
  await apiFetch(`/api/tags/${id}`, { method: 'DELETE' });
}

export async function getTeamNotes(leadId: string): Promise<TeamNote[]> {
  const data = await apiFetch(`/api/leads/${leadId}/notes`);
  return data.notes || data;
}

export async function createTeamNote(
  leadId: string,
  content: string
): Promise<TeamNote> {
  return apiFetch(`/api/leads/${leadId}/notes`, {
    method: 'POST',
    body: JSON.stringify({ content })
  });
}

export async function deleteTeamNote(
  leadId: string,
  noteId: string
): Promise<void> {
  await apiFetch(`/api/leads/${leadId}/notes/${noteId}`, {
    method: 'DELETE'
  });
}

export async function getContentAttributions(): Promise<ContentAttribution[]> {
  const data = await apiFetch('/api/content');
  return data.attributions || data;
}

export async function getContentAnalytics(): Promise<ContentAnalytics> {
  return apiFetch('/api/analytics/content');
}

export async function getTeamAnalytics(): Promise<TeamAnalytics> {
  return apiFetch('/api/analytics/team');
}

// ---------------------------------------------------------------------------
// Voice Note Library
// ---------------------------------------------------------------------------

export interface VoiceNoteLibraryItem {
  id: string;
  accountId: string;
  audioFileUrl: string;
  durationSeconds: number;
  uploadedAt: string;
  transcript: string | null;
  summary: string | null;
  useCases: string[];
  leadTypes: string[];
  conversationStages: string[];
  emotionalTone: string | null;
  triggerConditionsNatural: string | null;
  boundToScriptStep: string | null;
  userLabel: string | null;
  userNotes: string | null;
  priority: number;
  active: boolean;
  status: 'PROCESSING' | 'NEEDS_REVIEW' | 'ACTIVE' | 'DISABLED' | 'FAILED';
  errorMessage: string | null;
  createdAt: string;
  lastEditedAt: string;
}

export async function getVoiceNotes(
  search?: string
): Promise<{ items: VoiceNoteLibraryItem[] }> {
  const qs = search ? `?search=${encodeURIComponent(search)}` : '';
  return apiFetch(`/api/voice-notes${qs}`);
}

export async function getVoiceNote(
  id: string
): Promise<{ item: VoiceNoteLibraryItem }> {
  return apiFetch(`/api/voice-notes/${id}`);
}

export async function updateVoiceNote(
  id: string,
  data: Partial<VoiceNoteLibraryItem>
): Promise<{ item: VoiceNoteLibraryItem }> {
  return apiFetch(`/api/voice-notes/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  });
}

export async function deleteVoiceNote(
  id: string
): Promise<{ success: boolean }> {
  return apiFetch(`/api/voice-notes/${id}`, { method: 'DELETE' });
}

export async function uploadVoiceNote(
  file: File
): Promise<{ item: VoiceNoteLibraryItem }> {
  const formData = new FormData();
  formData.append('audio', file);

  const token =
    typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  const headers: HeadersInit = token
    ? { Authorization: `Bearer ${token}` }
    : {};

  const res = await fetch('/api/voice-notes/upload', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: formData
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Upload failed: ${res.status}`);
  }

  return res.json();
}

export async function processVoiceNote(
  id: string
): Promise<{ item: VoiceNoteLibraryItem }> {
  return apiFetch(`/api/voice-notes/${id}/process`, { method: 'POST' });
}

export async function retryVoiceNote(
  id: string
): Promise<{ success: boolean }> {
  return apiFetch(`/api/voice-notes/${id}/retry`, { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Voice Note Timing Settings
// ---------------------------------------------------------------------------

export interface VoiceNoteTimingSettings {
  minDelay: number;
  maxDelay: number;
}

export async function getVoiceNoteTimingSettings(): Promise<VoiceNoteTimingSettings> {
  return apiFetch('/api/voice-notes/timing-settings');
}

export async function updateVoiceNoteTimingSettings(
  data: Partial<VoiceNoteTimingSettings>
): Promise<VoiceNoteTimingSettings> {
  return apiFetch('/api/voice-notes/timing-settings', {
    method: 'PUT',
    body: JSON.stringify(data)
  });
}
