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
import { Loader2, Upload, FileText, Sparkles } from 'lucide-react';
import { VoiceProfileDashboard } from '@/features/voice-profile/components/profile-dashboard';

interface PersonaData {
  fullName: string;
  companyName: string;
  freeValueLink: string;
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
    freeValueMessage: string;
    freeValueFollowup: string;
    callPitchMessage: string;
    bookingConfirmationMessage: string;
    followupDay1: string;
    followupDay3: string;
    followupDay7: string;
    customRules: string;
  };
}

const defaultPersona: PersonaData = {
  fullName: '',
  companyName: '',
  freeValueLink: '',
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
    freeValueMessage: '',
    freeValueFollowup: '',
    callPitchMessage: '',
    bookingConfirmationMessage: '',
    followupDay1: '',
    followupDay3: '',
    followupDay7: '',
    customRules: ''
  }
};

export default function PersonaSettingsPage() {
  const [persona, setPersona] = useState<PersonaData>(defaultPersona);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch<{ persona: any }>('/settings/persona');
        const data = res.persona;
        if (data) {
          const pc = data.promptConfig || {};
          const oh = data.objectionHandling || {};
          setPersona({
            fullName: data.fullName ?? '',
            companyName: data.companyName ?? '',
            freeValueLink: data.freeValueLink ?? '',
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
              freeValueMessage: pc.freeValueMessage ?? '',
              freeValueFollowup: pc.freeValueFollowup ?? '',
              callPitchMessage: pc.callPitchMessage ?? '',
              bookingConfirmationMessage: pc.bookingConfirmationMessage ?? '',
              followupDay1: pc.followupDay1 ?? '',
              followupDay3: pc.followupDay3 ?? '',
              followupDay7: pc.followupDay7 ?? '',
              customRules: pc.customRules ?? ''
            }
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
          objectionHandling: persona.objectionHandling,
          promptConfig: persona.promptConfig
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
    setUploadedFileName(file.name);

    try {
      // Read the file content
      let documentText = '';

      if (file.type === 'application/pdf') {
        // For PDFs, we'll read as array buffer and send to the API
        // The API can handle raw text extraction
        toast.info('Reading PDF...');
        const text = await file.text();
        documentText = text;
      } else {
        // For .txt, .md, .doc, .docx — read as text
        documentText = await file.text();
      }

      if (!documentText.trim()) {
        toast.error('Could not read file content. Try a .txt or .md file.');
        return;
      }

      toast.info('AI is analyzing your document...', { duration: 10000 });

      const res = await apiFetch<{ extracted: any }>(
        '/settings/persona/extract',
        {
          method: 'POST',
          body: JSON.stringify({ documentText: documentText.slice(0, 50000) }) // Limit to 50k chars
        }
      );

      const data = res.extracted;
      if (data) {
        setPersona({
          fullName: data.fullName || persona.fullName,
          companyName: data.companyName || persona.companyName,
          freeValueLink: data.freeValueLink || persona.freeValueLink,
          objectionHandling: {
            trust:
              data.objectionHandling?.trust || persona.objectionHandling.trust,
            priorFailure:
              data.objectionHandling?.priorFailure ||
              persona.objectionHandling.priorFailure,
            money:
              data.objectionHandling?.money || persona.objectionHandling.money,
            time: data.objectionHandling?.time || persona.objectionHandling.time
          },
          promptConfig: {
            whatYouSell:
              data.promptConfig?.whatYouSell ||
              persona.promptConfig.whatYouSell,
            adminBio:
              data.promptConfig?.adminBio || persona.promptConfig.adminBio,
            toneDescription:
              data.promptConfig?.toneDescription ||
              persona.promptConfig.toneDescription,
            toneExamplesGood:
              data.promptConfig?.toneExamplesGood ||
              persona.promptConfig.toneExamplesGood,
            toneExamplesBad:
              data.promptConfig?.toneExamplesBad ||
              persona.promptConfig.toneExamplesBad,
            openingMessageStyle:
              data.promptConfig?.openingMessageStyle ||
              persona.promptConfig.openingMessageStyle,
            qualificationQuestions:
              data.promptConfig?.qualificationQuestions ||
              persona.promptConfig.qualificationQuestions,
            disqualificationCriteria:
              data.promptConfig?.disqualificationCriteria ||
              persona.promptConfig.disqualificationCriteria,
            disqualificationMessage:
              data.promptConfig?.disqualificationMessage ||
              persona.promptConfig.disqualificationMessage,
            freeValueMessage:
              data.promptConfig?.freeValueMessage ||
              persona.promptConfig.freeValueMessage,
            freeValueFollowup:
              data.promptConfig?.freeValueFollowup ||
              persona.promptConfig.freeValueFollowup,
            callPitchMessage:
              data.promptConfig?.callPitchMessage ||
              persona.promptConfig.callPitchMessage,
            bookingConfirmationMessage:
              data.promptConfig?.bookingConfirmationMessage ||
              persona.promptConfig.bookingConfirmationMessage,
            followupDay1:
              data.promptConfig?.followupDay1 ||
              persona.promptConfig.followupDay1,
            followupDay3:
              data.promptConfig?.followupDay3 ||
              persona.promptConfig.followupDay3,
            followupDay7:
              data.promptConfig?.followupDay7 ||
              persona.promptConfig.followupDay7,
            customRules:
              data.promptConfig?.customRules || persona.promptConfig.customRules
          }
        });
        toast.success(
          `Persona auto-filled from "${file.name}"! Review the fields and click Save.`
        );
      }
    } catch (err) {
      console.error('Document extraction error:', err);
      toast.error('Failed to extract persona from document');
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
      <Card className='border-2 border-dashed border-blue-200 bg-blue-50/30 dark:border-blue-800 dark:bg-blue-950/20'>
        <CardContent className='flex flex-col items-center gap-4 py-8 sm:flex-row sm:justify-between'>
          <div className='flex items-center gap-3'>
            <div className='flex h-12 w-12 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900'>
              <Sparkles className='h-6 w-6 text-blue-600 dark:text-blue-400' />
            </div>
            <div>
              <h3 className='font-semibold'>Auto-Fill from Document</h3>
              <p className='text-muted-foreground text-sm'>
                Upload your setter playbook, sales script, or brand guide — AI
                will extract everything and fill all fields automatically.
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
                variant='default'
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
