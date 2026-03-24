'use client';

import { useEffect, useState } from 'react';
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
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import {
  Loader2,
  Upload,
  FileText,
  Sparkles,
  Plus,
  Trash2,
  CheckCircle2
} from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { VoiceProfileDashboard } from '@/features/voice-profile/components/profile-dashboard';

interface WaterfallStep {
  label: string;
  question: string;
  threshold: string;
  passAction: string;
}

interface KnowledgeAsset {
  title: string;
  content: string;
  deployTrigger: string;
}

interface ProofPoint {
  name: string;
  result: string;
  deployContext: string;
}

interface PreCallItem {
  timing: string;
  message: string;
}

interface PersonaData {
  fullName: string;
  companyName: string;
  freeValueLink: string;
  closerName: string;
  objectionHandling: {
    trust: string;
    priorFailure: string;
    money: string;
    time: string;
  };
  promptConfig: {
    whatYouSell: string;
    adminBio: string;
    toneDescription: string;
    toneExamplesGood: string;
    toneExamplesBad: string;
    openingMessageStyle: string;
    qualificationQuestions: string;
    disqualificationCriteria: string;
    disqualificationMessage: string;
    urgencyQuestion: string;
    freeValueMessage: string;
    freeValueFollowup: string;
    callPitchMessage: string;
    bookingConfirmationMessage: string;
    followupDay1: string;
    followupDay3: string;
    followupDay7: string;
    stallTimeScript: string;
    stallMoneyScript: string;
    stallThinkScript: string;
    stallPartnerScript: string;
    customRules: string;
  };
  financialWaterfall: WaterfallStep[];
  knowledgeAssets: KnowledgeAsset[];
  proofPoints: ProofPoint[];
  noShowProtocol: {
    firstNoShow: string;
    secondNoShow: string;
  };
  preCallSequence: PreCallItem[];
}

const defaultPersona: PersonaData = {
  fullName: '',
  companyName: '',
  freeValueLink: '',
  closerName: '',
  objectionHandling: {
    trust: '',
    priorFailure: '',
    money: '',
    time: ''
  },
  promptConfig: {
    whatYouSell: '',
    adminBio: '',
    toneDescription: '',
    toneExamplesGood: '',
    toneExamplesBad: '',
    openingMessageStyle: '',
    qualificationQuestions: '',
    disqualificationCriteria: '',
    disqualificationMessage: '',
    urgencyQuestion: '',
    freeValueMessage: '',
    freeValueFollowup: '',
    callPitchMessage: '',
    bookingConfirmationMessage: '',
    followupDay1: '',
    followupDay3: '',
    followupDay7: '',
    stallTimeScript: '',
    stallMoneyScript: '',
    stallThinkScript: '',
    stallPartnerScript: '',
    customRules: ''
  },
  financialWaterfall: [],
  knowledgeAssets: [],
  proofPoints: [],
  noShowProtocol: { firstNoShow: '', secondNoShow: '' },
  preCallSequence: []
};

