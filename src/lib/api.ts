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
  stage: string;
  previousStage?: string | null;
  stageEnteredAt?: string;
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
  stage: string;
  aiActive: boolean;
  lastMessage: string;
  lastMessageAt: string | null;
  unreadCount: number;
  priorityScore: number;
  qualityScore: number;
  tags: Array<{ id: string; name: string; color: string }>;
  scheduledCallAt?: string | null;
  /** True when the AI has generated a reply the operator hasn't actioned yet. */
  hasPendingSuggestion?: boolean;
  /** Conversation origin — INBOUND default, MANYCHAT for outbound handoff. */
  source?: 'INBOUND' | 'MANYCHAT' | 'MANUAL_UPLOAD';
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  sender: string;
  content: string;
  isVoiceNote?: boolean;
  voiceNoteUrl?: string | null;
  imageUrl?: string | null;
  hasImage?: boolean;
  timestamp?: string;
  sentAt?: string;
  stage?: string | null;
  stageConfidence?: number | null;
  sentimentScore?: number | null;
  followUpAttemptNumber?: number | null;
  systemPromptVersion?: string | null;
  isHumanOverride?: boolean;
  humanOverrideNote?: string | null;
  humanSource?: 'DASHBOARD' | 'PHONE' | null;
  sentByUser?: { id: string; name: string; email?: string | null } | null;
  platformMessageId?: string | null;
  messageGroupId?: string | null;
  bubbleIndex?: number | null;
  bubbleTotalCount?: number | null;
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

// ---------------------------------------------------------------------------
// Suggestion review flow (test-mode platforms with auto-send off)
// ---------------------------------------------------------------------------

export interface PendingSuggestion {
  id: string;
  responseText: string;
  messageBubbles: string[] | null;
  bubbleCount: number;
  qualityGateScore: number | null;
  intentClassification: string | null;
  intentConfidence: number | null;
  leadStageSnapshot: string | null;
  generatedAt: string;
}

export async function getPendingSuggestion(
  conversationId: string
): Promise<{ suggestion: PendingSuggestion | null }> {
  return apiFetch(`/api/conversations/${conversationId}/suggestion`);
}

export async function sendSuggestion(
  conversationId: string,
  suggestionId: string,
  editedContent?: string
): Promise<{
  messageIds: string[];
  sentAt: string;
  mode: 'approved' | 'edited';
}> {
  return apiFetch(`/api/conversations/${conversationId}/suggestion/send`, {
    method: 'POST',
    body: JSON.stringify({ suggestionId, editedContent: editedContent ?? null })
  });
}

