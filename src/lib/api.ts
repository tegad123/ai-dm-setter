const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

// ---------------------------------------------------------------------------
// Core fetch wrapper
// ---------------------------------------------------------------------------

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>)
  };

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include' // Send Clerk session cookies
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      (body as { detail?: string })?.detail ||
      (body as { message?: string })?.message ||
      res.statusText;
    throw new ApiError(message, res.status, body);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function login(email: string, password: string) {
  return apiFetch<{ access_token: string; token_type: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
}

export async function register(name: string, email: string, password: string) {
  return apiFetch<{ id: string; name: string; email: string; role: string }>(
    '/auth/register',
    { method: 'POST', body: JSON.stringify({ name, email, password }) }
  );
}

export async function getMe() {
  return apiFetch<{
    id: string;
    name: string;
    email: string;
    role: string;
    avatar?: string;
  }>('/auth/me');
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export interface Lead {
  id: string;
  name: string;
  handle: string;
  platform: string;
  status: string;
  triggerType: string;
  triggerSource?: string;
  qualityScore?: number;
  bookedAt?: string;
  showedUp?: boolean;
  closedAt?: string;
  revenue?: number;
  createdAt: string;
  updatedAt: string;
}

export interface LeadsResponse {
  leads: Lead[];
  total: number;
  page: number;
  limit: number;
}

export async function getLeads(params?: {
  status?: string;
  platform?: string;
  search?: string;
  tag?: string;
  page?: number;
  limit?: number;
}) {
  const query = new URLSearchParams();
  if (params?.status) query.set('status', params.status);
  if (params?.platform) query.set('platform', params.platform);
  if (params?.search) query.set('search', params.search);
  if (params?.tag) query.set('tag', params.tag);
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return apiFetch<LeadsResponse>(`/leads${qs ? `?${qs}` : ''}`);
}

export async function getLead(id: string) {
  return apiFetch<Lead>(`/leads/${id}`);
}

export async function createLead(data: {
  name: string;
  handle: string;
  platform: string;
  triggerType: string;
  triggerSource?: string;
}) {
  return apiFetch<Lead>('/leads', {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

export async function updateLead(
  id: string,
  data: Partial<{
    status: string;
    qualityScore: number;
    bookedAt: string;
    showedUp: boolean;
    closedAt: string;
    revenue: number;
  }>
) {
  return apiFetch<Lead>(`/leads/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data)
  });
}

export async function deleteLead(id: string) {
  return apiFetch<void>(`/leads/${id}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface Conversation {
  id: string;
  leadId: string;
  leadName: string;
  leadHandle: string;
  platform: string;
  status: string;
  aiActive: boolean;
  lastMessage?: string;
  lastMessageAt?: string;
  unreadCount: number;
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  content: string;
  sender: string;
  sentAt: string;
}

export async function getConversations(
  search?: string,
  priority?: boolean,
  unread?: boolean
) {
  const query = new URLSearchParams();
  if (search) query.set('search', search);
  if (priority) query.set('priority', 'true');
  if (unread) query.set('unread', 'true');
  const qs = query.toString();
  return apiFetch<Conversation[]>(`/conversations${qs ? `?${qs}` : ''}`);
}

export async function getConversation(id: string) {
  return apiFetch<Conversation>(`/conversations/${id}`);
}

export async function getMessages(conversationId: string, limit?: number) {
  const qs = limit ? `?limit=${limit}` : '';
  return apiFetch<Message[]>(`/conversations/${conversationId}/messages${qs}`);
}

export async function sendMessage(
  conversationId: string,
  content: string,
  sender?: string
) {
  return apiFetch<Message>(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, sender })
  });
}

export async function toggleAI(conversationId: string, aiActive: boolean) {
  return apiFetch<Conversation>(`/conversations/${conversationId}/ai-toggle`, {
    method: 'PATCH',
    body: JSON.stringify({ aiActive })
  });
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface OverviewStats {
  totalLeads: number;
  leadsToday: number;
  callsBooked: number;
  showRate: number;
  closeRate: number;
  revenue: number;
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
  trigger: string;
  leads: number;
  qualified: number;
  booked: number;
  conversionRate: number;
}

export interface RevenuePoint {
  date: string;
  amount: number;
  cumulative: number;
}

export async function getOverviewStats() {
  return apiFetch<OverviewStats>('/analytics/overview');
}

export async function getLeadVolume() {
  return apiFetch<LeadVolumePoint[]>('/analytics/lead-volume');
}

export async function getFunnel() {
  return apiFetch<FunnelStep[]>('/analytics/funnel');
}

export async function getTriggerPerformance() {
  return apiFetch<TriggerPerformanceItem[]>('/analytics/triggers');
}

export async function getRevenue() {
  return apiFetch<RevenuePoint[]>('/analytics/revenue');
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  avatarUrl?: string;
  leadsHandled: number;
  callsBooked: number;
  closeRate: number | null;
  createdAt: string;
  updatedAt: string;
}

export async function getTeam() {
  return apiFetch<TeamMember[]>('/team');
}

export async function createTeamMember(data: {
  name: string;
  email: string;
  password: string;
  role: string;
}) {
  return apiFetch<TeamMember>('/team', {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

export async function updateTeamMember(
  id: string,
  data: Partial<{
    name: string;
    email: string;
    role: string;
    isActive: boolean;
  }>
) {
  return apiFetch<TeamMember>(`/team/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data)
  });
}

export async function deleteTeamMember(id: string) {
  return apiFetch<void>(`/team/${id}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface Notification {
  id: string;
  userId?: string;
  type: string;
  title: string;
  body: string;
  leadId?: string;
  isRead: boolean;
  readAt?: string;
  createdAt: string;
  lead?: { id: string; name: string } | null;
}

export interface NotificationsResponse {
  notifications: Notification[];
  unreadCount: number;
}

export async function getNotifications(userId?: string, unreadOnly?: boolean) {
  const query = new URLSearchParams();
  if (userId) query.set('userId', userId);
  if (unreadOnly) query.set('unreadOnly', 'true');
  const qs = query.toString();
  return apiFetch<NotificationsResponse>(`/notifications${qs ? `?${qs}` : ''}`);
}

export async function markNotificationRead(id: string) {
  return apiFetch<Notification>(`/notifications/${id}/read`, {
    method: 'PATCH'
  });
}

export async function markAllNotificationsRead(userId?: string) {
  return apiFetch<{ count: number }>('/notifications/read-all', {
    method: 'PATCH',
    body: JSON.stringify(userId ? { userId } : {})
  });
}

export async function createNotification(data: {
  userId?: string;
  type: string;
  title: string;
  body: string;
  leadId?: string;
}) {
  return apiFetch<Notification>('/notifications', {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export interface Tag {
  id: string;
  name: string;
  color: string;
  isAuto: boolean;
  leadsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LeadTagInfo {
  id: string;
  name: string;
  color: string;
}

export async function getTags() {
  return apiFetch<{ tags: Tag[] }>('/tags');
}

export async function createTag(data: {
  name: string;
  color?: string;
  isAuto?: boolean;
}) {
  return apiFetch<Tag>('/tags', {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

export async function updateTag(
  id: string,
  data: Partial<{ name: string; color: string; isAuto: boolean }>
) {
  return apiFetch<Tag>(`/tags/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  });
}

export async function deleteTag(id: string) {
  return apiFetch<void>(`/tags/${id}`, { method: 'DELETE' });
}

export async function addTagToLead(
  leadId: string,
  tagId: string,
  appliedBy?: string
) {
  return apiFetch(`/leads/${leadId}/tags`, {
    method: 'POST',
    body: JSON.stringify({ tagId, appliedBy })
  });
}

export async function removeTagFromLead(leadId: string, tagId: string) {
  return apiFetch<void>(`/leads/${leadId}/tags?tagId=${tagId}`, {
    method: 'DELETE'
  });
}

// ---------------------------------------------------------------------------
// Team Notes
// ---------------------------------------------------------------------------

export interface TeamNote {
  id: string;
  content: string;
  leadId: string;
  authorId: string;
  author: {
    id: string;
    name: string;
    role: string;
    avatarUrl: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface TeamNotesResponse {
  notes: TeamNote[];
  total: number;
  page: number;
  limit: number;
}

export async function getTeamNotes(leadId: string, page?: number) {
  const qs = page ? `?page=${page}` : '';
  return apiFetch<TeamNotesResponse>(`/leads/${leadId}/notes${qs}`);
}

export async function createTeamNote(leadId: string, content: string) {
  return apiFetch<TeamNote>(`/leads/${leadId}/notes`, {
    method: 'POST',
    body: JSON.stringify({ content })
  });
}

export async function updateTeamNote(
  leadId: string,
  noteId: string,
  content: string
) {
  return apiFetch<TeamNote>(`/leads/${leadId}/notes/${noteId}`, {
    method: 'PUT',
    body: JSON.stringify({ content })
  });
}

export async function deleteTeamNote(leadId: string, noteId: string) {
  return apiFetch<void>(`/leads/${leadId}/notes/${noteId}`, {
    method: 'DELETE'
  });
}

// ---------------------------------------------------------------------------
// Content Attribution
// ---------------------------------------------------------------------------

export interface ContentAttribution {
  id: string;
  contentType: string;
  contentId: string | null;
  contentUrl: string | null;
  caption: string | null;
  platform: string;
  leadsCount: number;
  actualLeadsCount: number;
  revenue: number;
  callsBooked: number;
  conversionRate: number;
  postedAt: string | null;
  createdAt: string;
}

export interface ContentListResponse {
  content: ContentAttribution[];
  total: number;
  page: number;
  limit: number;
  totals: {
    totalLeads: number;
    totalRevenue: number;
    totalCallsBooked: number;
  };
}

export async function getContentAttributions(params?: {
  contentType?: string;
  platform?: string;
  from?: string;
  to?: string;
  sortBy?: string;
  order?: string;
  page?: number;
  limit?: number;
}) {
  const query = new URLSearchParams();
  if (params?.contentType) query.set('contentType', params.contentType);
  if (params?.platform) query.set('platform', params.platform);
  if (params?.from) query.set('from', params.from);
  if (params?.to) query.set('to', params.to);
  if (params?.sortBy) query.set('sortBy', params.sortBy);
  if (params?.order) query.set('order', params.order);
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return apiFetch<ContentListResponse>(`/content${qs ? `?${qs}` : ''}`);
}

export async function getContentAttribution(id: string) {
  return apiFetch<{ content: ContentAttribution & { leads: Lead[] } }>(
    `/content/${id}`
  );
}

export interface ContentAnalytics {
  topByLeads: ContentAttribution[];
  topByRevenue: ContentAttribution[];
  typeBreakdown: {
    contentType: string;
    contentCount: number;
    leadsCount: number;
    revenue: number;
    callsBooked: number;
  }[];
  platformBreakdown: {
    platform: string;
    contentCount: number;
    leadsCount: number;
    revenue: number;
    callsBooked: number;
  }[];
}

// ---------------------------------------------------------------------------
// Away Mode
// ---------------------------------------------------------------------------

export interface AwayModeState {
  awayMode: boolean;
  awayModeEnabledAt: string | null;
}

export async function getAwayMode() {
  return apiFetch<AwayModeState>('/settings/away-mode');
}

export async function setAwayMode(awayMode: boolean) {
  return apiFetch<AwayModeState>('/settings/away-mode', {
    method: 'PUT',
    body: JSON.stringify({ awayMode })
  });
}

// ---------------------------------------------------------------------------
// Team Performance Analytics
// ---------------------------------------------------------------------------

export interface TeamMemberStats {
  id: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  leadsHandled: number;
  callsBooked: number;
  closeRate: number | null;
  commissionRate: number | null;
  totalCommission: number;
  avgResponseTime: number | null;
  messagesSent: number;
  heatmap: Record<string, number>; // "dayOfWeek-hour" -> count
}

export interface TeamAnalytics {
  members: TeamMemberStats[];
  teamHeatmap: Record<string, number>;
  totalMessages: number;
}

export async function getTeamAnalytics(from?: string, to?: string) {
  const query = new URLSearchParams();
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  const qs = query.toString();
  return apiFetch<TeamAnalytics>(`/analytics/team${qs ? `?${qs}` : ''}`);
}

// ---------------------------------------------------------------------------
// Commission Analytics
// ---------------------------------------------------------------------------

export interface CommissionMember {
  id: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  commissionRate: number | null;
  totalCommission: number;
  callsBooked: number;
  leadsHandled: number;
}

export interface CommissionDeal {
  id: string;
  leadName: string;
  revenue: number | null;
  closedAt: string | null;
}

export interface CommissionAnalytics {
  members: CommissionMember[];
  recentDeals: CommissionDeal[];
  totals: {
    totalRevenue: number;
    totalCommissions: number;
    totalDeals: number;
  };
}

export async function getCommissionAnalytics(from?: string, to?: string) {
  const query = new URLSearchParams();
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  const qs = query.toString();
  return apiFetch<CommissionAnalytics>(
    `/analytics/commissions${qs ? `?${qs}` : ''}`
  );
}

export async function getContentAnalytics(from?: string, to?: string) {
  const query = new URLSearchParams();
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  const qs = query.toString();
  return apiFetch<ContentAnalytics>(`/analytics/content${qs ? `?${qs}` : ''}`);
}