export default function PersonaSettingsPage() {
  const [persona, setPersona] = useState<PersonaData>(defaultPersona);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractionProgress, setExtractionProgress] = useState(0);
  const [extractionStage, setExtractionStage] = useState('');
  const [extractionDone, setExtractionDone] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch<{ persona: any }>('/settings/persona');
        const data = res.persona;
        if (data) {
          const pc = data.promptConfig || {};
          const oh = data.objectionHandling || {};
          const ns = data.noShowProtocol || {};
          setPersona({
            fullName: data.fullName ?? '',
            companyName: data.companyName ?? '',
            freeValueLink: data.freeValueLink ?? '',
            closerName: data.closerName ?? '',
            objectionHandling: {
              trust: oh.trust ?? '',
              priorFailure: oh.priorFailure ?? '',
              money: oh.money ?? '',
              time: oh.time ?? ''
            },
            promptConfig: {
              whatYouSell: pc.whatYouSell ?? '',
              adminBio: pc.adminBio ?? '',
              toneDescription: pc.toneDescription ?? '',
              toneExamplesGood: pc.toneExamplesGood ?? '',
              toneExamplesBad: pc.toneExamplesBad ?? '',
              openingMessageStyle: pc.openingMessageStyle ?? '',
              qualificationQuestions: pc.qualificationQuestions ?? '',
              disqualificationCriteria: pc.disqualificationCriteria ?? '',
              disqualificationMessage: pc.disqualificationMessage ?? '',
              urgencyQuestion: pc.urgencyQuestion ?? '',
              freeValueMessage: pc.freeValueMessage ?? '',
              freeValueFollowup: pc.freeValueFollowup ?? '',
              callPitchMessage: pc.callPitchMessage ?? '',
              bookingConfirmationMessage: pc.bookingConfirmationMessage ?? '',
              followupDay1: pc.followupDay1 ?? '',
              followupDay3: pc.followupDay3 ?? '',
              followupDay7: pc.followupDay7 ?? '',
              stallTimeScript: pc.stallTimeScript ?? '',
              stallMoneyScript: pc.stallMoneyScript ?? '',
              stallThinkScript: pc.stallThinkScript ?? '',
              stallPartnerScript: pc.stallPartnerScript ?? '',
              customRules: pc.customRules ?? ''
            },
            financialWaterfall: Array.isArray(data.financialWaterfall)
              ? data.financialWaterfall
              : [],
            knowledgeAssets: Array.isArray(data.knowledgeAssets)
              ? data.knowledgeAssets
              : [],
            proofPoints: Array.isArray(data.proofPoints)
              ? data.proofPoints
              : [],
            noShowProtocol: {
              firstNoShow: ns.firstNoShow ?? '',
              secondNoShow: ns.secondNoShow ?? ''
            },
            preCallSequence: Array.isArray(data.preCallSequence)
              ? data.preCallSequence
              : []
          });
        }
      } catch {
        // If no persona exists yet, keep defaults
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  function updateField(field: keyof PersonaData, value: string) {
    setPersona((prev) => ({ ...prev, [field]: value }));
  }

  function updatePromptConfig(
    field: keyof PersonaData['promptConfig'],
    value: string
  ) {
    setPersona((prev) => ({
      ...prev,
      promptConfig: { ...prev.promptConfig, [field]: value }
    }));
  }

  function updateObjection(
    field: keyof PersonaData['objectionHandling'],
    value: string
  ) {
    setPersona((prev) => ({
      ...prev,
      objectionHandling: { ...prev.objectionHandling, [field]: value }
    }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch('/settings/persona', {
        method: 'PUT',
        body: JSON.stringify({
          personaName: persona.fullName || 'Default Persona',
          fullName: persona.fullName,
          companyName: persona.companyName,
          systemPrompt: 'MASTER_TEMPLATE',
          freeValueLink: persona.freeValueLink,
          closerName: persona.closerName,
          objectionHandling: persona.objectionHandling,
          promptConfig: persona.promptConfig,
          financialWaterfall:
            persona.financialWaterfall.length > 0
              ? persona.financialWaterfall
              : undefined,
          knowledgeAssets:
            persona.knowledgeAssets.length > 0
              ? persona.knowledgeAssets
              : undefined,
          proofPoints:
            persona.proofPoints.length > 0 ? persona.proofPoints : undefined,
          noShowProtocol:
            persona.noShowProtocol.firstNoShow ||
            persona.noShowProtocol.secondNoShow
              ? persona.noShowProtocol
              : undefined,
          preCallSequence:
            persona.preCallSequence.length > 0
              ? persona.preCallSequence
              : undefined
        })
      });
      toast.success('Persona saved');
    } catch {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleDocumentUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setExtracting(true);
    setExtractionDone(false);
    setExtractionProgress(0);
    setExtractionStage('Reading document...');
    setUploadedFileName(file.name);

    try {
      let body: Record<string, string>;

      if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
        setExtractionProgress(10);
        setExtractionStage('Parsing PDF...');
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
          toast.error('Could not read file content. Try a .txt or .md file.');
          setExtracting(false);
          return;
        }
        body = { documentText: documentText.slice(0, 100000) };
      }

      setExtractionProgress(20);
      setExtractionStage('Uploading to AI...');

      // Simulate progress while waiting for AI analysis
      const progressInterval = setInterval(() => {
        setExtractionProgress((prev) => {
          if (prev >= 85) {
            clearInterval(progressInterval);
            return 85;
          }
          return prev + Math.random() * 8;
        });
        setExtractionStage((prev) => {
          // Rotate through analysis stages
          const stages = [
            'AI is reading your document...',
            'Extracting sales scripts...',
            'Mapping objection handling...',
            'Identifying follow-up sequences...',
            'Extracting qualification questions...',
            'Mapping stall scripts...',
            'Processing no-show protocols...',
            'Finalizing extraction...'
          ];
          const currentIdx = stages.indexOf(prev);
          if (currentIdx < 0 || currentIdx >= stages.length - 1)
            return stages[0];
          return stages[currentIdx + 1];
        });
      }, 3000);

      const res = await apiFetch<{ extracted: any }>(
        '/settings/persona/extract',
        {
          method: 'POST',
          body: JSON.stringify(body)
        }
      );

      clearInterval(progressInterval);
      setExtractionProgress(95);
      setExtractionStage('Filling in fields...');

      const data = res.extracted;
      if (data) {
        const epc = data.promptConfig || {};
        const ens = data.noShowProtocol || {};
        setPersona((prev) => ({
          fullName: data.fullName || prev.fullName,
          companyName: data.companyName || prev.companyName,
          freeValueLink: data.freeValueLink || prev.freeValueLink,
          closerName: data.closerName || prev.closerName,
          objectionHandling: {
            trust:
              data.objectionHandling?.trust || prev.objectionHandling.trust,
            priorFailure:
              data.objectionHandling?.priorFailure ||
              prev.objectionHandling.priorFailure,
            money:
              data.objectionHandling?.money || prev.objectionHandling.money,
            time: data.objectionHandling?.time || prev.objectionHandling.time
          },
          promptConfig: {
            whatYouSell: epc.whatYouSell || prev.promptConfig.whatYouSell,
            adminBio: epc.adminBio || prev.promptConfig.adminBio,
            toneDescription:
              epc.toneDescription || prev.promptConfig.toneDescription,
            toneExamplesGood:
              epc.toneExamplesGood || prev.promptConfig.toneExamplesGood,
            toneExamplesBad:
              epc.toneExamplesBad || prev.promptConfig.toneExamplesBad,
            openingMessageStyle:
              epc.openingMessageStyle || prev.promptConfig.openingMessageStyle,
            qualificationQuestions:
              epc.qualificationQuestions ||
              prev.promptConfig.qualificationQuestions,
            disqualificationCriteria:
              epc.disqualificationCriteria ||
              prev.promptConfig.disqualificationCriteria,
            disqualificationMessage:
              epc.disqualificationMessage ||
              prev.promptConfig.disqualificationMessage,
            urgencyQuestion:
              epc.urgencyQuestion || prev.promptConfig.urgencyQuestion,
            freeValueMessage:
              epc.freeValueMessage || prev.promptConfig.freeValueMessage,
            freeValueFollowup:
              epc.freeValueFollowup || prev.promptConfig.freeValueFollowup,
            callPitchMessage:
              epc.callPitchMessage || prev.promptConfig.callPitchMessage,
            bookingConfirmationMessage:
              epc.bookingConfirmationMessage ||
              prev.promptConfig.bookingConfirmationMessage,
            followupDay1: epc.followupDay1 || prev.promptConfig.followupDay1,
            followupDay3: epc.followupDay3 || prev.promptConfig.followupDay3,
            followupDay7: epc.followupDay7 || prev.promptConfig.followupDay7,
            stallTimeScript:
              epc.stallTimeScript || prev.promptConfig.stallTimeScript,
            stallMoneyScript:
              epc.stallMoneyScript || prev.promptConfig.stallMoneyScript,
            stallThinkScript:
              epc.stallThinkScript || prev.promptConfig.stallThinkScript,
            stallPartnerScript:
              epc.stallPartnerScript || prev.promptConfig.stallPartnerScript,
            customRules: epc.customRules || prev.promptConfig.customRules
          },
          financialWaterfall:
            Array.isArray(data.financialWaterfall) &&
            data.financialWaterfall.length > 0
              ? data.financialWaterfall
              : prev.financialWaterfall,
          knowledgeAssets:
            Array.isArray(data.knowledgeAssets) &&
            data.knowledgeAssets.length > 0
              ? data.knowledgeAssets
              : prev.knowledgeAssets,
          proofPoints:
            Array.isArray(data.proofPoints) && data.proofPoints.length > 0
              ? data.proofPoints
              : prev.proofPoints,
          noShowProtocol: {
            firstNoShow: ens.firstNoShow || prev.noShowProtocol.firstNoShow,
            secondNoShow: ens.secondNoShow || prev.noShowProtocol.secondNoShow
          },
          preCallSequence:
            Array.isArray(data.preCallSequence) &&
            data.preCallSequence.length > 0
              ? data.preCallSequence
              : prev.preCallSequence
        }));
        setExtractionProgress(100);
        setExtractionStage('Done! All fields have been filled.');
        setExtractionDone(true);
        toast.success(
          `Persona auto-filled from "${file.name}"! Review the fields and click Save.`
        );
        // Reset done state after 5 seconds
        setTimeout(() => setExtractionDone(false), 5000);
      }
    } catch (err) {
      console.error('Document extraction error:', err);
      toast.error('Failed to extract persona from document');
      setExtractionProgress(0);
      setExtractionStage('');
    } finally {
      setExtracting(false);
      // Reset file input
      e.target.value = '';
    }
  }

  if (loading) {
    return (
      <div className='flex flex-1 items-center justify-center p-12'>
        <Loader2 className='text-muted-foreground h-8 w-8 animate-spin' />
      </div>
    );
  }

  return (
    <div className='flex flex-1 flex-col gap-6 p-4 md:p-6'>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-2xl font-bold tracking-tight'>AI Persona</h2>
          <p className='text-muted-foreground'>
            Configure how your AI speaks and handles conversations.
          </p>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
          Save Changes
        </Button>
      </div>

      {/* Document Upload — Auto-fill */}
      <Card
        className={`border-2 border-dashed ${extractionDone ? 'border-green-300 bg-green-50/30 dark:border-green-800 dark:bg-green-950/20' : 'border-blue-200 bg-blue-50/30 dark:border-blue-800 dark:bg-blue-950/20'}`}
      >
        <CardContent className='flex flex-col gap-4 py-8'>
          <div className='flex flex-col items-center gap-4 sm:flex-row sm:justify-between'>
            <div className='flex items-center gap-3'>
              <div
                className={`flex h-12 w-12 items-center justify-center rounded-full ${extractionDone ? 'bg-green-100 dark:bg-green-900' : 'bg-blue-100 dark:bg-blue-900'}`}
              >
                {extractionDone ? (
                  <CheckCircle2 className='h-6 w-6 text-green-600 dark:text-green-400' />
                ) : (
                  <Sparkles className='h-6 w-6 text-blue-600 dark:text-blue-400' />
                )}
              </div>
              <div>
                <h3 className='font-semibold'>
                  {extractionDone
                    ? 'Document Analyzed!'
                    : 'Auto-Fill from Document'}
                </h3>
                <p className='text-muted-foreground text-sm'>
                  {extractionDone
                    ? 'All fields have been filled. Review them below and click Save.'
                    : 'Upload your setter playbook, sales script, or brand guide — AI will extract everything and fill all fields automatically.'}
                </p>
              </div>
            </div>
            <div className='flex items-center gap-3'>
              {uploadedFileName && !extracting && (
                <span className='text-muted-foreground flex items-center gap-1 text-sm'>
                  <FileText className='h-4 w-4' />
                  {uploadedFileName}
                </span>
              )}
              <label htmlFor='doc-upload'>
                <input
                  id='doc-upload'
                  type='file'
                  accept='.txt,.md,.doc,.docx,.pdf'
                  className='hidden'
                  onChange={handleDocumentUpload}
                  disabled={extracting}
                />
                <Button
                  variant={extractionDone ? 'outline' : 'default'}
                  disabled={extracting}
                  className='cursor-pointer'
                  asChild
                >
                  <span>
                    {extracting ? (
                      <>
                        <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                        Analyzing...
                      </>
                    ) : extractionDone ? (
                      <>
                        <Upload className='mr-2 h-4 w-4' />
                        Upload Another
                      </>
                    ) : (
                      <>
                        <Upload className='mr-2 h-4 w-4' />
                        Upload Document
                      </>
                    )}
                  </span>
                </Button>
              </label>
            </div>
          </div>

          {/* Progress Bar — visible during extraction */}
          {extracting && (
            <div className='mt-2 space-y-2'>
              <div className='flex items-center justify-between'>
                <span className='text-sm font-medium text-blue-700 dark:text-blue-300'>
                  {extractionStage}
                </span>
                <span className='text-sm font-medium text-blue-700 dark:text-blue-300'>
                  {Math.round(extractionProgress)}%
                </span>
              </div>
              <Progress value={extractionProgress} className='h-2' />
              <p className='text-muted-foreground text-xs'>
                This can take 30-60 seconds for large documents. Do not close
                this page.
              </p>
            </div>
          )}

          {/* Done state — briefly shown after extraction completes */}
          {!extracting && extractionDone && (
            <div className='mt-2 space-y-2'>
              <div className='flex items-center justify-between'>
                <span className='text-sm font-medium text-green-700 dark:text-green-300'>
                  ✓ Extraction complete — all fields populated
                </span>
                <span className='text-sm font-medium text-green-700 dark:text-green-300'>
                  100%
                </span>
              </div>
              <Progress value={100} className='h-2' />
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      {/* Voice Profile — Creator DNA */}
      <VoiceProfileDashboard />

      <div className='grid gap-6'>
        {/* Section 1: Identity */}
        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
            <CardDescription>
              Basic info about you and your brand
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='grid gap-2'>
              <Label htmlFor='fullName'>
                Your Full Name <span className='text-destructive'>*</span>
              </Label>
              <Input
                id='fullName'
                placeholder='e.g. Daniel Elumelu'
                value={persona.fullName}
                onChange={(e) => updateField('fullName', e.target.value)}
                required
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='companyName'>Brand / Company Name</Label>
              <Input
                id='companyName'
                placeholder='e.g. DAE Trading Accelerator'
                value={persona.companyName}
                onChange={(e) => updateField('companyName', e.target.value)}
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='whatYouSell'>What You Sell</Label>
              <Textarea
                id='whatYouSell'
                placeholder='Describe your offer — what do people get when they enroll?'
                rows={3}
                value={persona.promptConfig.whatYouSell}
                onChange={(e) =>
                  updatePromptConfig('whatYouSell', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='adminBio'>Your Bio & Credibility</Label>
              <Textarea
                id='adminBio'
                placeholder='Background, experience, results — what makes you the authority?'
                rows={4}
                value={persona.promptConfig.adminBio}
                onChange={(e) => updatePromptConfig('adminBio', e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Section 2: Tone & Style */}
        <Card>
          <CardHeader>
            <CardTitle>Tone & Style</CardTitle>
            <CardDescription>
              Define how the AI sounds in conversations
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='grid gap-2'>
              <Label htmlFor='toneDescription'>Tone Description</Label>
              <Textarea
                id='toneDescription'
                placeholder='How do you talk? (e.g. casual, direct, encouraging, no fluff)'
                rows={3}
                value={persona.promptConfig.toneDescription}
                onChange={(e) =>
                  updatePromptConfig('toneDescription', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='toneExamplesGood'>Good Tone Examples</Label>
              <Textarea
                id='toneExamplesGood'
                placeholder='Paste 3-5 messages that sound exactly like you'
                rows={5}
                value={persona.promptConfig.toneExamplesGood}
                onChange={(e) =>
                  updatePromptConfig('toneExamplesGood', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='toneExamplesBad'>Bad Tone Examples</Label>
              <Textarea
                id='toneExamplesBad'
                placeholder="Messages you'd NEVER send — what doesn't sound like you"
                rows={5}
                value={persona.promptConfig.toneExamplesBad}
                onChange={(e) =>
                  updatePromptConfig('toneExamplesBad', e.target.value)
                }
              />
            </div>
          </CardContent>
        </Card>

        {/* Section 3: Conversation Flow */}
        <Card>
          <CardHeader>
            <CardTitle>Conversation Flow</CardTitle>
            <CardDescription>
              How the AI guides leads through the funnel
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='grid gap-2'>
              <Label htmlFor='openingMessageStyle'>Opening Message Style</Label>
              <Textarea
                id='openingMessageStyle'
                placeholder='How do you typically open a conversation with a new lead?'
                rows={3}
                value={persona.promptConfig.openingMessageStyle}
                onChange={(e) =>
                  updatePromptConfig('openingMessageStyle', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='qualificationQuestions'>
                Qualification Questions
              </Label>
              <Textarea
                id='qualificationQuestions'
                placeholder={
                  "1. What got you interested in trading?\n2. How long have you been trading?\n3. What's your current income level?\n(The AI asks these one at a time)"
                }
                rows={6}
                value={persona.promptConfig.qualificationQuestions}
                onChange={(e) =>
                  updatePromptConfig('qualificationQuestions', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='disqualificationCriteria'>
                Disqualification Criteria
              </Label>
              <Textarea
                id='disqualificationCriteria'
                placeholder='When should the AI NOT book a call? (e.g. under 18, no income, not serious)'
                rows={3}
                value={persona.promptConfig.disqualificationCriteria}
                onChange={(e) =>
                  updatePromptConfig('disqualificationCriteria', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='disqualificationMessage'>
                Disqualification Message
              </Label>
              <Textarea
                id='disqualificationMessage'
                placeholder='What should the AI say when disqualifying a lead?'
                rows={3}
                value={persona.promptConfig.disqualificationMessage}
                onChange={(e) =>
                  updatePromptConfig('disqualificationMessage', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='closerName'>Closer Name (for calls)</Label>
              <Input
                id='closerName'
                placeholder='Name of the person who handles calls (e.g. Anthony)'
                value={persona.closerName}
                onChange={(e) => updateField('closerName', e.target.value)}
              />
              <p className='text-muted-foreground text-xs'>
                If left empty, your name will be used.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Section: Urgency & Commitment */}
        <Card>
          <CardHeader>
            <CardTitle>Urgency & Commitment</CardTitle>
            <CardDescription>
              The mandatory urgency question that fires before every soft pitch
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='grid gap-2'>
              <Label htmlFor='urgencyQuestion'>Urgency Question</Label>
              <Textarea
                id='urgencyQuestion'
                placeholder='e.g. "I can see the hunger toward achieving [their goal]. But why is now so important to finally make this happen? Why now?"'
                rows={4}
                value={persona.promptConfig.urgencyQuestion}
                onChange={(e) =>
                  updatePromptConfig('urgencyQuestion', e.target.value)
                }
              />
              <p className='text-muted-foreground text-xs'>
                This question fires every time before pitching. Gets the lead to
                verbalize their own urgency.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Section 4: Value & Booking */}
        <Card>
          <CardHeader>
            <CardTitle>Value & Booking</CardTitle>
            <CardDescription>
              Free resources and call booking flow
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='grid gap-2'>
              <Label htmlFor='freeValueLink'>Free Value Link</Label>
              <Input
                id='freeValueLink'
                type='url'
                placeholder='https://your-site.com/free-resource'
                value={persona.freeValueLink}
                onChange={(e) => updateField('freeValueLink', e.target.value)}
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='freeValueMessage'>Free Value Message</Label>
              <Textarea
                id='freeValueMessage'
                placeholder='How should the AI introduce your free resource?'
                rows={3}
                value={persona.promptConfig.freeValueMessage}
                onChange={(e) =>
                  updatePromptConfig('freeValueMessage', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='freeValueFollowup'>Free Value Follow-up</Label>
              <Textarea
                id='freeValueFollowup'
                placeholder='What should the AI say after sending the resource?'
                rows={3}
                value={persona.promptConfig.freeValueFollowup}
                onChange={(e) =>
                  updatePromptConfig('freeValueFollowup', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='callPitchMessage'>Call Pitch Message</Label>
              <Textarea
                id='callPitchMessage'
                placeholder='How should the AI pitch the call?'
                rows={3}
                value={persona.promptConfig.callPitchMessage}
                onChange={(e) =>
                  updatePromptConfig('callPitchMessage', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='bookingConfirmationMessage'>
                Booking Confirmation
              </Label>
              <Textarea
                id='bookingConfirmationMessage'
                placeholder='What should the AI say when a call is booked?'
                rows={3}
                value={persona.promptConfig.bookingConfirmationMessage}
                onChange={(e) =>
                  updatePromptConfig(
                    'bookingConfirmationMessage',
                    e.target.value
                  )
                }
              />
            </div>
          </CardContent>
        </Card>

        {/* Section 5: Objection Handling */}
        <Card>
          <CardHeader>
            <CardTitle>Objection Handling</CardTitle>
            <CardDescription>
              Scripts the AI uses when leads push back
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='grid gap-2'>
              <Label htmlFor='trustScript'>Trust Objection Script</Label>
              <Textarea
                id='trustScript'
                placeholder='How you handle trust objections like skepticism or scam concerns'
                rows={4}
                value={persona.objectionHandling.trust}
                onChange={(e) => updateObjection('trust', e.target.value)}
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='priorFailureScript'>Prior Failure Script</Label>
              <Textarea
                id='priorFailureScript'
                placeholder='How you handle leads who tried similar things before and failed'
                rows={4}
                value={persona.objectionHandling.priorFailure}
                onChange={(e) =>
                  updateObjection('priorFailure', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='moneyScript'>Money Objection Script</Label>
              <Textarea
                id='moneyScript'
                placeholder='How you handle money or pricing objections'
                rows={4}
                value={persona.objectionHandling.money}
                onChange={(e) => updateObjection('money', e.target.value)}
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='timeScript'>Time Objection Script</Label>
              <Textarea
                id='timeScript'
                placeholder='How you handle leads who say they are too busy'
                rows={4}
                value={persona.objectionHandling.time}
                onChange={(e) => updateObjection('time', e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Section: Financial Screening Waterfall */}
        <Card>
          <CardHeader>
            <CardTitle>Financial Screening Waterfall</CardTitle>
            <CardDescription>
              Multi-level financial qualification — the AI works through each
              level in order
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            {persona.financialWaterfall.map((step, i) => (
              <div key={i} className='space-y-3 rounded-lg border p-4'>
                <div className='flex items-center justify-between'>
                  <span className='text-sm font-medium'>Level {i + 1}</span>
                  <Button
                    variant='ghost'
                    size='sm'
                    onClick={() => {
                      setPersona((prev) => ({
                        ...prev,
                        financialWaterfall: prev.financialWaterfall.filter(
                          (_, idx) => idx !== i
                        )
                      }));
                    }}
                  >
                    <Trash2 className='h-4 w-4' />
                  </Button>
                </div>
                <div className='grid gap-2'>
                  <Label>Label (e.g. "Capital", "Credit Score")</Label>
                  <Input
                    placeholder='e.g. Capital'
                    value={step.label}
                    onChange={(e) => {
                      const updated = [...persona.financialWaterfall];
                      updated[i] = { ...updated[i], label: e.target.value };
                      setPersona((prev) => ({
                        ...prev,
                        financialWaterfall: updated
                      }));
                    }}
                  />
                </div>
                <div className='grid gap-2'>
                  <Label>Question to ask</Label>
                  <Textarea
                    placeholder='e.g. "How much capital do you have set aside?"'
                    rows={2}
                    value={step.question}
                    onChange={(e) => {
                      const updated = [...persona.financialWaterfall];
                      updated[i] = { ...updated[i], question: e.target.value };
                      setPersona((prev) => ({
                        ...prev,
                        financialWaterfall: updated
                      }));
                    }}
                  />
                </div>
                <div className='grid gap-2'>
                  <Label>Qualifying threshold (optional)</Label>
                  <Input
                    placeholder='e.g. "$5K+ limit"'
                    value={step.threshold}
                    onChange={(e) => {
                      const updated = [...persona.financialWaterfall];
                      updated[i] = { ...updated[i], threshold: e.target.value };
                      setPersona((prev) => ({
                        ...prev,
                        financialWaterfall: updated
                      }));
                    }}
                  />
                </div>
              </div>
            ))}
            <Button
              variant='outline'
              onClick={() => {
                setPersona((prev) => ({
                  ...prev,
                  financialWaterfall: [
                    ...prev.financialWaterfall,
                    {
                      label: '',
                      question: '',
                      threshold: '',
                      passAction: 'proceed to booking'
                    }
                  ]
                }));
              }}
            >
              <Plus className='mr-2 h-4 w-4' />
              Add Waterfall Level
            </Button>
          </CardContent>
        </Card>

        {/* Section: Knowledge Assets & Proof Points */}
        <Card>
          <CardHeader>
            <CardTitle>Knowledge Assets & Proof Points</CardTitle>
            <CardDescription>
              Stories and social proof the AI weaves into conversations
              naturally
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-6'>
            <div>
              <h4 className='mb-3 text-sm font-medium'>
                Knowledge Assets (Origin story, testimonials, etc.)
              </h4>
              {persona.knowledgeAssets.map((asset, i) => (
                <div key={i} className='mb-3 space-y-2 rounded-lg border p-4'>
                  <div className='flex items-center justify-between'>
                    <Input
                      placeholder='Title (e.g. "Founder Origin Story")'
                      value={asset.title}
                      onChange={(e) => {
                        const updated = [...persona.knowledgeAssets];
                        updated[i] = { ...updated[i], title: e.target.value };
                        setPersona((prev) => ({
                          ...prev,
                          knowledgeAssets: updated
                        }));
                      }}
                      className='mr-2 flex-1'
                    />
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => {
                        setPersona((prev) => ({
                          ...prev,
                          knowledgeAssets: prev.knowledgeAssets.filter(
                            (_, idx) => idx !== i
                          )
                        }));
                      }}
                    >
                      <Trash2 className='h-4 w-4' />
                    </Button>
                  </div>
                  <Textarea
                    placeholder='The story/content the AI can draw from...'
                    rows={4}
                    value={asset.content}
                    onChange={(e) => {
                      const updated = [...persona.knowledgeAssets];
                      updated[i] = { ...updated[i], content: e.target.value };
                      setPersona((prev) => ({
                        ...prev,
                        knowledgeAssets: updated
                      }));
                    }}
                  />
                  <Input
                    placeholder='Deploy trigger (e.g. "trust objection", "rapport building")'
                    value={asset.deployTrigger}
                    onChange={(e) => {
                      const updated = [...persona.knowledgeAssets];
                      updated[i] = {
                        ...updated[i],
                        deployTrigger: e.target.value
                      };
                      setPersona((prev) => ({
                        ...prev,
                        knowledgeAssets: updated
                      }));
                    }}
                  />
                </div>
              ))}
              <Button
                variant='outline'
                size='sm'
                onClick={() => {
                  setPersona((prev) => ({
                    ...prev,
                    knowledgeAssets: [
                      ...prev.knowledgeAssets,
                      { title: '', content: '', deployTrigger: '' }
                    ]
                  }));
                }}
              >
                <Plus className='mr-2 h-4 w-4' />
                Add Knowledge Asset
              </Button>
            </div>

            <Separator />

            <div>
              <h4 className='mb-3 text-sm font-medium'>
                Proof Points (Student success stories)
              </h4>
              {persona.proofPoints.map((point, i) => (
                <div key={i} className='mb-3 flex items-start gap-2'>
                  <Input
                    placeholder='Name (e.g. Carlos)'
                    value={point.name}
                    onChange={(e) => {
                      const updated = [...persona.proofPoints];
                      updated[i] = { ...updated[i], name: e.target.value };
                      setPersona((prev) => ({ ...prev, proofPoints: updated }));
                    }}
                    className='w-32'
                  />
                  <Input
                    placeholder='Result (e.g. "Profitable in 30 days")'
                    value={point.result}
                    onChange={(e) => {
                      const updated = [...persona.proofPoints];
                      updated[i] = { ...updated[i], result: e.target.value };
                      setPersona((prev) => ({ ...prev, proofPoints: updated }));
                    }}
                    className='flex-1'
                  />
                  <Input
                    placeholder='When to deploy'
                    value={point.deployContext}
                    onChange={(e) => {
                      const updated = [...persona.proofPoints];
                      updated[i] = {
                        ...updated[i],
                        deployContext: e.target.value
                      };
                      setPersona((prev) => ({ ...prev, proofPoints: updated }));
                    }}
                    className='w-48'
                  />
                  <Button
                    variant='ghost'
                    size='sm'
                    onClick={() => {
                      setPersona((prev) => ({
                        ...prev,
                        proofPoints: prev.proofPoints.filter(
                          (_, idx) => idx !== i
                        )
                      }));
                    }}
                  >
                    <Trash2 className='h-4 w-4' />
                  </Button>
                </div>
              ))}
              <Button
                variant='outline'
                size='sm'
                onClick={() => {
                  setPersona((prev) => ({
                    ...prev,
                    proofPoints: [
                      ...prev.proofPoints,
                      { name: '', result: '', deployContext: '' }
                    ]
                  }));
                }}
              >
                <Plus className='mr-2 h-4 w-4' />
                Add Proof Point
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Section: Stall Handling */}
        <Card>
          <CardHeader>
            <CardTitle>Stall Handling Scripts</CardTitle>
            <CardDescription>
              How the AI handles different types of stalls — each stall type has
              its own protocol
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='grid gap-2'>
              <Label>&ldquo;Text me later / Not a good time&rdquo;</Label>
              <Textarea
                placeholder='How to handle leads who say "not now" — acknowledge, set expectation, follow up early'
                rows={3}
                value={persona.promptConfig.stallTimeScript}
                onChange={(e) =>
                  updatePromptConfig('stallTimeScript', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label>&ldquo;I&apos;ll have money next week&rdquo;</Label>
              <Textarea
                placeholder='How to handle delayed money — probe what changes, lock the date'
                rows={3}
                value={persona.promptConfig.stallMoneyScript}
                onChange={(e) =>
                  updatePromptConfig('stallMoneyScript', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label>&ldquo;Let me think about it&rdquo;</Label>
              <Textarea
                placeholder='How to handle "thinking" — find out what specifically they need to think through'
                rows={3}
                value={persona.promptConfig.stallThinkScript}
                onChange={(e) =>
                  updatePromptConfig('stallThinkScript', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label>&ldquo;I need to talk to my wife / partner&rdquo;</Label>
              <Textarea
                placeholder='How to handle partner consultation — acknowledge, arm them for the conversation'
                rows={3}
                value={persona.promptConfig.stallPartnerScript}
                onChange={(e) =>
                  updatePromptConfig('stallPartnerScript', e.target.value)
                }
              />
            </div>
          </CardContent>
        </Card>

        {/* Section: No-Show & Pre-Call */}
        <Card>
          <CardHeader>
            <CardTitle>No-Show & Pre-Call</CardTitle>
            <CardDescription>
              Handle no-shows and build anticipation before scheduled calls
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-6'>
            <div className='space-y-4'>
              <h4 className='text-sm font-medium'>No-Show Messages</h4>
              <div className='grid gap-2'>
                <Label>First No-Show Message</Label>
                <Textarea
                  placeholder='Warm but direct — extend one reschedule opportunity'
                  rows={3}
                  value={persona.noShowProtocol.firstNoShow}
                  onChange={(e) =>
                    setPersona((prev) => ({
                      ...prev,
                      noShowProtocol: {
                        ...prev.noShowProtocol,
                        firstNoShow: e.target.value
                      }
                    }))
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>Second No-Show Message (Pull Back)</Label>
                <Textarea
                  placeholder='Challenge their commitment — "Is NOW genuinely the time to make a change?"'
                  rows={3}
                  value={persona.noShowProtocol.secondNoShow}
                  onChange={(e) =>
                    setPersona((prev) => ({
                      ...prev,
                      noShowProtocol: {
                        ...prev.noShowProtocol,
                        secondNoShow: e.target.value
                      }
                    }))
                  }
                />
              </div>
            </div>

            <Separator />

            <div className='space-y-4'>
              <h4 className='text-sm font-medium'>
                Pre-Call Reminder Sequence
              </h4>
              {persona.preCallSequence.map((item, i) => (
                <div key={i} className='flex items-start gap-2'>
                  <select
                    className='border-input bg-background h-10 rounded-md border px-3 text-sm'
                    value={item.timing}
                    onChange={(e) => {
                      const updated = [...persona.preCallSequence];
                      updated[i] = { ...updated[i], timing: e.target.value };
                      setPersona((prev) => ({
                        ...prev,
                        preCallSequence: updated
                      }));
                    }}
                  >
                    <option value='night_before'>Night Before</option>
                    <option value='morning_of'>Morning Of</option>
                    <option value='1_hour_before'>1 Hour Before</option>
                    <option value='30_min_before'>30 Min Before</option>
                  </select>
                  <Textarea
                    placeholder='Message to send...'
                    rows={2}
                    value={item.message}
                    onChange={(e) => {
                      const updated = [...persona.preCallSequence];
                      updated[i] = { ...updated[i], message: e.target.value };
                      setPersona((prev) => ({
                        ...prev,
                        preCallSequence: updated
                      }));
                    }}
                    className='flex-1'
                  />
                  <Button
                    variant='ghost'
                    size='sm'
                    onClick={() => {
                      setPersona((prev) => ({
                        ...prev,
                        preCallSequence: prev.preCallSequence.filter(
                          (_, idx) => idx !== i
                        )
                      }));
                    }}
                  >
                    <Trash2 className='h-4 w-4' />
                  </Button>
                </div>
              ))}
              <Button
                variant='outline'
                size='sm'
                onClick={() => {
                  setPersona((prev) => ({
                    ...prev,
                    preCallSequence: [
                      ...prev.preCallSequence,
                      { timing: 'night_before', message: '' }
                    ]
                  }));
                }}
              >
                <Plus className='mr-2 h-4 w-4' />
                Add Reminder
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Section 6: Follow-ups & Rules */}
        <Card>
          <CardHeader>
            <CardTitle>Follow-ups & Rules</CardTitle>
            <CardDescription>
              Automated follow-up sequences and custom instructions
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='grid gap-2'>
              <Label htmlFor='followupDay1'>Day 1 Follow-up (24h)</Label>
              <Textarea
                id='followupDay1'
                placeholder='What to say if the lead goes quiet after 24 hours'
                rows={3}
                value={persona.promptConfig.followupDay1}
                onChange={(e) =>
                  updatePromptConfig('followupDay1', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='followupDay3'>Day 3 Follow-up</Label>
              <Textarea
                id='followupDay3'
                placeholder='Second follow-up after 3 days of no reply'
                rows={3}
                value={persona.promptConfig.followupDay3}
                onChange={(e) =>
                  updatePromptConfig('followupDay3', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='followupDay7'>Day 7 Follow-up (final)</Label>
              <Textarea
                id='followupDay7'
                placeholder='Final follow-up — last attempt before marking ghosted'
                rows={3}
                value={persona.promptConfig.followupDay7}
                onChange={(e) =>
                  updatePromptConfig('followupDay7', e.target.value)
                }
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='customRules'>Custom Rules</Label>
              <Textarea
                id='customRules'
                placeholder='Any additional rules the AI should follow (e.g. never mention competitors, always use first name)'
                rows={4}
                value={persona.promptConfig.customRules}
                onChange={(e) =>
                  updatePromptConfig('customRules', e.target.value)
                }
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Bottom save button for long forms */}
      <div className='flex justify-end'>
        <Button onClick={handleSave} disabled={saving} size='lg'>
          {saving && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
          Save Changes
        </Button>
      </div>
    </div>
  );
}
