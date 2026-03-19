const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

// ---------------------------------------------------------------------------
// Core fetch wrapper
// ---------------------------------------------------------------------------

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token =
    typeof window !== 'undefined' ? localStorage.getItem('token') : null;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>)
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
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
  page?: number;
  limit?: number;
}) {
  const query = new URLSearchParams();
  if (params?.status) query.set('status', params.status);
  if (params?.platform) query.set('platform', params.platform);
  if (params?.search) query.set('search', params.search);
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

export async function getConversations(search?: string) {
  const qs = search ? `?search=${encodeURIComponent(search)}` : '';
  return apiFetch<Conversation[]>(`/conversations${qs}`);
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
