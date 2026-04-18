'use client';

// ---------------------------------------------------------------------------
// Persona & Context Editor — /dashboard/settings/persona-editor
// ---------------------------------------------------------------------------
// Day-to-day operator surface for editing persona context AFTER onboarding.
// Phase A sections: Active Campaigns, About You, What You Sell, Call Handoff.
// Each section saves independently via PUT /api/settings/persona. Persona
// JSON fields that this editor does NOT yet expose (knowledgeAssets,
// proofPoints, customPhrases — Phase B) are passed through unchanged so a
// Section-1 save doesn't wipe Section-5 content written by onboarding.
//
// The "Last updated by X" metadata is populated on every save from the
// API route's contextUpdatedAt / contextUpdatedByUserId auto-fields.
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from 'sonner';

// ── Types ─────────────────────────────────────────────────────────
// Deliberately loose — the persona object carries many fields we
// preserve-through-save but don't edit in Phase A.
interface PersonaResponse {
  persona: {
    id: string;
    personaName: string;
    fullName: string;
    companyName: string | null;
    closerName: string | null;
    activeCampaignsContext: string | null;
    minimumCapitalRequired: number | null;
    capitalVerificationPrompt: string | null;
    outOfScopeTopics: string | null;
    verifiedDetails: string | null;
    contextUpdatedAt: string | null;
    contextUpdatedByUserId: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    promptConfig: Record<string, any> | null;
    // Everything else passes through — we don't care about typing it here.
    [key: string]: unknown;
  } | null;
  contextUpdatedByUser: { name: string; email: string } | null;
}

interface CallHandoffConfig {
  closerName?: string;
  closerRelation?: string;
  closerRole?: string;
  disclosureTiming?: 'soft_pitch' | 'booking_only' | 'both';
}

// ── Max-length constants per spec ─────────────────────────────────
const MAX_CAMPAIGNS = 2000;
const MAX_ADMIN_BIO = 1500;
const MAX_WHAT_YOU_SELL = 1500;
const MAX_CALL_HANDOFF = 800;

// ── Rotating placeholder examples for Active Campaigns ────────────
const CAMPAIGN_PLACEHOLDERS = [
  "IG Story CTA: Posted April 15 telling followers to DM 'MARKET' for my free breakdown. Link to send: https://example.com/free-breakdown",
  "YouTube drop April 12: 'Why Traders Fail.' Core message is discipline > strategy. Leads referencing this come in warm.",
  'Referral program active — students get $100 for qualified referrals. If someone mentions a referral, acknowledge it and route to the team.'
];