export async function dismissSuggestion(
  conversationId: string,
  suggestionId: string
): Promise<{ dismissed: true; actionedAt: string }> {
  return apiFetch(`/api/conversations/${conversationId}/suggestion/dismiss`, {
    method: 'POST',
    body: JSON.stringify({ suggestionId })
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

export interface LeadDistributionRow {
  stage: string;
  count: number;
}
export async function getLeadDistribution(): Promise<{
  stages: LeadDistributionRow[];
  total: number;
}> {
  const data = await apiFetch('/api/analytics/lead-distribution');
  return {
    stages: (data?.stages ?? []) as LeadDistributionRow[],
    total: typeof data?.total === 'number' ? data.total : 0
  };
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
  triggers: any[] | null;
  triggerDescription: string | null;
  legacyTriggerText: string | null;
  boundToScriptStep: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scriptBindings: any[] | null;
  autoSuggestedTriggers: any[] | null;
  suggestionStatus: 'pending' | 'approved' | 'edited' | 'rejected' | null;
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
// Voice Note Trigger Suggestions (Sprint 4)
// ---------------------------------------------------------------------------

export interface VoiceNoteSuggestionResponse {
  id: string;
  autoSuggestedTriggers: any[] | null;
  suggestionStatus: 'pending' | 'approved' | 'edited' | 'rejected' | null;
  triggers: any[] | null;
  triggerDescription: string | null;
}

export async function getVoiceNoteSuggestions(
  id: string
): Promise<VoiceNoteSuggestionResponse> {
  return apiFetch(`/api/voice-notes/${id}/suggestions`);
}

export async function respondToSuggestion(
  id: string,
  action: 'approve' | 'edit' | 'reject',
  triggers?: unknown[]
): Promise<VoiceNoteSuggestionResponse> {
  return apiFetch(`/api/voice-notes/${id}/suggestions`, {
    method: 'PUT',
    body: JSON.stringify({ action, ...(triggers ? { triggers } : {}) })
  });
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

// ---------------------------------------------------------------------------
// Training Data Analysis (Sprint 4)
// ---------------------------------------------------------------------------

export interface TrainingAnalysisResult {
  id: string;
  accountId: string;
  runAt: string;
  overallScore: number;
  categoryScores: {
    quantity: number;
    voice_style: number;
    lead_type_coverage: number;
    stage_coverage: number;
    outcome_coverage: number;
    objection_coverage: number;
  };
  totalConversations: number;
  totalMessages: number;
  recommendations: Array<{
    category: string;
    severity: 'high' | 'medium' | 'low';
    description: string;
    recommendation: string;
    evidence?: string;
  }>;
  summary?: string;
  status: string;
}

export interface CostEstimate {
  estimatedCostDollars: string;
  estimatedTokens: number;
  totalConversations: number;
  totalMessages: number;
  newConversations?: number;
  isIncremental?: boolean;
}

export async function getTrainingAnalysis(): Promise<{
  analysis: TrainingAnalysisResult | null;
}> {
  return apiFetch('/api/settings/training/analysis');
}

export async function runTrainingAnalysis(
  confirm: boolean
): Promise<{ estimate: CostEstimate } | { analysis: TrainingAnalysisResult }> {
  return apiFetch('/api/settings/training/analysis', {
    method: 'POST',
    body: JSON.stringify({ confirm })
  });
}

// ---------------------------------------------------------------------------
// Lead Stage Transitions
// ---------------------------------------------------------------------------

export async function transitionLeadStage(
  leadId: string,
  stage: string,
  reason?: string
): Promise<any> {
  return apiFetch(`/api/leads/${leadId}/stage`, {
    method: 'PUT',
    body: JSON.stringify({ stage, reason })
  });
}

export async function getLeadStageHistory(leadId: string): Promise<any> {
  return apiFetch(`/api/leads/${leadId}/stage`);
}

// ---------------------------------------------------------------------------
// Script Template System
// ---------------------------------------------------------------------------

import type { Script, ScriptListItem } from '@/lib/script-types';

export async function fetchScripts(): Promise<ScriptListItem[]> {
  return apiFetch('/api/settings/scripts');
}

export async function fetchScript(scriptId: string): Promise<Script> {
  return apiFetch(`/api/settings/scripts/${scriptId}`);
}

export async function createScript(data: {
  name?: string;
  description?: string;
  fromDefault?: boolean;
}): Promise<Script> {
  return apiFetch('/api/settings/scripts', {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

export async function updateScript(
  scriptId: string,
  data: { name?: string; description?: string }
): Promise<Script> {
  return apiFetch(`/api/settings/scripts/${scriptId}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  });
}

export async function deleteScript(scriptId: string): Promise<void> {
  await apiFetch(`/api/settings/scripts/${scriptId}`, { method: 'DELETE' });
}

export async function activateScript(scriptId: string): Promise<void> {
  await apiFetch(`/api/settings/scripts/${scriptId}/activate`, {
    method: 'POST'
  });
}

export async function duplicateScript(scriptId: string): Promise<Script> {
  return apiFetch(`/api/settings/scripts/${scriptId}/duplicate`, {
    method: 'POST'
  });
}

// Steps

export async function createStep(
  scriptId: string,
  data: { title: string; description?: string; objective?: string }
): Promise<any> {
  return apiFetch(`/api/settings/scripts/${scriptId}/steps`, {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

export async function updateStep(
  scriptId: string,
  stepId: string,
  data: { title?: string; description?: string; objective?: string }
): Promise<any> {
  return apiFetch(`/api/settings/scripts/${scriptId}/steps/${stepId}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  });
}

export async function deleteStep(
  scriptId: string,
  stepId: string
): Promise<void> {
  await apiFetch(`/api/settings/scripts/${scriptId}/steps/${stepId}`, {
    method: 'DELETE'
  });
}

export async function reorderSteps(
  scriptId: string,
  stepIds: string[]
): Promise<void> {
  await apiFetch(`/api/settings/scripts/${scriptId}/steps`, {
    method: 'PUT',
    body: JSON.stringify({ stepIds })
  });
}

// Branches

export async function createBranch(
  scriptId: string,
  stepId: string,
  data: { branchLabel: string; conditionDescription?: string }
): Promise<any> {
  return apiFetch(
    `/api/settings/scripts/${scriptId}/steps/${stepId}/branches`,
    { method: 'POST', body: JSON.stringify(data) }
  );
}

export async function updateBranch(
  scriptId: string,
  stepId: string,
  branchId: string,
  data: { branchLabel?: string; conditionDescription?: string }
): Promise<any> {
  return apiFetch(
    `/api/settings/scripts/${scriptId}/steps/${stepId}/branches/${branchId}`,
    { method: 'PUT', body: JSON.stringify(data) }
  );
}

export async function deleteBranch(
  scriptId: string,
  stepId: string,
  branchId: string
): Promise<void> {
  await apiFetch(
    `/api/settings/scripts/${scriptId}/steps/${stepId}/branches/${branchId}`,
    { method: 'DELETE' }
  );
}

// Actions

export async function createAction(
  scriptId: string,
  data: {
    stepId: string;
    branchId?: string | null;
    actionType: string;
    content?: string | null;
    voiceNoteId?: string | null;
    linkUrl?: string | null;
    linkLabel?: string | null;
    formId?: string | null;
    waitDuration?: number | null;
    sortOrder?: number;
  }
): Promise<any> {
  return apiFetch(`/api/settings/scripts/${scriptId}/actions`, {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

export async function updateAction(
  scriptId: string,
  actionId: string,
  data: Record<string, unknown>
): Promise<any> {
  return apiFetch(`/api/settings/scripts/${scriptId}/actions`, {
    method: 'PUT',
    body: JSON.stringify({ actionId, ...data })
  });
}

export async function deleteAction(
  scriptId: string,
  actionId: string
): Promise<void> {
  await apiFetch(`/api/settings/scripts/${scriptId}/actions`, {
    method: 'DELETE',
    body: JSON.stringify({ actionId })
  });
}

// Forms

export async function fetchForms(scriptId: string): Promise<any[]> {
  return apiFetch(`/api/settings/scripts/${scriptId}/forms`);
}

export async function createForm(
  scriptId: string,
  data: { name: string; description?: string }
): Promise<any> {
  return apiFetch(`/api/settings/scripts/${scriptId}/forms`, {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

export async function updateForm(
  scriptId: string,
  formId: string,
  data: { name?: string; description?: string }
): Promise<any> {
  return apiFetch(`/api/settings/scripts/${scriptId}/forms/${formId}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  });
}

export async function deleteForm(
  scriptId: string,
  formId: string
): Promise<void> {
  await apiFetch(`/api/settings/scripts/${scriptId}/forms/${formId}`, {
    method: 'DELETE'
  });
}

// Form Fields

export async function createFormField(
  scriptId: string,
  formId: string,
  data: { fieldLabel: string; fieldValue?: string }
): Promise<any> {
  return apiFetch(`/api/settings/scripts/${scriptId}/forms/${formId}/fields`, {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

export async function updateFormField(
  scriptId: string,
  formId: string,
  fieldId: string,
  data: { fieldLabel?: string; fieldValue?: string }
): Promise<any> {
  return apiFetch(`/api/settings/scripts/${scriptId}/forms/${formId}/fields`, {
    method: 'PUT',
    body: JSON.stringify({ fieldId, ...data })
  });
}

export async function deleteFormField(
  scriptId: string,
  formId: string,
  fieldId: string
): Promise<void> {
  await apiFetch(`/api/settings/scripts/${scriptId}/forms/${formId}/fields`, {
    method: 'DELETE',
    body: JSON.stringify({ fieldId })
  });
}

// -- Script parsing --

export async function parseScript(data: {
  text?: string;
  fileBase64?: string;
  fileName?: string;
}): Promise<{ script: any; parseWarnings: string[] }> {
  return apiFetch('/api/settings/scripts/parse', {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

export async function reuploadScript(
  scriptId: string,
  data: {
    text?: string;
    fileBase64?: string;
    fileName?: string;
  }
): Promise<{ script: any; parseWarnings: string[] }> {
  return apiFetch(`/api/settings/scripts/${scriptId}/reupload`, {
    method: 'POST',
    body: JSON.stringify(data)
  });
}
