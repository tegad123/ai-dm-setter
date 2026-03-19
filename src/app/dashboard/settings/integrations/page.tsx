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
  | 'ELEVENLABS'
  | 'LEADCONNECTOR'
  | 'CALENDLY';
type AIProvider = 'OPENAI' | 'ANTHROPIC';

interface IntegrationStatus {
  provider: Provider;
  isConnected: boolean;
  verifiedAt: string | null;
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

  // Meta
  const [metaDisconnecting, setMetaDisconnecting] = useState(false);

  // Loading
  const [loading, setLoading] = useState(true);

  // --------------------------------------------------
  // Fetch current status on mount
  // --------------------------------------------------

  const fetchStatuses = useCallback(async () => {
    try {
      const data = await apiFetch<{ integrations: IntegrationStatus[] }>(
        '/settings/integrations'
      );
      const map: Record<string, boolean> = {};
      for (const i of data.integrations) {
        map[i.provider] = i.isConnected;
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
      await apiFetch(`/settings/integrations/${selectedAI}`, {
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
      setAiSavedKey(aiApiKey);
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
      await apiFetch('/settings/integrations/ELEVENLABS', {
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
      setElSavedKey(elApiKey);
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
      await apiFetch('/settings/integrations/LEADCONNECTOR', {
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
      setLcSavedKey(lcApiKey);
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

      await apiFetch('/settings/integrations/CALENDLY', {
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
      setCalSavedKey(calApiKey);
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
      await apiFetch(`/settings/integrations/${provider}`, {
        method: 'DELETE'
      });
      toast.success(`${provider} disconnected`);
      setStatuses((prev) => ({ ...prev, [provider]: false }));

      // Clear saved key masks
      if (provider === 'OPENAI' || provider === 'ANTHROPIC') setAiSavedKey('');
      if (provider === 'ELEVENLABS') setElSavedKey('');
      if (provider === 'LEADCONNECTOR') setLcSavedKey('');
      if (provider === 'CALENDLY') setCalSavedKey('');
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

            {/* Saved key display */}
            {aiConnected && aiSavedKey && (
              <p className='text-muted-foreground text-sm'>
                Current key: {maskKey(aiSavedKey)}
              </p>
            )}

            {/* API Key */}
            <div className='space-y-2'>
              <Label htmlFor='ai-api-key'>API Key</Label>
              <Input
                id='ai-api-key'
                type='password'
                placeholder={selectedAI === 'OPENAI' ? 'sk-...' : 'sk-ant-...'}
                value={aiApiKey}
                onChange={(e) => setAiApiKey(e.target.value)}
              />
            </div>

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
            {statuses.ELEVENLABS && elSavedKey && (
              <p className='text-muted-foreground text-sm'>
                Current key: {maskKey(elSavedKey)}
              </p>
            )}

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
            {statuses.LEADCONNECTOR && lcSavedKey && (
              <p className='text-muted-foreground text-sm'>
                Current key: {maskKey(lcSavedKey)}
              </p>
            )}

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
            {statuses.CALENDLY && calSavedKey && (
              <p className='text-muted-foreground text-sm'>
                Current key: {maskKey(calSavedKey)}
              </p>
            )}

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
        {/* Card 5: Meta (Instagram & Facebook) */}
        {/* ---------------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <div className='flex items-center justify-between'>
              <div>
                <CardTitle>Meta (Instagram &amp; Facebook)</CardTitle>
                <CardDescription>
                  Connect your Facebook/Instagram pages to send and receive DMs
                </CardDescription>
              </div>
              <StatusBadge connected={statuses.META} />
            </div>
          </CardHeader>
          <CardContent>
            {statuses.META ? (
              <p className='text-muted-foreground text-sm'>
                Your Meta account is connected. You can disconnect below if
                needed.
              </p>
            ) : (
              <p className='text-muted-foreground text-sm'>
                Click the button below to authenticate with Facebook and connect
                your pages.
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
                Connect with Facebook
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
