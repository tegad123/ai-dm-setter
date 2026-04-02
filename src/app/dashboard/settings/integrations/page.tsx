'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Provider =
  | 'OPENAI'
  | 'ANTHROPIC'
  | 'META'
  | 'INSTAGRAM'
  | 'ELEVENLABS'
  | 'LEADCONNECTOR'
  | 'CALENDLY';
type AIProvider = 'OPENAI' | 'ANTHROPIC';

interface IntegrationStatus {
  provider: Provider;
  isConnected: boolean;
  verifiedAt: string | null;
  metadata: Record<string, any> | null;
  maskedKey?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskKey(key: string): string {
  if (!key || key.length <= 4) return key;
  return '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + key.slice(-4);
}

function StatusBadge({ connected }: { connected: boolean }) {
  return connected ? (
    <Badge className='bg-green-600 text-white hover:bg-green-600'>
      Connected
    </Badge>
  ) : (
    <Badge variant='secondary'>Not Connected</Badge>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function IntegrationsPage() {
  // Connection statuses fetched from API
  const [statuses, setStatuses] = useState<Record<Provider, boolean>>({
    OPENAI: false,
    ANTHROPIC: false,
    META: false,
    INSTAGRAM: false,
    ELEVENLABS: false,
    LEADCONNECTOR: false,
    CALENDLY: false
  });

  // AI provider toggle
  const [selectedAI, setSelectedAI] = useState<AIProvider>('OPENAI');

  // Form state -- AI
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiSaving, setAiSaving] = useState(false);
  const [aiSavedKey, setAiSavedKey] = useState('');
  const [aiRawKey, setAiRawKey] = useState(''); // TEMPORARY debug

  // Form state -- ElevenLabs
  const [elApiKey, setElApiKey] = useState('');
  const [elVoiceId, setElVoiceId] = useState('');
  const [elSaving, setElSaving] = useState(false);
  const [elSavedKey, setElSavedKey] = useState('');

  // Form state -- LeadConnector
  const [lcApiKey, setLcApiKey] = useState('');
  const [lcCalendarId, setLcCalendarId] = useState('');
  const [lcLocationId, setLcLocationId] = useState('');
  const [lcSaving, setLcSaving] = useState(false);
  const [lcSavedKey, setLcSavedKey] = useState('');

  // Form state -- Calendly
  const [calApiKey, setCalApiKey] = useState('');
  const [calEventTypeUri, setCalEventTypeUri] = useState('');
  const [calSaving, setCalSaving] = useState(false);
  const [calSavedKey, setCalSavedKey] = useState('');

  // Meta / Facebook
  const [metaDisconnecting, setMetaDisconnecting] = useState(false);
  const [metaMetadata, setMetaMetadata] = useState<Record<string, any> | null>(
    null
  );

  // Instagram
  const [igDisconnecting, setIgDisconnecting] = useState(false);
  const [igMetadata, setIgMetadata] = useState<Record<string, any> | null>(
    null
  );

  // Loading
  const [loading, setLoading] = useState(true);

  // --------------------------------------------------
  // Fetch current status on mount
  // --------------------------------------------------

  const fetchStatuses = useCallback(async () => {
    try {
      const data = await apiFetch<{ integrations: IntegrationStatus[] }>(
        '/api/settings/integrations'
      );
      const map: Record<string, boolean> = {};
      for (const i of data.integrations) {
        map[i.provider] = i.isConnected;
        if (i.provider === 'META' && i.metadata) {
          setMetaMetadata(i.metadata as any);
        }
        if (i.provider === 'INSTAGRAM' && i.metadata) {
          setIgMetadata(i.metadata as any);
        }
        // Store masked keys from API
        if (i.maskedKey) {
          if (i.provider === 'OPENAI' || i.provider === 'ANTHROPIC') {
            setAiSavedKey(i.maskedKey);
            if ((i as any).rawKey) setAiRawKey((i as any).rawKey);
          }
          if (i.provider === 'ELEVENLABS') setElSavedKey(i.maskedKey);
          if (i.provider === 'LEADCONNECTOR') setLcSavedKey(i.maskedKey);
          if (i.provider === 'CALENDLY') setCalSavedKey(i.maskedKey);
        }
      }
      setStatuses((prev) => ({ ...prev, ...map }));

      // If Anthropic is connected but OpenAI is not, default to Anthropic
      if (map['ANTHROPIC'] && !map['OPENAI']) {
        setSelectedAI('ANTHROPIC');
      }
    } catch {
      // Silently fail on initial load -- user will see "Not Connected"
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatuses();

    // Handle OAuth redirect query params
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const error = params.get('error');
    const page = params.get('page');
    const ig = params.get('ig');

    if (connected === 'meta') {
      toast.success(
        `Facebook Page "${page || 'Connected'}" linked successfully!${ig ? ` Instagram @${ig} also connected.` : ''}`
      );
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
    } else if (connected === 'instagram') {
      toast.success(`Instagram @${ig || 'account'} connected!`);
      window.history.replaceState({}, '', window.location.pathname);
    } else if (error) {
      const errorMessages: Record<string, string> = {
        meta_denied: 'Facebook login was cancelled',
        instagram_denied: 'Instagram login was cancelled',
        missing_params: 'OAuth callback missing parameters',
        invalid_state: 'Invalid OAuth state — please try again',
        platform_config: 'Platform not configured — contact support',
        token_exchange: 'Failed to exchange token with Meta',
        pages_fetch: 'Failed to fetch Facebook Pages',
        no_pages:
          'No Facebook Pages found. You need a Facebook Page to connect — create one at facebook.com/pages/create, then link your Instagram Business account to it.',
        ig_token_exchange: 'Failed to exchange Instagram token',
        ig_unknown: 'Instagram connection failed — please try again',
        unknown: 'Connection failed — please try again'
      };
      toast.error(errorMessages[error] || `Connection error: ${error}`, {
        duration: error === 'no_pages' ? 15000 : 5000
      });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [fetchStatuses]);

  // --------------------------------------------------
  // Save handlers
  // --------------------------------------------------

  async function saveAI() {
    if (!aiApiKey.trim()) {
      toast.error('Please enter an API key');
      return;
    }
    setAiSaving(true);
    try {
      await apiFetch(`/api/settings/integrations/${selectedAI}`, {
        method: 'PUT',
        body: JSON.stringify({
          credentials: {
            apiKey: aiApiKey,
            ...(aiModel.trim() ? { model: aiModel.trim() } : {})
          },
          metadata: aiModel.trim() ? { model: aiModel.trim() } : {}
        })
      });
      toast.success(
        `${selectedAI === 'OPENAI' ? 'OpenAI' : 'Anthropic'} credentials saved`
      );
      setAiSavedKey(maskKey(aiApiKey));
      setAiApiKey('');
      setAiModel('');
      setStatuses((prev) => ({ ...prev, [selectedAI]: true }));
    } catch {
      toast.error('Failed to save credentials');
    } finally {
      setAiSaving(false);
    }
  }

  async function saveElevenLabs() {
    if (!elApiKey.trim()) {
      toast.error('Please enter an API key');
      return;
    }
    setElSaving(true);
    try {
      await apiFetch('/api/settings/integrations/ELEVENLABS', {
        method: 'PUT',
        body: JSON.stringify({
          credentials: {
            apiKey: elApiKey,
            ...(elVoiceId.trim() ? { voiceId: elVoiceId.trim() } : {})
          },
          metadata: elVoiceId.trim() ? { voiceId: elVoiceId.trim() } : {}
        })
      });
      toast.success('ElevenLabs credentials saved');
      setElSavedKey(maskKey(elApiKey));
      setElApiKey('');
      setElVoiceId('');
      setStatuses((prev) => ({ ...prev, ELEVENLABS: true }));
    } catch {
      toast.error('Failed to save credentials');
    } finally {
      setElSaving(false);
    }
  }

  async function saveLeadConnector() {
    if (!lcApiKey.trim()) {
      toast.error('Please enter an API key');
      return;
    }
    setLcSaving(true);
    try {
      await apiFetch('/api/settings/integrations/LEADCONNECTOR', {
        method: 'PUT',
        body: JSON.stringify({
          credentials: {
            apiKey: lcApiKey,
            calendarId: lcCalendarId.trim() || undefined,
            locationId: lcLocationId.trim() || undefined
          }
        })
      });
      toast.success('LeadConnector credentials saved');
      setLcSavedKey(maskKey(lcApiKey));
      setLcApiKey('');
      setLcCalendarId('');
      setLcLocationId('');
      setStatuses((prev) => ({ ...prev, LEADCONNECTOR: true }));
    } catch {
      toast.error('Failed to save credentials');
    } finally {
      setLcSaving(false);
    }
  }

  async function saveCalendly() {
    if (!calApiKey.trim()) {
      toast.error('Please enter your Calendly Personal Access Token');
      return;
    }
    setCalSaving(true);
    try {
      // First save the key, then auto-fetch user URI
      const headers = {
        Authorization: `Bearer ${calApiKey.trim()}`,
        'Content-Type': 'application/json'
      };
      const meRes = await fetch('https://api.calendly.com/users/me', {
        headers
      });
      let userUri = '';
      let eventTypeUri = calEventTypeUri.trim();

      if (meRes.ok) {
        const meData = await meRes.json();
        userUri = meData.resource?.uri || '';

        // If no event type URI provided, try to fetch the first one
        if (!eventTypeUri && userUri) {
          const etRes = await fetch(
            `https://api.calendly.com/event_types?user=${encodeURIComponent(userUri)}&active=true`,
            { headers }
          );
          if (etRes.ok) {
            const etData = await etRes.json();
            const firstEvent = etData.collection?.[0];
            if (firstEvent) {
              eventTypeUri = firstEvent.uri;
            }
          }
        }
      }

      await apiFetch('/api/settings/integrations/CALENDLY', {
        method: 'PUT',
        body: JSON.stringify({
          credentials: { apiKey: calApiKey.trim() },
          metadata: {
            userUri,
            eventTypeUri
          }
        })
      });
      toast.success('Calendly connected successfully');
      setCalSavedKey(maskKey(calApiKey));
      setCalApiKey('');
      setCalEventTypeUri('');
      setStatuses((prev) => ({ ...prev, CALENDLY: true }));
    } catch {
      toast.error('Failed to save Calendly credentials');
    } finally {
      setCalSaving(false);
    }
  }

  // --------------------------------------------------
  // Disconnect handlers
  // --------------------------------------------------

  async function disconnectProvider(provider: Provider) {
    try {
      await apiFetch(`/api/settings/integrations/${provider}`, {
        method: 'DELETE'
      });
      toast.success(`${provider} disconnected`);
      setStatuses((prev) => ({ ...prev, [provider]: false }));

      // Clear saved key masks
      if (provider === 'OPENAI' || provider === 'ANTHROPIC') setAiSavedKey('');
      if (provider === 'ELEVENLABS') setElSavedKey('');
      if (provider === 'LEADCONNECTOR') setLcSavedKey('');
      if (provider === 'CALENDLY') setCalSavedKey('');
      if (provider === 'META') setMetaMetadata(null);
      if (provider === 'INSTAGRAM') setIgMetadata(null);
    } catch {
      toast.error('Failed to disconnect');
    }
  }

  // --------------------------------------------------
  // Render
  // --------------------------------------------------

  if (loading) {
    return (
      <div className='flex flex-1 flex-col gap-6 p-4 md:p-6'>
        <div>
          <h2 className='text-2xl font-bold tracking-tight'>Integrations</h2>
          <p className='text-muted-foreground'>Loading...</p>
        </div>
      </div>
    );
  }

  const aiConnected = statuses[selectedAI];

  return (
    <div className='flex flex-1 flex-col gap-6 p-4 md:p-6'>
      {/* Header */}
      <div>
        <h2 className='text-2xl font-bold tracking-tight'>Integrations</h2>
        <p className='text-muted-foreground'>
          Connect your API keys and services. You provide your own keys &mdash;
          you control your costs.
        </p>
      </div>

      <Separator />

      <div className='grid gap-6'>
        {/* ---------------------------------------------------------------- */}
        {/* Card 1: AI Provider */}
        {/* ---------------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <div className='flex items-center justify-between'>
              <div>
                <CardTitle>AI Provider</CardTitle>
                <CardDescription>
                  Connect your OpenAI or Anthropic API key to power AI responses
                </CardDescription>
              </div>
              <StatusBadge connected={aiConnected} />
            </div>
          </CardHeader>
          <CardContent className='space-y-4'>
            {/* Provider toggle */}
            <div className='flex gap-2'>
              <Button
                variant={selectedAI === 'OPENAI' ? 'default' : 'outline'}
                size='sm'
                onClick={() => {
                  setSelectedAI('OPENAI');
                  setAiApiKey('');
                  setAiModel('');
                }}
              >
                OpenAI
              </Button>
              <Button
                variant={selectedAI === 'ANTHROPIC' ? 'default' : 'outline'}
                size='sm'
                onClick={() => {
                  setSelectedAI('ANTHROPIC');
                  setAiApiKey('');
                  setAiModel('');
                }}
              >
                Anthropic
              </Button>
            </div>

            {/* Saved key display with lock */}
            {aiConnected && aiSavedKey ? (
              <div className='space-y-2'>
                <Label>API Key</Label>
                <div className='bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-2'>
                  <svg
                    xmlns='http://www.w3.org/2000/svg'
                    width='16'
                    height='16'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    className='shrink-0 text-green-600'
                  >
                    <rect width='18' height='11' x='3' y='11' rx='2' ry='2' />
                    <path d='M7 11V7a5 5 0 0 1 10 0v4' />
                  </svg>
                  <span className='flex-1 font-mono text-sm'>
                    {aiSavedKey}
                    {aiRawKey && (
                      <span className='mt-1 block text-xs break-all text-orange-600'>
                        Full key: {aiRawKey}
                      </span>
                    )}
                  </span>
                  <span className='text-xs font-medium text-green-600'>
                    Saved
                  </span>
                </div>
                <Button
                  variant='ghost'
                  size='sm'
                  className='text-muted-foreground hover:text-foreground h-auto p-0 text-xs'
                  onClick={() => {
                    setAiSavedKey('');
                    setAiApiKey('');
                  }}
                >
                  Change key
                </Button>
              </div>
            ) : (
              <div className='space-y-2'>
                <Label htmlFor='ai-api-key'>API Key</Label>
                <Input
                  id='ai-api-key'
                  type='password'
                  placeholder={
                    selectedAI === 'OPENAI' ? 'sk-...' : 'sk-ant-...'
                  }
                  value={aiApiKey}
                  onChange={(e) => setAiApiKey(e.target.value)}
                />
              </div>
            )}

            {/* Model */}
            <div className='space-y-2'>
              <Label htmlFor='ai-model'>Model (optional)</Label>
              <Input
                id='ai-model'
                type='text'
                placeholder={
                  selectedAI === 'OPENAI'
                    ? 'gpt-4o'
                    : 'claude-sonnet-4-20250514'
                }
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
              />
            </div>
          </CardContent>
          <CardFooter className='flex justify-between'>
            <Button onClick={saveAI} disabled={aiSaving}>
              {aiSaving ? 'Saving...' : 'Save'}
            </Button>
            {aiConnected && (
              <Button
                variant='outline'
                onClick={() => disconnectProvider(selectedAI)}
              >
                Disconnect
              </Button>
            )}
          </CardFooter>
        </Card>

        {/* ---------------------------------------------------------------- */}
        {/* Card 2: ElevenLabs */}
        {/* ---------------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <div className='flex items-center justify-between'>
              <div>
                <CardTitle>ElevenLabs</CardTitle>
                <CardDescription>
                  Enable AI voice notes with your ElevenLabs voice clone
                </CardDescription>
              </div>
              <StatusBadge connected={statuses.ELEVENLABS} />
            </div>
          </CardHeader>
          <CardContent className='space-y-4'>
            {statuses.ELEVENLABS && elSavedKey ? (
              <div className='space-y-2'>
                <Label>API Key</Label>
                <div className='bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-2'>
                  <svg
                    xmlns='http://www.w3.org/2000/svg'
                    width='16'
                    height='16'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    className='shrink-0 text-green-600'
                  >
                    <rect width='18' height='11' x='3' y='11' rx='2' ry='2' />
                    <path d='M7 11V7a5 5 0 0 1 10 0v4' />
                  </svg>
                  <span className='flex-1 font-mono text-sm'>{elSavedKey}</span>
                  <span className='text-xs font-medium text-green-600'>
                    Saved
                  </span>
                </div>
                <Button
                  variant='ghost'
                  size='sm'
                  className='text-muted-foreground hover:text-foreground h-auto p-0 text-xs'
                  onClick={() => {
                    setElSavedKey('');
                    setElApiKey('');
                  }}
                >
                  Change key
                </Button>
              </div>
            ) : (
              <div className='space-y-2'>
                <Label htmlFor='el-api-key'>API Key</Label>
                <Input
                  id='el-api-key'
                  type='password'
                  placeholder='xi-...'
                  value={elApiKey}
                  onChange={(e) => setElApiKey(e.target.value)}
                />
              </div>
            )}

            <div className='space-y-2'>
              <Label htmlFor='el-voice-id'>Voice ID</Label>
              <Input
                id='el-voice-id'
                type='text'
                placeholder='Your voice clone ID'
                value={elVoiceId}
                onChange={(e) => setElVoiceId(e.target.value)}
              />
            </div>
          </CardContent>
          <CardFooter className='flex justify-between'>
            <Button onClick={saveElevenLabs} disabled={elSaving}>
              {elSaving ? 'Saving...' : 'Save'}
            </Button>
            {statuses.ELEVENLABS && (
              <Button
                variant='outline'
                onClick={() => disconnectProvider('ELEVENLABS')}
              >
                Disconnect
              </Button>
            )}
          </CardFooter>
        </Card>

        {/* ---------------------------------------------------------------- */}
        {/* Card 3: LeadConnector */}
        {/* ---------------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <div className='flex items-center justify-between'>
              <div>
                <CardTitle>LeadConnector</CardTitle>
                <CardDescription>
                  Connect your calendar for automated booking
                </CardDescription>
              </div>
              <StatusBadge connected={statuses.LEADCONNECTOR} />
            </div>
          </CardHeader>
          <CardContent className='space-y-4'>
            {statuses.LEADCONNECTOR && lcSavedKey ? (
              <div className='space-y-2'>
                <Label>API Key</Label>
                <div className='bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-2'>
                  <svg
                    xmlns='http://www.w3.org/2000/svg'
                    width='16'
                    height='16'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    className='shrink-0 text-green-600'
                  >
                    <rect width='18' height='11' x='3' y='11' rx='2' ry='2' />
                    <path d='M7 11V7a5 5 0 0 1 10 0v4' />
                  </svg>
                  <span className='flex-1 font-mono text-sm'>{lcSavedKey}</span>
                  <span className='text-xs font-medium text-green-600'>
                    Saved
                  </span>
                </div>
                <Button
                  variant='ghost'
                  size='sm'
                  className='text-muted-foreground hover:text-foreground h-auto p-0 text-xs'
                  onClick={() => {
                    setLcSavedKey('');
                    setLcApiKey('');
                  }}
                >
                  Change key
                </Button>
              </div>
            ) : (
              <div className='space-y-2'>
                <Label htmlFor='lc-api-key'>API Key</Label>
                <Input
                  id='lc-api-key'
                  type='password'
                  placeholder='Your LeadConnector API key'
                  value={lcApiKey}
                  onChange={(e) => setLcApiKey(e.target.value)}
                />
              </div>
            )}

            <div className='space-y-2'>
              <Label htmlFor='lc-calendar-id'>Calendar ID</Label>
              <Input
                id='lc-calendar-id'
                type='text'
                placeholder='Calendar ID from LeadConnector'
                value={lcCalendarId}
                onChange={(e) => setLcCalendarId(e.target.value)}
              />
            </div>

            <div className='space-y-2'>
              <Label htmlFor='lc-location-id'>Location ID</Label>
              <Input
                id='lc-location-id'
                type='text'
                placeholder='Location ID from LeadConnector'
                value={lcLocationId}
                onChange={(e) => setLcLocationId(e.target.value)}
              />
            </div>
          </CardContent>
          <CardFooter className='flex justify-between'>
            <Button onClick={saveLeadConnector} disabled={lcSaving}>
              {lcSaving ? 'Saving...' : 'Save'}
            </Button>
            {statuses.LEADCONNECTOR && (
              <Button
                variant='outline'
                onClick={() => disconnectProvider('LEADCONNECTOR')}
              >
                Disconnect
              </Button>
            )}
          </CardFooter>
        </Card>

        {/* ---------------------------------------------------------------- */}
        {/* Card 4: Calendly */}
        {/* ---------------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <div className='flex items-center justify-between'>
              <div>
                <CardTitle>Calendly</CardTitle>
                <CardDescription>
                  Connect your Calendly for automated call booking
                </CardDescription>
              </div>
              <StatusBadge connected={statuses.CALENDLY} />
            </div>
          </CardHeader>
          <CardContent className='space-y-4'>
            {statuses.CALENDLY && calSavedKey ? (
              <div className='space-y-2'>
                <Label>Personal Access Token</Label>
                <div className='bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-2'>
                  <svg
                    xmlns='http://www.w3.org/2000/svg'
                    width='16'
                    height='16'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    className='shrink-0 text-green-600'
                  >
                    <rect width='18' height='11' x='3' y='11' rx='2' ry='2' />
                    <path d='M7 11V7a5 5 0 0 1 10 0v4' />
                  </svg>
                  <span className='flex-1 font-mono text-sm'>
                    {calSavedKey}
                  </span>
                  <span className='text-xs font-medium text-green-600'>
                    Saved
                  </span>
                </div>
                <Button
                  variant='ghost'
                  size='sm'
                  className='text-muted-foreground hover:text-foreground h-auto p-0 text-xs'
                  onClick={() => {
                    setCalSavedKey('');
                    setCalApiKey('');
                  }}
                >
                  Change key
                </Button>
              </div>
            ) : (
              <div className='space-y-2'>
                <Label htmlFor='cal-api-key'>Personal Access Token</Label>
                <Input
                  id='cal-api-key'
                  type='password'
                  placeholder='Get yours at calendly.com/integrations/api'
                  value={calApiKey}
                  onChange={(e) => setCalApiKey(e.target.value)}
                />
                <p className='text-muted-foreground text-xs'>
                  Go to{' '}
                  <a
                    href='https://calendly.com/integrations/api_webhooks'
                    target='_blank'
                    rel='noopener noreferrer'
                    className='underline'
                  >
                    Calendly API &amp; Webhooks
                  </a>{' '}
                  → Generate New Token
                </p>
              </div>
            )}

            <div className='space-y-2'>
              <Label htmlFor='cal-event-type'>
                Event Type URI (optional &mdash; auto-detected)
              </Label>
              <Input
                id='cal-event-type'
                type='text'
                placeholder='Leave blank to use your first active event type'
                value={calEventTypeUri}
                onChange={(e) => setCalEventTypeUri(e.target.value)}
              />
            </div>
          </CardContent>
          <CardFooter className='flex justify-between'>
            <Button onClick={saveCalendly} disabled={calSaving}>
              {calSaving ? 'Connecting...' : 'Connect Calendly'}
            </Button>
            {statuses.CALENDLY && (
              <Button
                variant='outline'
                onClick={() => disconnectProvider('CALENDLY')}
              >
                Disconnect
              </Button>
            )}
          </CardFooter>
        </Card>

        {/* ---------------------------------------------------------------- */}
        {/* Card 5: Facebook Messenger */}
        {/* ---------------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <div className='flex items-center justify-between'>
              <div className='flex items-center gap-3'>
                <div className='flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-600'>
                  <svg
                    viewBox='0 0 24 24'
                    className='h-5 w-5 text-white'
                    fill='currentColor'
                  >
                    <path d='M12 2C6.36 2 2 6.13 2 11.7c0 2.91 1.2 5.42 3.15 7.2V22l2.93-1.61c.83.23 1.71.35 2.63.35h.29c5.45 0 9.85-3.96 9.85-8.84v-.2C20.85 6.13 17.64 2 12 2zm1.07 11.93l-2.54-2.71-4.94 2.71 5.43-5.77 2.6 2.71 4.88-2.71-5.43 5.77z' />
                  </svg>
                </div>
                <div>
                  <CardTitle>Facebook Messenger</CardTitle>
                  <CardDescription>
                    Receive and reply to Facebook Page DMs automatically
                  </CardDescription>
                </div>
              </div>
              <StatusBadge connected={statuses.META} />
            </div>
          </CardHeader>
          <CardContent>
            {statuses.META ? (
              <div className='space-y-1'>
                <p className='text-sm font-semibold'>
                  {metaMetadata?.pageName || 'Facebook Page'}
                </p>
                <p className='text-muted-foreground text-xs'>
                  Page ID: {metaMetadata?.pageId || 'Unknown'}
                </p>
                <p className='text-muted-foreground mt-2 text-sm'>
                  Receiving and sending Messenger DMs for this page.
                </p>
              </div>
            ) : (
              <p className='text-muted-foreground text-sm'>
                Connect your Facebook Page to automatically receive and respond
                to Messenger DMs with AI.
              </p>
            )}
          </CardContent>
          <CardFooter className='flex justify-between'>
            {statuses.META ? (
              <Button
                variant='outline'
                disabled={metaDisconnecting}
                onClick={async () => {
                  setMetaDisconnecting(true);
                  await disconnectProvider('META');
                  setMetaDisconnecting(false);
                }}
              >
                {metaDisconnecting ? 'Disconnecting...' : 'Disconnect'}
              </Button>
            ) : (
              <Button
                onClick={() => {
                  window.location.href = '/api/auth/meta';
                }}
              >
                Connect Facebook Page
              </Button>
            )}
          </CardFooter>
        </Card>

        {/* ---------------------------------------------------------------- */}
        {/* Card 6: Instagram DMs */}
        {/* ---------------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <div className='flex items-center justify-between'>
              <div className='flex items-center gap-3'>
                <div className='flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-purple-600 via-pink-500 to-orange-400'>
                  <svg
                    viewBox='0 0 24 24'
                    className='h-5 w-5 text-white'
                    fill='currentColor'
                  >
                    <path d='M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z' />
                  </svg>
                </div>
                <div>
                  <CardTitle>Instagram DMs</CardTitle>
                  <CardDescription>
                    Receive and reply to Instagram Direct Messages automatically
                  </CardDescription>
                </div>
              </div>
              <StatusBadge connected={statuses.INSTAGRAM} />
            </div>
          </CardHeader>
          <CardContent>
            {statuses.INSTAGRAM ? (
              <div className='space-y-1'>
                <p className='text-sm font-semibold'>
                  {igMetadata?.username
                    ? `@${igMetadata.username}`
                    : 'Instagram Account'}
                </p>
                {igMetadata?.name && (
                  <p className='text-muted-foreground text-xs'>
                    {igMetadata.name}
                  </p>
                )}
                <p className='text-muted-foreground mt-2 text-sm'>
                  Receiving and sending Instagram DMs for this account.
                </p>
              </div>
            ) : (
              <p className='text-muted-foreground text-sm'>
                Log in with your Instagram Business or Creator account to
                automatically receive and respond to DMs with AI.
              </p>
            )}
          </CardContent>
          <CardFooter className='flex justify-between'>
            {statuses.INSTAGRAM ? (
              <Button
                variant='outline'
                disabled={igDisconnecting}
                onClick={async () => {
                  setIgDisconnecting(true);
                  await disconnectProvider('INSTAGRAM');
                  setIgDisconnecting(false);
                }}
              >
                {igDisconnecting ? 'Disconnecting...' : 'Disconnect'}
              </Button>
            ) : (
              <Button
                onClick={() => {
                  window.location.href = '/api/auth/instagram';
                }}
              >
                Connect Instagram
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