// ── Helpers ───────────────────────────────────────────────────────
function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ── Page ──────────────────────────────────────────────────────────
export default function PersonaEditorPage() {
  const [loading, setLoading] = useState(true);
  const [personaData, setPersonaData] = useState<PersonaResponse | null>(null);

  // Section state — each section has its own draft and saving flag
  // so one save doesn't clobber another's in-flight edit.
  const [campaigns, setCampaigns] = useState('');
  const [campaignsSavedSnapshot, setCampaignsSavedSnapshot] = useState('');
  const [savingCampaigns, setSavingCampaigns] = useState(false);

  const [adminBio, setAdminBio] = useState('');
  const [adminBioSavedSnapshot, setAdminBioSavedSnapshot] = useState('');
  const [savingAdminBio, setSavingAdminBio] = useState(false);

  const [whatYouSell, setWhatYouSell] = useState('');
  const [whatYouSellSavedSnapshot, setWhatYouSellSavedSnapshot] = useState('');
  const [savingWhatYouSell, setSavingWhatYouSell] = useState(false);

  const [closerName, setCloserName] = useState('');
  const [closerRelation, setCloserRelation] = useState('');
  const [closerRole, setCloserRole] = useState('');
  const [handoffDescription, setHandoffDescription] = useState('');
  const [handoffSavedSnapshot, setHandoffSavedSnapshot] = useState('');
  const [savingHandoff, setSavingHandoff] = useState(false);

  // Capital verification (R24) + out-of-scope topics (R26). Separate
  // section states so Capital saves don't require editing Scope and
  // vice versa.
  const [minCapital, setMinCapital] = useState<string>(''); // string so HTML number input clears cleanly
  const [verificationPrompt, setVerificationPrompt] = useState('');
  const [capitalSavedSnapshot, setCapitalSavedSnapshot] = useState('');
  const [savingCapital, setSavingCapital] = useState(false);

  const [outOfScope, setOutOfScope] = useState('');
  const [outOfScopeSavedSnapshot, setOutOfScopeSavedSnapshot] = useState('');
  const [savingScope, setSavingScope] = useState(false);

  // Verified Facts (R27). Free-form operator-maintained text listing
  // facts the AI is allowed to assert about third parties — closer
  // languages, refund policy, offer inclusions, etc. When empty, the
  // AI must escalate every third-party capability question.
  const [verifiedFacts, setVerifiedFacts] = useState('');
  const [verifiedFactsSavedSnapshot, setVerifiedFactsSavedSnapshot] =
    useState('');
  const [savingVerifiedFacts, setSavingVerifiedFacts] = useState(false);

  // Rotating placeholder for campaigns textarea. Cycles every 4s; pauses
  // once the user has typed anything so we don't distract.
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  useEffect(() => {
    if (campaigns.length > 0) return;
    const interval = setInterval(() => {
      setPlaceholderIndex((i) => (i + 1) % CAMPAIGN_PLACEHOLDERS.length);
    }, 4000);
    return () => clearInterval(interval);
  }, [campaigns]);

  // ── Initial load ────────────────────────────────────────────────
  const fetchPersona = useCallback(async () => {
    try {
      const data = await apiFetch<PersonaResponse>('/settings/persona');
      setPersonaData(data);
      if (data.persona) {
        const campaignsValue = data.persona.activeCampaignsContext || '';
        setCampaigns(campaignsValue);
        setCampaignsSavedSnapshot(campaignsValue);

        const config = data.persona.promptConfig || {};
        const bio = (config.adminBio as string) || '';
        setAdminBio(bio);
        setAdminBioSavedSnapshot(bio);

        const sell = (config.whatYouSell as string) || '';
        setWhatYouSell(sell);
        setWhatYouSellSavedSnapshot(sell);

        const handoffCfg = (config.callHandoff as CallHandoffConfig) || {};
        const cName = handoffCfg.closerName || data.persona.closerName || '';
        setCloserName(cName);
        setCloserRelation(handoffCfg.closerRelation || '');
        setCloserRole(handoffCfg.closerRole || '');
        // Build a single snapshot string so we can diff the whole section
        // with one comparison (simpler than tracking 4 fields separately).
        const snapshot = JSON.stringify({
          closerName: cName,
          closerRelation: handoffCfg.closerRelation || '',
          closerRole: handoffCfg.closerRole || '',
          description: ''
        });
        setHandoffDescription('');
        setHandoffSavedSnapshot(snapshot);

        // Capital verification state
        const mc =
          data.persona.minimumCapitalRequired != null
            ? String(data.persona.minimumCapitalRequired)
            : '';
        setMinCapital(mc);
        const vp = data.persona.capitalVerificationPrompt || '';
        setVerificationPrompt(vp);
        setCapitalSavedSnapshot(JSON.stringify({ minCapital: mc, vp }));

        // Out-of-scope topics
        const oos = data.persona.outOfScopeTopics || '';
        setOutOfScope(oos);
        setOutOfScopeSavedSnapshot(oos);

        // Verified facts
        const vf = data.persona.verifiedDetails || '';
        setVerifiedFacts(vf);
        setVerifiedFactsSavedSnapshot(vf);
      }
    } catch (err) {
      console.error('Failed to load persona:', err);
      toast.error('Failed to load persona data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPersona();
  }, [fetchPersona]);

  // ── Shared save helper ──────────────────────────────────────────
  // We send the FULL persona payload with only the fields this section
  // owns mutated, because the API's PUT handler does a whole-record
  // update (not a partial patch). Passing through the existing values
  // for other fields keeps Phase B sections (knowledge assets, proof
  // points, custom phrases) from being nulled out during a Phase A save.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildPayload = (overrides: Record<string, any>) => {
    const p = personaData?.persona;
    if (!p) return overrides;
    return {
      personaName: p.personaName,
      fullName: p.fullName,
      companyName: p.companyName,
      tone: (p as { tone?: string | null }).tone ?? null,
      systemPrompt: (p as { systemPrompt?: string }).systemPrompt ?? '',
      qualificationFlow:
        (p as { qualificationFlow?: unknown }).qualificationFlow ?? undefined,
      objectionHandling:
        (p as { objectionHandling?: unknown }).objectionHandling ?? undefined,
      customPhrases:
        (p as { customPhrases?: unknown }).customPhrases ?? undefined,
      promptConfig: p.promptConfig ?? undefined,
      rawScript: (p as { rawScript?: string | null }).rawScript ?? undefined,
      rawScriptFileName:
        (p as { rawScriptFileName?: string | null }).rawScriptFileName ??
        undefined,
      styleAnalysis:
        (p as { styleAnalysis?: string | null }).styleAnalysis ?? undefined,
      financialWaterfall:
        (p as { financialWaterfall?: unknown }).financialWaterfall ?? undefined,
      knowledgeAssets:
        (p as { knowledgeAssets?: unknown }).knowledgeAssets ?? undefined,
      proofPoints: (p as { proofPoints?: unknown }).proofPoints ?? undefined,
      noShowProtocol:
        (p as { noShowProtocol?: unknown }).noShowProtocol ?? undefined,
      preCallSequence:
        (p as { preCallSequence?: unknown }).preCallSequence ?? undefined,
      freeValueLink:
        (p as { freeValueLink?: string | null }).freeValueLink ?? null,
      closerName: p.closerName ?? null,
      activeCampaignsContext: p.activeCampaignsContext ?? null,
      minimumCapitalRequired: p.minimumCapitalRequired ?? null,
      capitalVerificationPrompt: p.capitalVerificationPrompt ?? null,
      outOfScopeTopics: p.outOfScopeTopics ?? null,
      verifiedDetails: p.verifiedDetails ?? null,
      voiceNotesEnabled:
        (p as { voiceNotesEnabled?: boolean }).voiceNotesEnabled ?? true,
      setupComplete:
        (p as { setupComplete?: boolean }).setupComplete ?? undefined,
      ...overrides
    };
  };

  const persistAndRefresh = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    overrides: Record<string, any>,
    successMsg: string
  ) => {
    const payload = buildPayload(overrides);
    const result = await apiFetch<{ persona: PersonaResponse['persona'] }>(
      '/settings/persona',
      {
        method: 'PUT',
        body: JSON.stringify(payload)
      }
    );
    // Refetch to pull fresh contextUpdatedAt + contextUpdatedByUser name.
    await fetchPersona();
    toast.success(successMsg);
    return result;
  };

  // ── Section savers ──────────────────────────────────────────────
  const saveCampaigns = async () => {
    setSavingCampaigns(true);
    try {
      await persistAndRefresh(
        { activeCampaignsContext: campaigns.trim() || null },
        'Active campaigns saved'
      );
      setCampaignsSavedSnapshot(campaigns);
    } catch (err) {
      console.error(err);
      toast.error('Failed to save campaigns');
    } finally {
      setSavingCampaigns(false);
    }
  };

  const saveAdminBio = async () => {
    setSavingAdminBio(true);
    try {
      const currentConfig = personaData?.persona?.promptConfig || {};
      const newConfig = { ...currentConfig, adminBio: adminBio.trim() };
      await persistAndRefresh({ promptConfig: newConfig }, 'Bio saved');
      setAdminBioSavedSnapshot(adminBio);
    } catch (err) {
      console.error(err);
      toast.error('Failed to save bio');
    } finally {
      setSavingAdminBio(false);
    }
  };

  const saveWhatYouSell = async () => {
    setSavingWhatYouSell(true);
    try {
      const currentConfig = personaData?.persona?.promptConfig || {};
      const newConfig = { ...currentConfig, whatYouSell: whatYouSell.trim() };
      await persistAndRefresh(
        { promptConfig: newConfig },
        'Offer details saved'
      );
      setWhatYouSellSavedSnapshot(whatYouSell);
    } catch (err) {
      console.error(err);
      toast.error('Failed to save offer details');
    } finally {
      setSavingWhatYouSell(false);
    }
  };

  const saveHandoff = async () => {
    setSavingHandoff(true);
    try {
      const currentConfig = personaData?.persona?.promptConfig || {};
      const existingHandoff =
        (currentConfig.callHandoff as CallHandoffConfig) || {};
      const newHandoff: CallHandoffConfig = {
        ...existingHandoff,
        closerName: closerName.trim() || undefined,
        closerRelation: closerRelation.trim() || undefined,
        closerRole: closerRole.trim() || undefined
      };
      // Drop empty keys so the object doesn't accumulate nulls
      Object.keys(newHandoff).forEach((k) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((newHandoff as any)[k] === undefined) delete (newHandoff as any)[k];
      });
      const newConfig = { ...currentConfig, callHandoff: newHandoff };
      await persistAndRefresh(
        {
          promptConfig: newConfig,
          closerName: closerName.trim() || null
        },
        'Call handoff saved'
      );
      const snapshot = JSON.stringify({
        closerName,
        closerRelation,
        closerRole,
        description: handoffDescription
      });
      setHandoffSavedSnapshot(snapshot);
    } catch (err) {
      console.error(err);
      toast.error('Failed to save call handoff');
    } finally {
      setSavingHandoff(false);
    }
  };

  const saveCapital = async () => {
    setSavingCapital(true);
    try {
      const asNumber =
        minCapital.trim().length > 0 ? parseInt(minCapital.trim(), 10) : null;
      await persistAndRefresh(
        {
          minimumCapitalRequired:
            typeof asNumber === 'number' &&
            Number.isFinite(asNumber) &&
            asNumber > 0
              ? asNumber
              : null,
          capitalVerificationPrompt: verificationPrompt.trim() || null
        },
        'Capital verification saved'
      );
      setCapitalSavedSnapshot(
        JSON.stringify({ minCapital, vp: verificationPrompt })
      );
    } catch (err) {
      console.error(err);
      toast.error('Failed to save capital verification');
    } finally {
      setSavingCapital(false);
    }
  };

  const saveScope = async () => {
    setSavingScope(true);
    try {
      await persistAndRefresh(
        { outOfScopeTopics: outOfScope.trim() || null },
        'Scope limits saved'
      );
      setOutOfScopeSavedSnapshot(outOfScope);
    } catch (err) {
      console.error(err);
      toast.error('Failed to save scope limits');
    } finally {
      setSavingScope(false);
    }
  };

  const saveVerifiedFacts = async () => {
    setSavingVerifiedFacts(true);
    try {
      await persistAndRefresh(
        { verifiedDetails: verifiedFacts.trim() || null },
        'Verified facts saved'
      );
      setVerifiedFactsSavedSnapshot(verifiedFacts);
    } catch (err) {
      console.error(err);
      toast.error('Failed to save verified facts');
    } finally {
      setSavingVerifiedFacts(false);
    }
  };

  // ── Unsaved-changes warning on navigation ───────────────────────
  const currentHandoffSnapshot = JSON.stringify({
    closerName,
    closerRelation,
    closerRole,
    description: handoffDescription
  });
  const currentCapitalSnapshot = JSON.stringify({
    minCapital,
    vp: verificationPrompt
  });
  const hasUnsavedChanges =
    campaigns !== campaignsSavedSnapshot ||
    adminBio !== adminBioSavedSnapshot ||
    whatYouSell !== whatYouSellSavedSnapshot ||
    currentHandoffSnapshot !== handoffSavedSnapshot ||
    currentCapitalSnapshot !== capitalSavedSnapshot ||
    outOfScope !== outOfScopeSavedSnapshot ||
    verifiedFacts !== verifiedFactsSavedSnapshot;
  const hasUnsavedRef = useRef(hasUnsavedChanges);
  hasUnsavedRef.current = hasUnsavedChanges;

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasUnsavedRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const updatedByLabel = personaData?.contextUpdatedByUser?.name || 'someone';
  const updatedAt = personaData?.persona?.contextUpdatedAt || null;
  const lastUpdatedText = updatedAt
    ? `Last updated ${formatRelativeTime(updatedAt)} by ${updatedByLabel}`
    : 'Never updated via this editor';

  if (loading) {
    return (
      <div className='container mx-auto flex max-w-3xl items-center justify-center py-24'>
        <Loader2 className='text-muted-foreground h-6 w-6 animate-spin' />
      </div>
    );
  }

  return (
    <div className='container mx-auto max-w-3xl space-y-6 py-8'>
      <div>
        <h1 className='text-2xl font-semibold tracking-tight'>
          Persona &amp; Context
        </h1>
        <p className='text-muted-foreground mt-2 text-sm'>
          This is what your AI knows about you. Keep it updated as your business
          changes — the AI reads from here on every message.
        </p>
        <p className='text-muted-foreground mt-1 text-xs italic'>
          {lastUpdatedText}
        </p>
      </div>

      {/* ── SECTION 1 — Active Campaigns ─────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className='text-lg'>Active Campaigns</CardTitle>
          <CardDescription>
            Tell your AI what you&apos;re currently promoting. When a lead sends
            a message matching something listed here, the AI responds with
            awareness of what they signed up for. When nothing matches, the AI
            treats the lead as a normal cold DM.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-3'>
          <Textarea
            value={campaigns}
            onChange={(e) =>
              setCampaigns(e.target.value.slice(0, MAX_CAMPAIGNS))
            }
            placeholder={CAMPAIGN_PLACEHOLDERS[placeholderIndex]}
            className='min-h-[180px]'
            maxLength={MAX_CAMPAIGNS}
          />
          <div className='flex items-center justify-between text-xs'>
            <span className='text-amber-600 dark:text-amber-400'>
              Clear expired campaigns when they end. Your AI will keep welcoming
              leads to them until you update this.
            </span>
            <span className='text-muted-foreground tabular-nums'>
              {campaigns.length} / {MAX_CAMPAIGNS}
            </span>
          </div>
          <div className='flex items-center justify-between'>
            <span className='text-muted-foreground text-xs'>
              {campaigns !== campaignsSavedSnapshot && '• Unsaved changes'}
            </span>
            <Button
              onClick={saveCampaigns}
              disabled={savingCampaigns || campaigns === campaignsSavedSnapshot}
              size='sm'
            >
              {savingCampaigns && (
                <Loader2 className='mr-2 h-3 w-3 animate-spin' />
              )}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── SECTION 2 — About You ────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className='text-lg'>About You</CardTitle>
          <CardDescription>
            Who you are and what you do. The AI references this to establish
            credibility and introduce you to leads.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-3'>
          <Textarea
            value={adminBio}
            onChange={(e) =>
              setAdminBio(e.target.value.slice(0, MAX_ADMIN_BIO))
            }
            placeholder='e.g. I run DAE Trading Accelerator, helping traders hit consistent profit through the Session Liquidity Model. Been at it for 6 years, multi-5-figure months personally, hundreds of students.'
            className='min-h-[140px]'
            maxLength={MAX_ADMIN_BIO}
          />
          <div className='flex items-center justify-between text-xs'>
            <span className='text-muted-foreground'>
              {adminBio !== adminBioSavedSnapshot && '• Unsaved changes'}
            </span>
            <span className='text-muted-foreground tabular-nums'>
              {adminBio.length} / {MAX_ADMIN_BIO}
            </span>
          </div>
          <div className='flex justify-end'>
            <Button
              onClick={saveAdminBio}
              disabled={savingAdminBio || adminBio === adminBioSavedSnapshot}
              size='sm'
            >
              {savingAdminBio && (
                <Loader2 className='mr-2 h-3 w-3 animate-spin' />
              )}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── SECTION 3 — What You Sell ────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className='text-lg'>What You Sell</CardTitle>
          <CardDescription>
            Your main offer. Include the outcome you deliver, the commitment
            level required, and who it&apos;s for.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-3'>
          <Textarea
            value={whatYouSell}
            onChange={(e) =>
              setWhatYouSell(e.target.value.slice(0, MAX_WHAT_YOU_SELL))
            }
            placeholder='e.g. 1-on-1 trading mentorship. 90 days, we work side-by-side on live trades. Outcome: consistent weekly profit using the Session Liquidity Model. For serious traders who have capital or credit and are ready to put reps in.'
            className='min-h-[140px]'
            maxLength={MAX_WHAT_YOU_SELL}
          />
          <div className='flex items-center justify-between text-xs'>
            <span className='text-muted-foreground'>
              {whatYouSell !== whatYouSellSavedSnapshot && '• Unsaved changes'}
            </span>
            <span className='text-muted-foreground tabular-nums'>
              {whatYouSell.length} / {MAX_WHAT_YOU_SELL}
            </span>
          </div>
          <div className='flex justify-end'>
            <Button
              onClick={saveWhatYouSell}
              disabled={
                savingWhatYouSell || whatYouSell === whatYouSellSavedSnapshot
              }
              size='sm'
            >
              {savingWhatYouSell && (
                <Loader2 className='mr-2 h-3 w-3 animate-spin' />
              )}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── SECTION 4 — Call Handoff ─────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className='text-lg'>Call Handoff Details</CardTitle>
          <CardDescription>
            Who qualified leads get handed off to, and what happens on that
            call. Leave closer fields blank if you take the calls yourself.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-3'>
          <div className='grid gap-3 sm:grid-cols-2'>
            <div className='space-y-1.5'>
              <Label htmlFor='closerName'>Closer name</Label>
              <Input
                id='closerName'
                value={closerName}
                onChange={(e) => setCloserName(e.target.value)}
                placeholder='e.g. Anthony'
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='closerRelation'>Relation to you</Label>
              <Input
                id='closerRelation'
                value={closerRelation}
                onChange={(e) => setCloserRelation(e.target.value)}
                placeholder='e.g. my right-hand man'
              />
            </div>
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='closerRole'>Their role on the call</Label>
            <Input
              id='closerRole'
              value={closerRole}
              onChange={(e) => setCloserRole(e.target.value)}
              placeholder='e.g. runs all our strategy calls and closes mentorship deals'
              maxLength={MAX_CALL_HANDOFF}
            />
          </div>
          <div className='flex items-center justify-between'>
            <span className='text-muted-foreground text-xs'>
              {currentHandoffSnapshot !== handoffSavedSnapshot &&
                '• Unsaved changes'}
            </span>
            <Button
              onClick={saveHandoff}
              disabled={
                savingHandoff || currentHandoffSnapshot === handoffSavedSnapshot
              }
              size='sm'
            >
              {savingHandoff && (
                <Loader2 className='mr-2 h-3 w-3 animate-spin' />
              )}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── SECTION 5 — Capital Verification (R24) ───────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className='text-lg'>Capital Verification</CardTitle>
          <CardDescription>
            Leads often overclaim on applications. When a minimum is set here,
            the AI will verify the threshold in conversation before routing to
            booking. Leave blank to skip verification.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-3'>
          <div className='space-y-1.5'>
            <Label htmlFor='minCapital'>Minimum capital to qualify (USD)</Label>
            <Input
              id='minCapital'
              type='number'
              min={0}
              step={100}
              value={minCapital}
              onChange={(e) => setMinCapital(e.target.value)}
              placeholder='e.g. 1000'
            />
            <p className='text-muted-foreground text-[11px]'>
              Leave empty to disable capital verification entirely.
            </p>
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='verificationPrompt'>
              Custom verification phrasing (optional)
            </Label>
            <Textarea
              id='verificationPrompt'
              value={verificationPrompt}
              onChange={(e) =>
                setVerificationPrompt(e.target.value.slice(0, 500))
              }
              placeholder='Leave blank to use default: "sick bro, just to confirm — you got at least $X in capital ready to start?"'
              className='min-h-[80px]'
              maxLength={500}
            />
            <p className='text-muted-foreground text-[11px]'>
              The AI will phrase this naturally. 500 chars max.
            </p>
          </div>
          <div className='flex items-center justify-between'>
            <span className='text-muted-foreground text-xs'>
              {currentCapitalSnapshot !== capitalSavedSnapshot &&
                '• Unsaved changes'}
            </span>
            <Button
              onClick={saveCapital}
              disabled={
                savingCapital || currentCapitalSnapshot === capitalSavedSnapshot
              }
              size='sm'
            >
              {savingCapital && (
                <Loader2 className='mr-2 h-3 w-3 animate-spin' />
              )}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── SECTION 6 — Scope & Limits (R26) ─────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className='text-lg'>Scope &amp; Limits</CardTitle>
          <CardDescription>
            Explicit list of topics your AI should politely decline. The AI is
            already prevented from drifting into general side-hustle /
            wealth-building advice by default. Add account-specific topics here
            that you want it to redirect from.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-3'>
          <Textarea
            value={outOfScope}
            onChange={(e) => setOutOfScope(e.target.value.slice(0, 500))}
            placeholder='e.g. career advice, general investing, crypto strategy, personal finance coaching, legal advice, tax planning'
            className='min-h-[100px]'
            maxLength={500}
          />
          <div className='flex items-center justify-between text-xs'>
            <span className='text-muted-foreground'>
              {outOfScope !== outOfScopeSavedSnapshot && '• Unsaved changes'}
            </span>
            <span className='text-muted-foreground tabular-nums'>
              {outOfScope.length} / 500
            </span>
          </div>
          <div className='flex justify-end'>
            <Button
              onClick={saveScope}
              disabled={savingScope || outOfScope === outOfScopeSavedSnapshot}
              size='sm'
            >
              {savingScope && <Loader2 className='mr-2 h-3 w-3 animate-spin' />}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── SECTION 7 — Verified Facts (R27) ─────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className='text-lg'>Verified Facts</CardTitle>
          <CardDescription>
            Everything the AI is allowed to confidently assert about your team,
            offer, and policies — languages the closer speaks, refund policy,
            exactly what the offer includes, supported timezones, anything else
            that could come up. If it&apos;s not listed here, the AI will
            escalate to &quot;lemme check with the team&quot; instead of
            inventing an answer.
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-3'>
          <Textarea
            value={verifiedFacts}
            onChange={(e) => setVerifiedFacts(e.target.value.slice(0, 3000))}
            placeholder={`Closer languages: English, Spanish
Refund policy: 14-day money-back if the lead hasn't started modules
Offer includes: 12 weekly 1-on-1 sessions, private Slack, live trade reviews
Supported timezones: Mon-Fri 9am-6pm CT
Onboarding: email intake form + kickoff call within 48h of booking`}
            className='min-h-[200px] font-mono text-sm'
            maxLength={3000}
          />
          <div className='flex items-center justify-between text-xs'>
            <span className='text-amber-600 dark:text-amber-400'>
              Only list facts you&apos;re 100% sure about — anything here
              becomes something the AI will confidently state to leads.
            </span>
            <span className='text-muted-foreground tabular-nums'>
              {verifiedFacts.length} / 3000
            </span>
          </div>
          <div className='flex items-center justify-between'>
            <span className='text-muted-foreground text-xs'>
              {verifiedFacts !== verifiedFactsSavedSnapshot &&
                '• Unsaved changes'}
            </span>
            <Button
              onClick={saveVerifiedFacts}
              disabled={
                savingVerifiedFacts ||
                verifiedFacts === verifiedFactsSavedSnapshot
              }
              size='sm'
            >
              {savingVerifiedFacts && (
                <Loader2 className='mr-2 h-3 w-3 animate-spin' />
              )}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
