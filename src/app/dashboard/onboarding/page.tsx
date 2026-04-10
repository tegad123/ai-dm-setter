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
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Rocket,
  Link2,
  AlertCircle,
  Loader2,
  ExternalLink,
  Send,
  ShieldAlert,
  Upload
} from 'lucide-react';
import { Progress } from '@/components/ui/progress';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 4;

const STEP_TITLES = [
  'Identity',
  'Upload Script',
  'Links & Settings',
  'Review & Activate'
];

const STEP_DESCRIPTIONS = [
  'Tell the AI who you are and what you do.',
  'Upload your sales script so the AI can learn your style.',
  'Configure your booking link, free value link, and response settings.',
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

  // Step 2: Upload Script
  const [rawScript, setRawScript] = useState<string | null>(null);
  const [rawScriptFileName, setRawScriptFileName] = useState<string | null>(
    null
  );
  const [styleAnalysis, setStyleAnalysis] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisStage, setAnalysisStage] = useState('');

  // Step 4: Review & Activate
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
      rawScript: rawScript || undefined,
      rawScriptFileName: rawScriptFileName || undefined,
      styleAnalysis: styleAnalysis || undefined,
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
      rawScript,
      rawScriptFileName,
      styleAnalysis,
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
        if (persona.rawScript) setRawScript(persona.rawScript as string);
        if (persona.rawScriptFileName)
          setRawScriptFileName(persona.rawScriptFileName as string);
        if (persona.styleAnalysis)
          setStyleAnalysis(persona.styleAnalysis as string);

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
  // Script upload handler
  // --------------------------------------------------

  async function handleScriptUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setAnalyzing(true);
    setAnalysisProgress(0);
    setAnalysisStage('Reading document...');

    try {
      let body: Record<string, string>;

      if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
        setAnalysisProgress(10);
        setAnalysisStage('Parsing PDF...');
        const arrayBuffer = await file.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(arrayBuffer).reduce(
            (data, byte) => data + String.fromCharCode(byte),
            ''
          )
        );
        body = { pdfBase64: base64 };
      } else {
        const documentText = await file.text();
        if (!documentText.trim()) {
          toast.error('Could not read file content.');
          setAnalyzing(false);
          return;
        }
        body = { documentText: documentText.slice(0, 100000) };
      }

      setAnalysisProgress(20);
      setAnalysisStage('Uploading to AI...');

      const progressInterval = setInterval(() => {
        setAnalysisProgress((prev) => {
          if (prev >= 85) {
            clearInterval(progressInterval);
            return 85;
          }
          return prev + Math.random() * 8;
        });
        setAnalysisStage((prev) => {
          const stages = [
            'AI is reading your script...',
            'Analyzing communication style...',
            'Mapping objection patterns...',
            'Extracting key phrases...',
            'Finalizing style analysis...'
          ];
          const currentIdx = stages.indexOf(prev);
          if (currentIdx < 0 || currentIdx >= stages.length - 1)
            return stages[0];
          return stages[currentIdx + 1];
        });
      }, 3000);

      const res = await apiFetch<{ rawScript: string; styleAnalysis: string }>(
        '/settings/persona/analyze',
        { method: 'POST', body: JSON.stringify(body) }
      );

      clearInterval(progressInterval);

      setRawScript(res.rawScript);
      setRawScriptFileName(file.name);
      setStyleAnalysis(res.styleAnalysis);
      setAnalysisProgress(100);
      setAnalysisStage('Done!');
      toast.success('Script analyzed!');
    } catch (err) {
      console.error('[onboarding] Script analysis failed:', err);
      toast.error(
        err instanceof Error
          ? `Analysis failed: ${err.message}`
          : 'Failed to analyze script'
      );
    } finally {
      setAnalyzing(false);
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
            setupStep: 5 // 5 = all complete including review
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
      // 2. Upload Script
      !!rawScript,
      // 3. Links & Settings
      true, // Always considered complete (optional fields)
      // 4. Review — not applicable
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
          <div className='space-y-6'>
            <div>
              <h2 className='mb-2 text-xl font-semibold'>
                Upload Your Sales Script
              </h2>
              <p className='text-muted-foreground text-sm'>
                Upload your sales script, setter playbook, or SOP. The AI will
                learn your style automatically.
              </p>
            </div>

            {analyzing ? (
              <div className='space-y-3'>
                <div className='flex items-center justify-between text-sm'>
                  <span className='text-muted-foreground'>{analysisStage}</span>
                  <span className='text-muted-foreground'>
                    {Math.round(analysisProgress)}%
                  </span>
                </div>
                <Progress value={analysisProgress} className='h-2' />
              </div>
            ) : rawScript ? (
              <div className='space-y-4'>
                <div className='flex items-center gap-3 rounded-lg border bg-green-50 p-4 dark:bg-green-950/30'>
                  <CheckCircle2 className='h-5 w-5 shrink-0 text-green-500' />
                  <div className='min-w-0 flex-1'>
                    <p className='text-sm font-medium'>
                      Script analyzed successfully
                    </p>
                    <p className='text-muted-foreground truncate text-xs'>
                      {rawScriptFileName || 'Uploaded document'}
                    </p>
                  </div>
                  <label className='cursor-pointer'>
                    <Button variant='outline' size='sm' asChild>
                      <span>Re-upload</span>
                    </Button>
                    <input
                      type='file'
                      className='hidden'
                      accept='.pdf,.txt,.md,.doc,.docx'
                      onChange={handleScriptUpload}
                    />
                  </label>
                </div>
              </div>
            ) : (
              <label className='block cursor-pointer'>
                <div className='hover:border-primary/50 hover:bg-muted/30 rounded-lg border-2 border-dashed p-12 text-center transition-colors'>
                  <Upload className='text-muted-foreground mx-auto mb-3 h-10 w-10' />
                  <p className='mb-1 font-medium'>
                    Drop your sales script here or click to upload
                  </p>
                  <p className='text-muted-foreground text-sm'>
                    PDF, TXT, or MD file
                  </p>
                </div>
                <input
                  type='file'
                  className='hidden'
                  accept='.pdf,.txt,.md,.doc,.docx'
                  onChange={handleScriptUpload}
                />
              </label>
            )}
          </div>
        );

      case 3:
        return (
          <div className='space-y-6'>
            {/* Booking Link */}
            <div className='space-y-2'>
              <Label htmlFor='freeValueLink'>Free Value Link</Label>
              <Input
                id='freeValueLink'
                placeholder='https://your-site.com/free-resource'
                value={freeValueLink}
                onChange={(e) => setFreeValueLink(e.target.value)}
              />
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
          </div>
        );

      // ---- Step 4: Review & Activate ----
      case 4: {
        const completionStatus = getStepCompletionStatus();

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
                    Script
                  </CardTitle>
                </CardHeader>
                <CardContent className='p-4 pt-0'>
                  <p className='text-sm'>
                    {rawScript
                      ? rawScriptFileName || 'Script uploaded'
                      : '(no script uploaded)'}
                  </p>
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
                  {freeValueLink && (
                    <p className='truncate text-sm'>
                      Free value: {freeValueLink}
                    </p>
                  )}
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
                {STEP_TITLES.slice(0, 3).map((title, i) => (
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
