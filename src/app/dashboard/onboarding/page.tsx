'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import {
  Check,
  ArrowRight,
  ArrowLeft,
  Rocket,
  Link2,
  AlertCircle,
  Loader2,
  ExternalLink,
  Send,
  ShieldAlert
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 8;

const STEP_TITLES = [
  'Identity',
  'Tone & Style',
  'Conversation Flow',
  'Value & Booking',
  'Objection Scripts',
  'Follow-ups',
  'Settings & Integrations',
  'Review & Activate'
];

const STEP_DESCRIPTIONS = [
  'Tell the AI who you are and what you do.',
  'Define your unique communication style.',
  'Set up how the AI qualifies and disqualifies leads.',
  'Configure your free value offer and booking flow.',
  'Prepare scripts for common objections.',
  'Set up automated follow-up sequences.',
  'Configure AI model, response delays, and voice notes.',
  'Review your setup and activate the AI.'
];

// ---------------------------------------------------------------------------
// Step Progress Indicator
// ---------------------------------------------------------------------------

function StepIndicator({
  currentStep,
  totalSteps
}: {
  currentStep: number;
  totalSteps: number;
}) {
  return (
    <div className='flex items-center justify-center gap-0'>
      {Array.from({ length: totalSteps }, (_, i) => {
        const stepNum = i + 1;
        const isActive = stepNum === currentStep;
        const isComplete = stepNum < currentStep;

        return (
          <div key={stepNum} className='flex items-center'>
            {/* Circle */}
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                isComplete
                  ? 'bg-primary text-primary-foreground'
                  : isActive
                    ? 'bg-primary text-primary-foreground ring-primary/30 ring-4'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              {isComplete ? <Check className='h-4 w-4' /> : stepNum}
            </div>

            {/* Connector line */}
            {i < totalSteps - 1 && (
              <div
                className={`h-0.5 w-6 transition-colors sm:w-10 ${
                  stepNum < currentStep ? 'bg-primary' : 'bg-muted'
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  // Step 1: Identity
  const [fullName, setFullName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [whatYouSell, setWhatYouSell] = useState('');
  const [adminBio, setAdminBio] = useState('');

  // Step 2: Tone & Style
  const [toneDescription, setToneDescription] = useState('');
  const [toneExamplesGood, setToneExamplesGood] = useState('');
  const [toneExamplesBad, setToneExamplesBad] = useState('');

  // Step 3: Conversation Flow
  const [openingMessageStyle, setOpeningMessageStyle] = useState('');
  const [qualificationQuestions, setQualificationQuestions] = useState('');
  const [disqualificationCriteria, setDisqualificationCriteria] = useState('');
  const [disqualificationMessage, setDisqualificationMessage] = useState('');

  // Step 4: Value & Booking
  const [freeValueLink, setFreeValueLink] = useState('');
  const [freeValueMessage, setFreeValueMessage] = useState('');
  const [freeValueFollowup, setFreeValueFollowup] = useState('');
  const [callPitchMessage, setCallPitchMessage] = useState('');
  const [bookingConfirmationMessage, setBookingConfirmationMessage] =
    useState('');

  // Step 5: Objection Scripts
  const [trustScript, setTrustScript] = useState('');
  const [priorFailureScript, setPriorFailureScript] = useState('');
  const [moneyScript, setMoneyScript] = useState('');
  const [timeScript, setTimeScript] = useState('');

  // Step 6: Follow-ups
  const [followupDay1, setFollowupDay1] = useState('');
  const [followupDay3, setFollowupDay3] = useState('');
  const [followupDay7, setFollowupDay7] = useState('');

  // Step 7: Settings & Integrations
  const [minResponseDelay, setMinResponseDelay] = useState(300);
  const [maxResponseDelay, setMaxResponseDelay] = useState(600);
  const [voiceNotesEnabled, setVoiceNotesEnabled] = useState(false);
  const [customRules, setCustomRules] = useState('');
  const [aiProvider, setAiProvider] = useState<'openai' | 'anthropic' | null>(
    null
  );
  const [integrationsLoading, setIntegrationsLoading] = useState(false);

  // Step 8: Review & Activate
  const [testMessage, setTestMessage] = useState(
    'Hey, I saw your post about trading. How does this work?'
  );
  const [testResponse, setTestResponse] = useState('');
  const [testLoading, setTestLoading] = useState(false);
  const [activating, setActivating] = useState(false);

  // --------------------------------------------------
  // Build persona payload (reused for step saves and final save)
  // --------------------------------------------------

  const buildPersonaPayload = useCallback(
    (overrides: Record<string, unknown> = {}) => ({
      personaName: fullName.trim() || 'Default Persona',
      fullName: fullName.trim(),
      companyName: companyName.trim(),
      systemPrompt: 'MASTER_TEMPLATE',
      freeValueLink: freeValueLink.trim(),
      minResponseDelay,
      maxResponseDelay,
      voiceNotesEnabled,
      objectionHandling: {
        trust: trustScript.trim(),
        priorFailure: priorFailureScript.trim(),
        money: moneyScript.trim(),
        time: timeScript.trim()
      },
      promptConfig: {
        whatYouSell: whatYouSell.trim(),
        adminBio: adminBio.trim(),
        toneDescription: toneDescription.trim(),
        toneExamplesGood: toneExamplesGood.trim(),
        toneExamplesBad: toneExamplesBad.trim(),
        openingMessageStyle: openingMessageStyle.trim(),
        qualificationQuestions: qualificationQuestions.trim(),
        disqualificationCriteria: disqualificationCriteria.trim(),
        disqualificationMessage: disqualificationMessage.trim(),
        freeValueMessage: freeValueMessage.trim(),
        freeValueFollowup: freeValueFollowup.trim(),
        callPitchMessage: callPitchMessage.trim(),
        bookingConfirmationMessage: bookingConfirmationMessage.trim(),
        followupDay1: followupDay1.trim(),
        followupDay3: followupDay3.trim(),
        followupDay7: followupDay7.trim(),
        customRules: customRules.trim()
      },
      ...overrides
    }),
    [
      fullName,
      companyName,
      freeValueLink,
      minResponseDelay,
      maxResponseDelay,
      voiceNotesEnabled,
      trustScript,
      priorFailureScript,
      moneyScript,
      timeScript,
      whatYouSell,
      adminBio,
      toneDescription,
      toneExamplesGood,
      toneExamplesBad,
      openingMessageStyle,
      qualificationQuestions,
      disqualificationCriteria,
      disqualificationMessage,
      freeValueMessage,
      freeValueFollowup,
      callPitchMessage,
      bookingConfirmationMessage,
      followupDay1,
      followupDay3,
      followupDay7,
      customRules
    ]
  );

  // --------------------------------------------------
  // Load existing persona on mount (resume from saved step)
  // --------------------------------------------------

  useEffect(() => {
    async function loadExistingPersona() {
      try {
        const persona =
          await apiFetch<Record<string, unknown>>('/settings/persona');
        if (!persona) return;

        // Restore step
        const savedStep = persona.setupStep as number | undefined;
        if (savedStep && savedStep > 0 && savedStep <= TOTAL_STEPS) {
          setStep(savedStep);
        }

        // Restore fields
        if (persona.fullName) setFullName(persona.fullName as string);
        if (persona.companyName) setCompanyName(persona.companyName as string);
        if (persona.freeValueLink)
          setFreeValueLink(persona.freeValueLink as string);
        if (persona.minResponseDelay)
          setMinResponseDelay(persona.minResponseDelay as number);
        if (persona.maxResponseDelay)
          setMaxResponseDelay(persona.maxResponseDelay as number);
        if (typeof persona.voiceNotesEnabled === 'boolean')
          setVoiceNotesEnabled(persona.voiceNotesEnabled);

        const oh = persona.objectionHandling as
          | Record<string, string>
          | undefined;
        if (oh) {
          if (oh.trust) setTrustScript(oh.trust);
          if (oh.priorFailure) setPriorFailureScript(oh.priorFailure);
          if (oh.money) setMoneyScript(oh.money);
          if (oh.time) setTimeScript(oh.time);
        }

        const pc = persona.promptConfig as Record<string, string> | undefined;
        if (pc) {
          if (pc.whatYouSell) setWhatYouSell(pc.whatYouSell);
          if (pc.adminBio) setAdminBio(pc.adminBio);
          if (pc.toneDescription) setToneDescription(pc.toneDescription);
          if (pc.toneExamplesGood) setToneExamplesGood(pc.toneExamplesGood);
          if (pc.toneExamplesBad) setToneExamplesBad(pc.toneExamplesBad);
          if (pc.openingMessageStyle)
            setOpeningMessageStyle(pc.openingMessageStyle);
          if (pc.qualificationQuestions)
            setQualificationQuestions(pc.qualificationQuestions);
          if (pc.disqualificationCriteria)
            setDisqualificationCriteria(pc.disqualificationCriteria);
          if (pc.disqualificationMessage)
            setDisqualificationMessage(pc.disqualificationMessage);
          if (pc.freeValueMessage) setFreeValueMessage(pc.freeValueMessage);
          if (pc.freeValueFollowup) setFreeValueFollowup(pc.freeValueFollowup);
          if (pc.callPitchMessage) setCallPitchMessage(pc.callPitchMessage);
          if (pc.bookingConfirmationMessage)
            setBookingConfirmationMessage(pc.bookingConfirmationMessage);
          if (pc.followupDay1) setFollowupDay1(pc.followupDay1);
          if (pc.followupDay3) setFollowupDay3(pc.followupDay3);
          if (pc.followupDay7) setFollowupDay7(pc.followupDay7);
          if (pc.customRules) setCustomRules(pc.customRules);
        }
      } catch {
        // No existing persona — start fresh
      } finally {
        setInitialLoading(false);
      }
    }

    loadExistingPersona();
  }, []);

  // --------------------------------------------------
  // Fetch integration status when entering step 7
  // --------------------------------------------------

  useEffect(() => {
    if (step !== 7) return;

    async function fetchIntegrations() {
      setIntegrationsLoading(true);
      try {
        const data = await apiFetch<Record<string, unknown>>(
          '/settings/integrations'
        );
        if (data?.openai) setAiProvider('openai');
        else if (data?.anthropic) setAiProvider('anthropic');
        else setAiProvider(null);
      } catch {
        setAiProvider(null);
      } finally {
        setIntegrationsLoading(false);
      }
    }

    fetchIntegrations();
  }, [step]);

  // --------------------------------------------------
  // Save progress per step
  // --------------------------------------------------

  async function saveStepProgress(nextStep: number) {
    try {
      await apiFetch('/settings/persona', {
        method: 'PUT',
        body: JSON.stringify(buildPersonaPayload({ setupStep: nextStep }))
      });
    } catch {
      // Silent — non-blocking
    }
  }

  // --------------------------------------------------
  // Navigation
  // --------------------------------------------------

  function goNext() {
    if (step === 1 && !fullName.trim()) {
      toast.error('Full name is required');
      return;
    }
    if (step < TOTAL_STEPS) {
      const nextStep = step + 1;
      saveStepProgress(nextStep);
      setStep(nextStep);
    }
  }

  function goBack() {
    if (step > 1) setStep(step - 1);
  }

  // --------------------------------------------------
  // Test message
  // --------------------------------------------------

  async function handleTestMessage() {
    setTestLoading(true);
    setTestResponse('');
    try {
      const result = await apiFetch<{ response: string }>('/ai/test-message', {
        method: 'POST',
        body: JSON.stringify({
          leadMessage: testMessage,
          leadName: 'Test Lead'
        })
      });
      setTestResponse(result.response);
    } catch {
      toast.error(
        'Failed to get test response. Make sure your AI provider is connected.'
      );
    } finally {
      setTestLoading(false);
    }
  }

  // --------------------------------------------------
  // Activate AI (final step)
  // --------------------------------------------------

  async function handleActivate() {
    setActivating(true);
    try {
      // 1. Save persona with active flags
      await apiFetch('/settings/persona', {
        method: 'PUT',
        body: JSON.stringify(
          buildPersonaPayload({
            isActive: true,
            setupComplete: true,
            setupStep: 9 // 9 = all complete including review
          })
        )
      });

      // 2. Mark onboarding complete
      await apiFetch('/settings/account', {
        method: 'PUT',
        body: JSON.stringify({ onboardingComplete: true })
      });

      toast.success('AI Activated! Redirecting to your dashboard...');

      // 3. Redirect
      router.push('/dashboard');
    } catch {
      toast.error('Failed to activate. Please try again.');
    } finally {
      setActivating(false);
    }
  }

  // --------------------------------------------------
  // Review helpers
  // --------------------------------------------------

  function getStepCompletionStatus(): boolean[] {
    return [
      // 1. Identity
      !!fullName.trim(),
      // 2. Tone
      !!toneDescription.trim(),
      // 3. Conversation Flow
      !!qualificationQuestions.trim(),
      // 4. Value & Booking
      !!freeValueLink.trim() || !!callPitchMessage.trim(),
      // 5. Objection Scripts
      !!trustScript.trim() || !!moneyScript.trim(),
      // 6. Follow-ups
      !!followupDay1.trim(),
      // 7. Settings
      true, // Always considered complete (has defaults)
      // 8. Review — not applicable
      false
    ];
  }

  // --------------------------------------------------
  // Step content renderer
  // --------------------------------------------------

  function renderStep() {
    switch (step) {
      case 1:
        return (
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='fullName'>
                Full Name <span className='text-destructive'>*</span>
              </Label>
              <Input
                id='fullName'
                placeholder='e.g. Daniel Elumelu'
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='companyName'>Company Name</Label>
              <Input
                id='companyName'
                placeholder='e.g. DAE Trading Accelerator'
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='whatYouSell'>What Do You Sell?</Label>
              <Textarea
                id='whatYouSell'
                placeholder='Describe your offer in a few sentences...'
                value={whatYouSell}
                onChange={(e) => setWhatYouSell(e.target.value)}
                rows={3}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='adminBio'>Your Bio</Label>
              <Textarea
                id='adminBio'
                placeholder='A short bio the AI can reference when talking about you...'
                value={adminBio}
                onChange={(e) => setAdminBio(e.target.value)}
                rows={3}
              />
            </div>
          </div>
        );

      case 2:
        return (
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='toneDescription'>Describe Your Tone</Label>
              <Textarea
                id='toneDescription'
                placeholder='e.g. Confident, direct, friendly but not too casual. Use short sentences. Drop knowledge bombs.'
                value={toneDescription}
                onChange={(e) => setToneDescription(e.target.value)}
                rows={3}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='toneExamplesGood'>
                Good Examples (paste 3-5 messages that sound like you)
              </Label>
              <Textarea
                id='toneExamplesGood'
                placeholder="Paste real messages you've sent that capture your voice..."
                value={toneExamplesGood}
                onChange={(e) => setToneExamplesGood(e.target.value)}
                rows={5}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='toneExamplesBad'>
                Bad Examples (what you&apos;d NEVER say)
              </Label>
              <Textarea
                id='toneExamplesBad'
                placeholder="Paste examples of messages that don't sound like you at all..."
                value={toneExamplesBad}
                onChange={(e) => setToneExamplesBad(e.target.value)}
                rows={5}
              />
            </div>
          </div>
        );

      case 3:
        return (
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='openingMessageStyle'>Opening Message Style</Label>
              <Textarea
                id='openingMessageStyle'
                placeholder='How should the AI open a conversation? Describe the vibe and give an example...'
                value={openingMessageStyle}
                onChange={(e) => setOpeningMessageStyle(e.target.value)}
                rows={3}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='qualificationQuestions'>
                Qualification Questions (one per line)
              </Label>
              <Textarea
                id='qualificationQuestions'
                placeholder="What's your current income level?&#10;Have you traded before?&#10;How soon are you looking to start?"
                value={qualificationQuestions}
                onChange={(e) => setQualificationQuestions(e.target.value)}
                rows={5}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='disqualificationCriteria'>
                Disqualification Criteria
              </Label>
              <Textarea
                id='disqualificationCriteria'
                placeholder='When should the AI stop pursuing a lead? e.g. Under 18, no budget, not serious...'
                value={disqualificationCriteria}
                onChange={(e) => setDisqualificationCriteria(e.target.value)}
                rows={3}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='disqualificationMessage'>
                Disqualification Message
              </Label>
              <Textarea
                id='disqualificationMessage'
                placeholder='What should the AI say when disqualifying someone? Keep it respectful...'
                value={disqualificationMessage}
                onChange={(e) => setDisqualificationMessage(e.target.value)}
                rows={3}
              />
            </div>
          </div>
        );

      case 4:
        return (
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='freeValueLink'>Free Value Link</Label>
              <Input
                id='freeValueLink'
                placeholder='https://your-site.com/free-resource'
                value={freeValueLink}
                onChange={(e) => setFreeValueLink(e.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='freeValueMessage'>
                Free Value Message (what to say when sending it)
              </Label>
              <Textarea
                id='freeValueMessage'
                placeholder="e.g. Here's a free guide I put together that breaks down my exact strategy..."
                value={freeValueMessage}
                onChange={(e) => setFreeValueMessage(e.target.value)}
                rows={3}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='freeValueFollowup'>
                Free Value Follow-up (after they receive it)
              </Label>
              <Textarea
                id='freeValueFollowup'
                placeholder='e.g. Did you get a chance to check out that guide? What stood out to you?'
                value={freeValueFollowup}
                onChange={(e) => setFreeValueFollowup(e.target.value)}
                rows={3}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='callPitchMessage'>Call Pitch Message</Label>
              <Textarea
                id='callPitchMessage'
                placeholder="How should the AI pitch the call? e.g. I'd love to hop on a quick 15-min call to see if this is a fit..."
                value={callPitchMessage}
                onChange={(e) => setCallPitchMessage(e.target.value)}
                rows={3}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='bookingConfirmationMessage'>
                Booking Confirmation Message
              </Label>
              <Textarea
                id='bookingConfirmationMessage'
                placeholder="What to say after they book. e.g. You're locked in! Check your email for the calendar invite..."
                value={bookingConfirmationMessage}
                onChange={(e) => setBookingConfirmationMessage(e.target.value)}
                rows={3}
              />
            </div>
          </div>
        );

      case 5:
        return (
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='trustScript'>Trust Objection Script</Label>
              <Textarea
                id='trustScript'
                placeholder='When they say "I don&#39;t know if this is legit..." — how do you respond?'
                value={trustScript}
                onChange={(e) => setTrustScript(e.target.value)}
                rows={4}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='priorFailureScript'>
                Prior Failure Objection Script
              </Label>
              <Textarea
                id='priorFailureScript'
                placeholder='When they say "I&#39;ve tried this before and it didn&#39;t work..." — how do you respond?'
                value={priorFailureScript}
                onChange={(e) => setPriorFailureScript(e.target.value)}
                rows={4}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='moneyScript'>Money Objection Script</Label>
              <Textarea
                id='moneyScript'
                placeholder='When they say "I can&#39;t afford it right now..." — how do you respond?'
                value={moneyScript}
                onChange={(e) => setMoneyScript(e.target.value)}
                rows={4}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='timeScript'>Time Objection Script</Label>
              <Textarea
                id='timeScript'
                placeholder='When they say "I don&#39;t have time for this..." — how do you respond?'
                value={timeScript}
                onChange={(e) => setTimeScript(e.target.value)}
                rows={4}
              />
            </div>
          </div>
        );

      case 6:
        return (
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='followupDay1'>Day 1 Follow-up</Label>
              <Textarea
                id='followupDay1'
                placeholder='What to send if they go silent after 1 day...'
                value={followupDay1}
                onChange={(e) => setFollowupDay1(e.target.value)}
                rows={3}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='followupDay3'>Day 3 Follow-up</Label>
              <Textarea
                id='followupDay3'
                placeholder='What to send if they go silent after 3 days...'
                value={followupDay3}
                onChange={(e) => setFollowupDay3(e.target.value)}
                rows={3}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='followupDay7'>Day 7 Follow-up</Label>
              <Textarea
                id='followupDay7'
                placeholder='What to send if they go silent after 7 days...'
                value={followupDay7}
                onChange={(e) => setFollowupDay7(e.target.value)}
                rows={3}
              />
            </div>
          </div>
        );

      // ---- Step 7: Settings & Integrations (NEW) ----
      case 7:
        return (
          <div className='space-y-6'>
            {/* AI Model Status */}
            <div className='space-y-2'>
              <Label>AI Model</Label>
              {integrationsLoading ? (
                <div className='text-muted-foreground flex items-center gap-2 text-sm'>
                  <Loader2 className='h-4 w-4 animate-spin' />
                  Checking integrations...
                </div>
              ) : aiProvider === 'openai' ? (
                <Badge variant='secondary' className='text-sm'>
                  <Check className='mr-1 h-3 w-3' /> Using OpenAI
                </Badge>
              ) : aiProvider === 'anthropic' ? (
                <Badge variant='secondary' className='text-sm'>
                  <Check className='mr-1 h-3 w-3' /> Using Anthropic
                </Badge>
              ) : (
                <div className='flex items-center gap-2 rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200'>
                  <AlertCircle className='h-4 w-4 shrink-0' />
                  Connect your AI provider in Integrations first
                </div>
              )}
            </div>

            <Separator />

            {/* Response Delays */}
            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='space-y-2'>
                <Label htmlFor='minResponseDelay'>
                  Minimum response delay (seconds)
                </Label>
                <Input
                  id='minResponseDelay'
                  type='number'
                  min={0}
                  value={minResponseDelay}
                  onChange={(e) =>
                    setMinResponseDelay(Number(e.target.value) || 0)
                  }
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='maxResponseDelay'>
                  Maximum response delay (seconds)
                </Label>
                <Input
                  id='maxResponseDelay'
                  type='number'
                  min={0}
                  value={maxResponseDelay}
                  onChange={(e) =>
                    setMaxResponseDelay(Number(e.target.value) || 0)
                  }
                />
              </div>
            </div>

            <Separator />

            {/* Voice Notes Toggle */}
            <div className='flex items-center justify-between gap-4'>
              <div className='space-y-0.5'>
                <Label htmlFor='voiceNotes'>Enable voice notes</Label>
                <p className='text-muted-foreground text-sm'>
                  When enabled, the AI may send voice notes for key moments like
                  trust objections or call pitches
                </p>
              </div>
              <Switch
                id='voiceNotes'
                checked={voiceNotesEnabled}
                onCheckedChange={setVoiceNotesEnabled}
              />
            </div>

            <Separator />

            {/* Custom Rules */}
            <div className='space-y-2'>
              <Label htmlFor='customRulesSettings'>
                Custom Rules (optional)
              </Label>
              <Textarea
                id='customRulesSettings'
                placeholder='Any additional rules or restrictions for your AI'
                value={customRules}
                onChange={(e) => setCustomRules(e.target.value)}
                rows={4}
              />
            </div>

            {/* Link to integrations */}
            <Button
              variant='outline'
              className='w-full'
              onClick={() =>
                window.open('/dashboard/settings/integrations', '_blank')
              }
            >
              <ExternalLink className='mr-2 h-4 w-4' />
              Manage API Keys & Connections
            </Button>
          </div>
        );

      // ---- Step 8: Review & Activate (NEW) ----
      case 8: {
        const completionStatus = getStepCompletionStatus();
        const objectionScripts = {
          trust: !!trustScript.trim(),
          priorFailure: !!priorFailureScript.trim(),
          money: !!moneyScript.trim(),
          time: !!timeScript.trim()
        };
        const followUps = {
          day1: !!followupDay1.trim(),
          day3: !!followupDay3.trim(),
          day7: !!followupDay7.trim()
        };
        const questionCount = qualificationQuestions
          .trim()
          .split('\n')
          .filter((q) => q.trim()).length;

        return (
          <div className='space-y-6'>
            {/* Summary Cards */}
            <div className='grid gap-3 sm:grid-cols-2'>
              <Card>
                <CardHeader className='p-4 pb-2'>
                  <CardTitle className='text-muted-foreground text-sm font-medium'>
                    Identity
                  </CardTitle>
                </CardHeader>
                <CardContent className='p-4 pt-0'>
                  <p className='font-semibold'>{fullName || '(not set)'}</p>
                  {companyName && (
                    <p className='text-muted-foreground text-sm'>
                      {companyName}
                    </p>
                  )}
                  {whatYouSell && (
                    <p className='mt-1 text-sm'>
                      {whatYouSell.slice(0, 100)}
                      {whatYouSell.length > 100 ? '...' : ''}
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className='p-4 pb-2'>
                  <CardTitle className='text-muted-foreground text-sm font-medium'>
                    Tone
                  </CardTitle>
                </CardHeader>
                <CardContent className='p-4 pt-0'>
                  <p className='text-sm'>
                    {toneDescription
                      ? toneDescription.slice(0, 100) +
                        (toneDescription.length > 100 ? '...' : '')
                      : '(not set)'}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className='p-4 pb-2'>
                  <CardTitle className='text-muted-foreground text-sm font-medium'>
                    Qualification
                  </CardTitle>
                </CardHeader>
                <CardContent className='p-4 pt-0'>
                  <p className='text-sm'>
                    {questionCount > 0
                      ? `${questionCount} question${questionCount !== 1 ? 's' : ''} configured`
                      : '(no questions set)'}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className='p-4 pb-2'>
                  <CardTitle className='text-muted-foreground text-sm font-medium'>
                    Objections
                  </CardTitle>
                </CardHeader>
                <CardContent className='flex flex-wrap gap-1.5 p-4 pt-0'>
                  <Badge
                    variant={objectionScripts.trust ? 'default' : 'outline'}
                  >
                    {objectionScripts.trust ? (
                      <Check className='mr-1 h-3 w-3' />
                    ) : null}
                    Trust
                  </Badge>
                  <Badge
                    variant={objectionScripts.money ? 'default' : 'outline'}
                  >
                    {objectionScripts.money ? (
                      <Check className='mr-1 h-3 w-3' />
                    ) : null}
                    Money
                  </Badge>
                  <Badge
                    variant={
                      objectionScripts.priorFailure ? 'default' : 'outline'
                    }
                  >
                    {objectionScripts.priorFailure ? (
                      <Check className='mr-1 h-3 w-3' />
                    ) : null}
                    Prior Failure
                  </Badge>
                  <Badge
                    variant={objectionScripts.time ? 'default' : 'outline'}
                  >
                    {objectionScripts.time ? (
                      <Check className='mr-1 h-3 w-3' />
                    ) : null}
                    Time
                  </Badge>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className='p-4 pb-2'>
                  <CardTitle className='text-muted-foreground text-sm font-medium'>
                    Follow-ups
                  </CardTitle>
                </CardHeader>
                <CardContent className='flex flex-wrap gap-1.5 p-4 pt-0'>
                  <Badge variant={followUps.day1 ? 'default' : 'outline'}>
                    {followUps.day1 ? <Check className='mr-1 h-3 w-3' /> : null}
                    Day 1
                  </Badge>
                  <Badge variant={followUps.day3 ? 'default' : 'outline'}>
                    {followUps.day3 ? <Check className='mr-1 h-3 w-3' /> : null}
                    Day 3
                  </Badge>
                  <Badge variant={followUps.day7 ? 'default' : 'outline'}>
                    {followUps.day7 ? <Check className='mr-1 h-3 w-3' /> : null}
                    Day 7
                  </Badge>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className='p-4 pb-2'>
                  <CardTitle className='text-muted-foreground text-sm font-medium'>
                    Settings
                  </CardTitle>
                </CardHeader>
                <CardContent className='p-4 pt-0'>
                  <p className='text-sm'>
                    Delay: {minResponseDelay}s &ndash; {maxResponseDelay}s
                  </p>
                  <p className='text-sm'>
                    Voice notes: {voiceNotesEnabled ? 'On' : 'Off'}
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Step Checklist */}
            <Card>
              <CardHeader className='p-4 pb-2'>
                <CardTitle className='text-sm font-medium'>
                  Setup Checklist
                </CardTitle>
              </CardHeader>
              <CardContent className='space-y-2 p-4 pt-0'>
                {STEP_TITLES.slice(0, 7).map((title, i) => (
                  <div key={title} className='flex items-center gap-2 text-sm'>
                    {completionStatus[i] ? (
                      <Check className='h-4 w-4 text-green-600' />
                    ) : (
                      <AlertCircle className='h-4 w-4 text-yellow-500' />
                    )}
                    <span
                      className={
                        completionStatus[i] ? '' : 'text-muted-foreground'
                      }
                    >
                      {title}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Separator />

            {/* Test Message Section */}
            <Card>
              <CardHeader className='p-4 pb-2'>
                <CardTitle className='text-sm font-medium'>
                  Send Test Message
                </CardTitle>
                <CardDescription className='text-xs'>
                  Simulate a lead message and see how your AI responds.
                </CardDescription>
              </CardHeader>
              <CardContent className='space-y-3 p-4 pt-0'>
                <div className='flex gap-2'>
                  <Input
                    value={testMessage}
                    onChange={(e) => setTestMessage(e.target.value)}
                    placeholder='Type a simulated lead message...'
                  />
                  <Button
                    onClick={handleTestMessage}
                    disabled={testLoading || !testMessage.trim()}
                    size='sm'
                  >
                    {testLoading ? (
                      <Loader2 className='h-4 w-4 animate-spin' />
                    ) : (
                      <Send className='h-4 w-4' />
                    )}
                  </Button>
                </div>

                {testResponse && (
                  <div className='space-y-2'>
                    {/* Lead bubble */}
                    <div className='flex justify-end'>
                      <div className='bg-primary text-primary-foreground max-w-[80%] rounded-2xl rounded-br-sm px-4 py-2 text-sm'>
                        {testMessage}
                      </div>
                    </div>
                    {/* AI bubble */}
                    <div className='flex justify-start'>
                      <div className='bg-muted max-w-[80%] rounded-2xl rounded-bl-sm px-4 py-2 text-sm'>
                        {testResponse}
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Separator />

            {/* Activate AI */}
            <Card className='border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950'>
              <CardContent className='flex flex-col items-center py-8 text-center'>
                <Rocket className='mb-4 h-12 w-12 text-green-600 dark:text-green-400' />
                <h3 className='text-xl font-semibold'>Ready to go live?</h3>
                <div className='mt-3 flex items-start gap-2 rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200'>
                  <ShieldAlert className='mt-0.5 h-4 w-4 shrink-0' />
                  <span>
                    Once activated, your AI will begin responding to real leads.
                  </span>
                </div>
                <Button
                  className='mt-6 px-8'
                  size='lg'
                  onClick={handleActivate}
                  disabled={activating || saving}
                >
                  {activating ? (
                    <>
                      <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                      Activating...
                    </>
                  ) : (
                    <>
                      <Rocket className='mr-2 h-4 w-4' />
                      Activate AI
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          </div>
        );
      }

      default:
        return null;
    }
  }

  // --------------------------------------------------
  // Render
  // --------------------------------------------------

  if (initialLoading) {
    return (
      <div className='flex flex-1 items-center justify-center p-8'>
        <Loader2 className='text-muted-foreground h-8 w-8 animate-spin' />
      </div>
    );
  }

  return (
    <div className='flex flex-1 flex-col items-center p-4 md:p-6'>
      <div className='w-full max-w-2xl space-y-6'>
        {/* Step Indicator */}
        <StepIndicator currentStep={step} totalSteps={TOTAL_STEPS} />

        {/* Card */}
        <Card>
          <CardHeader>
            <CardTitle className='text-xl'>{STEP_TITLES[step - 1]}</CardTitle>
            <CardDescription>{STEP_DESCRIPTIONS[step - 1]}</CardDescription>
          </CardHeader>
          <CardContent>{renderStep()}</CardContent>
        </Card>

        {/* Navigation Buttons */}
        {step < TOTAL_STEPS && (
          <div className='flex justify-between'>
            <Button variant='outline' onClick={goBack} disabled={step === 1}>
              <ArrowLeft className='mr-2 h-4 w-4' />
              Back
            </Button>
            <Button onClick={goNext}>
              Next
              <ArrowRight className='ml-2 h-4 w-4' />
            </Button>
          </div>
        )}

        {step === TOTAL_STEPS && (
          <div className='flex justify-start'>
            <Button variant='outline' onClick={goBack}>
              <ArrowLeft className='mr-2 h-4 w-4' />
              Back
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
