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
  // Response delay range (seconds). The webhook-processor picks a random
  // value between min and max and queues the AI reply for that long
  // before sending. 0/0 = send immediately (legacy behavior).
  responseDelayMin: number;
  responseDelayMax: number;
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
    callHandoff: {
      closerRelation: string;
      closerRole: string;
    };
    // ── NEW SOP-aligned schema (required for v2 master prompt) ──
    // These fields MUST be populated for the AI to run the new
    // 7-stage flow correctly. The legacy fields above are kept for
    // backward compat but the prompt engine prefers these.
    originStory: string;
    openingScripts: {
      inbound: string;
      outbound: string;
      openingQuestion: string;
    };
    // beginnerKeywords / experiencedKeywords are stored as arrays in
    // the database but kept as comma-separated strings in UI state so
    // typing feels natural. The save handler converts string → array
    // and the load handler converts array → string.
    beginnerKeywords: string;
    experiencedKeywords: string;
    pathAScripts: {
      opener: string;
      followUp: string;
      painPoint: string;
      resultsCheck: string;
    };
    pathBScripts: {
      opener: string;
      followUp: string;
      jobContext: string;
      availabilityCheck: string;
    };
    goalEmotionalWhyScripts: {
      incomeGoal: string;
      empathyAnchor: string;
      obstacleQuestion: string;
      surfaceToRealBridge: string;
    };
    emotionalDisclosurePatterns: string;
    urgencyScripts: {
      primary: string;
      followUpIfLow: string;
      followUpIfHigh: string;
    };
    softPitchScripts: {
      beginner: string;
      experienced: string;
    };
    commitmentConfirmationScript: string;
    financialScreeningScripts: {
      level1Capital: string;
      level2Credit: string;
      level3CreditCard: string;
      level4Transition: string;
    };
    lowTicketPitchScripts: string;
    bookingScripts: {
      transition: string;
      proposeTime: string;
      doubleDown: string;
      collectInfo: string;
      confirmBooking: string;
      preCallContent: string;
    };
    incomeFramingRule: string;
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
  // Default to 0/0 = no delay (immediate send). Users can opt in to
  // a delay range from the Response Delay card on this page.
  responseDelayMin: 0,
  responseDelayMax: 0,
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
    customRules: '',
    callHandoff: {
      closerRelation: '',
      closerRole: ''
    },
    // SOP v2 defaults — empty so that validation gates the save
    originStory: '',
    openingScripts: { inbound: '', outbound: '', openingQuestion: '' },
    beginnerKeywords: '',
    experiencedKeywords: '',
    pathAScripts: {
      opener: '',
      followUp: '',
      painPoint: '',
      resultsCheck: ''
    },
    pathBScripts: {
      opener: '',
      followUp: '',
      jobContext: '',
      availabilityCheck: ''
    },
    goalEmotionalWhyScripts: {
      incomeGoal: '',
      empathyAnchor: '',
      obstacleQuestion: '',
      surfaceToRealBridge: ''
    },
    emotionalDisclosurePatterns: '',
    urgencyScripts: { primary: '', followUpIfLow: '', followUpIfHigh: '' },
    softPitchScripts: { beginner: '', experienced: '' },
    commitmentConfirmationScript: '',
    financialScreeningScripts: {
      level1Capital: '',
      level2Credit: '',
      level3CreditCard: '',
      level4Transition: ''
    },
    lowTicketPitchScripts: '',
    bookingScripts: {
      transition: '',
      proposeTime: '',
      doubleDown: '',
      collectInfo: '',
      confirmBooking: '',
      preCallContent: ''
    },
    incomeFramingRule: ''
  },
  financialWaterfall: [],
  knowledgeAssets: [],
  proofPoints: [],
  noShowProtocol: { firstNoShow: '', secondNoShow: '' },
  preCallSequence: []
};

// ─────────────────────────────────────────────────────────────────────
// Helpers for the SOP v2 fields (keywords ↔ array conversion + safe
// nested object hydration). These live at module scope so the load and
// save handlers can share them.
// ─────────────────────────────────────────────────────────────────────

function keywordsToString(v: unknown): string {
  if (Array.isArray(v)) return v.filter(Boolean).join(', ');
  if (typeof v === 'string') return v;
  return '';
}

function keywordsToArray(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

// Human-readable formatter for the response-delay inputs.
//   30   → "30s"
//   60   → "1 min"
//   90   → "1 min 30s"
//   125  → "2 min 5s"
// We use floor for the minutes component so 30s never reads as "1 min 30s".
function formatDelaySeconds(seconds: number): string {
  if (seconds <= 0) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${min} min` : `${min} min ${rem}s`;
}

// Hydrate a SOP nested object — if the stored value is an object,
// merge known keys; if it's a plain string (the old fallback the prompt
// engine accepts), drop it into the FIRST sub-field so the user can
// see and edit it without losing data.
function hydrateNested<K extends string>(
  raw: unknown,
  keys: readonly K[],
  primaryKey: K
): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const k of keys) out[k] = '';
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string') out[k] = v;
      else if (v != null) out[k] = JSON.stringify(v);
    }
  } else if (typeof raw === 'string' && raw.trim()) {
    out[primaryKey] = raw;
  }
  return out;
}

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
            responseDelayMin:
              typeof data.responseDelayMin === 'number'
                ? data.responseDelayMin
                : 0,
            responseDelayMax:
              typeof data.responseDelayMax === 'number'
                ? data.responseDelayMax
                : 0,
            objectionHandling: {
              trust: oh.trust ?? '',
              priorFailure: oh.priorFailure ?? '',
              money: oh.money ?? '',
              time: oh.time ?? ''
            },
            // Spread `pc` first so any unknown extra keys stored in the DB
            // survive the load round-trip. Then explicitly hydrate every UI
            // field so inputs are never undefined and the SOP nested objects
            // always have all their sub-keys present.
            promptConfig: {
              ...pc,
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
              customRules: pc.customRules ?? '',
              callHandoff: {
                closerRelation: pc.callHandoff?.closerRelation ?? '',
                closerRole: pc.callHandoff?.closerRole ?? ''
              },
              // SOP v2 hydration
              originStory: pc.originStory ?? '',
              openingScripts: hydrateNested(
                pc.openingScripts,
                ['inbound', 'outbound', 'openingQuestion'] as const,
                'inbound'
              ),
              beginnerKeywords: keywordsToString(pc.beginnerKeywords),
              experiencedKeywords: keywordsToString(pc.experiencedKeywords),
              pathAScripts: hydrateNested(
                pc.pathAScripts,
                ['opener', 'followUp', 'painPoint', 'resultsCheck'] as const,
                'opener'
              ),
              pathBScripts: hydrateNested(
                pc.pathBScripts,
                [
                  'opener',
                  'followUp',
                  'jobContext',
                  'availabilityCheck'
                ] as const,
                'opener'
              ),
              goalEmotionalWhyScripts: hydrateNested(
                pc.goalEmotionalWhyScripts,
                [
                  'incomeGoal',
                  'empathyAnchor',
                  'obstacleQuestion',
                  'surfaceToRealBridge'
                ] as const,
                'incomeGoal'
              ),
              emotionalDisclosurePatterns:
                typeof pc.emotionalDisclosurePatterns === 'string'
                  ? pc.emotionalDisclosurePatterns
                  : pc.emotionalDisclosurePatterns
                    ? JSON.stringify(pc.emotionalDisclosurePatterns, null, 2)
                    : '',
              urgencyScripts: hydrateNested(
                pc.urgencyScripts,
                ['primary', 'followUpIfLow', 'followUpIfHigh'] as const,
                'primary'
              ),
              softPitchScripts: hydrateNested(
                pc.softPitchScripts,
                ['beginner', 'experienced'] as const,
                'beginner'
              ),
              commitmentConfirmationScript:
                pc.commitmentConfirmationScript ?? '',
              financialScreeningScripts: hydrateNested(
                pc.financialScreeningScripts,
                [
                  'level1Capital',
                  'level2Credit',
                  'level3CreditCard',
                  'level4Transition'
                ] as const,
                'level1Capital'
              ),
              lowTicketPitchScripts:
                typeof pc.lowTicketPitchScripts === 'string'
                  ? pc.lowTicketPitchScripts
                  : pc.lowTicketPitchScripts
                    ? JSON.stringify(pc.lowTicketPitchScripts, null, 2)
                    : '',
              bookingScripts: hydrateNested(
                pc.bookingScripts,
                [
                  'transition',
                  'proposeTime',
                  'doubleDown',
                  'collectInfo',
                  'confirmBooking',
                  'preCallContent'
                ] as const,
                'transition'
              ),
              incomeFramingRule: pc.incomeFramingRule ?? ''
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
      } catch (err) {
        // Log so we can actually see load failures in the console instead
        // of silently falling back to defaults (which looks like "everything
        // disappeared" to the user).
        console.error('[persona] Failed to load persona:', err);
        toast.error(
          err instanceof Error
            ? `Failed to load persona: ${err.message}`
            : 'Failed to load persona'
        );
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

  function updateCallHandoff(
    field: keyof PersonaData['promptConfig']['callHandoff'],
    value: string
  ) {
    setPersona((prev) => ({
      ...prev,
      promptConfig: {
        ...prev.promptConfig,
        callHandoff: { ...prev.promptConfig.callHandoff, [field]: value }
      }
    }));
  }

  // Generic helper for the SOP nested-object fields (openingScripts,
  // pathAScripts, bookingScripts, etc.). Avoids writing one bespoke
  // updater per object.
  function updateNested<
    K extends
      | 'openingScripts'
      | 'pathAScripts'
      | 'pathBScripts'
      | 'goalEmotionalWhyScripts'
      | 'urgencyScripts'
      | 'softPitchScripts'
      | 'financialScreeningScripts'
      | 'bookingScripts'
  >(field: K, subField: string, value: string) {
    setPersona((prev) => ({
      ...prev,
      promptConfig: {
        ...prev.promptConfig,
        [field]: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...((prev.promptConfig[field] as any) || {}),
          [subField]: value
        }
      }
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

  // Validates that every SOP v2 required field is populated.
  // Returns a list of missing field labels — empty list = OK to save.
  function getMissingRequired(): string[] {
    const missing: string[] = [];
    const pc = persona.promptConfig;

    if (!persona.fullName.trim()) missing.push('Your Full Name');

    // Stage 1 — Opening
    if (!pc.openingScripts.inbound.trim())
      missing.push('Opening: Inbound opener');
    if (!pc.openingScripts.outbound.trim())
      missing.push('Opening: Outbound opener');
    if (!pc.openingScripts.openingQuestion.trim())
      missing.push('Opening: Opening question');

    // Stage 2 — Experience branching
    if (!pc.beginnerKeywords.trim())
      missing.push('Experience: Beginner keywords');
    if (!pc.experiencedKeywords.trim())
      missing.push('Experience: Experienced keywords');
    if (!pc.pathAScripts.opener.trim())
      missing.push('Path A (Experienced): Opener');
    if (!pc.pathAScripts.followUp.trim())
      missing.push('Path A (Experienced): Follow-up');
    if (!pc.pathAScripts.painPoint.trim())
      missing.push('Path A (Experienced): Pain point');
    if (!pc.pathBScripts.opener.trim())
      missing.push('Path B (Beginner): Opener');
    if (!pc.pathBScripts.followUp.trim())
      missing.push('Path B (Beginner): Follow-up');

    // Stage 3 — Goal & emotional why
    if (!pc.goalEmotionalWhyScripts.incomeGoal.trim())
      missing.push('Goal & Why: Income goal question');
    if (!pc.goalEmotionalWhyScripts.empathyAnchor.trim())
      missing.push('Goal & Why: Empathy anchor');
    if (!pc.goalEmotionalWhyScripts.obstacleQuestion.trim())
      missing.push('Goal & Why: Obstacle question');

    // Stage 4 — Urgency (mandatory)
    if (!pc.urgencyScripts.primary.trim())
      missing.push('Urgency: Primary question');

    // Stage 5 — Soft pitch + commitment
    if (!pc.softPitchScripts.beginner.trim())
      missing.push('Soft Pitch: Beginner');
    if (!pc.softPitchScripts.experienced.trim())
      missing.push('Soft Pitch: Experienced');
    if (!pc.commitmentConfirmationScript.trim())
      missing.push('Commitment Confirmation Script');

    // Stage 6 — Financial screening waterfall
    if (!pc.financialScreeningScripts.level1Capital.trim())
      missing.push('Financial: Level 1 (Capital)');
    if (!pc.financialScreeningScripts.level2Credit.trim())
      missing.push('Financial: Level 2 (Credit Score)');
    if (!pc.financialScreeningScripts.level3CreditCard.trim())
      missing.push('Financial: Level 3 (Credit Card)');
    if (!pc.financialScreeningScripts.level4Transition.trim())
      missing.push('Financial: Level 4 (Low-ticket Transition)');

    // Stage 7 — Booking
    if (!pc.bookingScripts.transition.trim())
      missing.push('Booking: Transition');
    if (!pc.bookingScripts.proposeTime.trim())
      missing.push('Booking: Propose time');
    if (!pc.bookingScripts.doubleDown.trim())
      missing.push('Booking: Double down');
    if (!pc.bookingScripts.collectInfo.trim())
      missing.push('Booking: Collect info');
    if (!pc.bookingScripts.confirmBooking.trim())
      missing.push('Booking: Confirm booking');

    return missing;
  }

  async function handleSave() {
    // ── Required-field validation (SOP v2) ──────────────────────────
    const missing = getMissingRequired();
    if (missing.length > 0) {
      const preview = missing.slice(0, 6).join(', ');
      const more = missing.length > 6 ? ` (+${missing.length - 6} more)` : '';
      toast.error(
        `Missing required fields: ${preview}${more}. Scroll to the SOP Sales Flow card or upload your playbook to auto-fill.`
      );
      return;
    }

    // ── Response delay sanity check ─────────────────────────────────
    // We let the inputs accept anything during typing, so guard against
    // min > max here. If max is 0 we treat the whole feature as off and
    // skip the check (min is also effectively ignored downstream).
    if (
      persona.responseDelayMax > 0 &&
      persona.responseDelayMin > persona.responseDelayMax
    ) {
      toast.error(
        `Minimum delay (${persona.responseDelayMin}s) cannot exceed maximum delay (${persona.responseDelayMax}s).`
      );
      return;
    }

    setSaving(true);
    try {
      // Build the promptConfig payload — convert keyword strings back
      // to arrays so the AI engine can use them as-is.
      const promptConfigPayload = {
        ...persona.promptConfig,
        beginnerKeywords: keywordsToArray(
          persona.promptConfig.beginnerKeywords
        ),
        experiencedKeywords: keywordsToArray(
          persona.promptConfig.experiencedKeywords
        )
      };

      await apiFetch('/settings/persona', {
        method: 'PUT',
        body: JSON.stringify({
          personaName: persona.fullName || 'Default Persona',
          fullName: persona.fullName,
          companyName: persona.companyName,
          systemPrompt: 'MASTER_TEMPLATE',
          freeValueLink: persona.freeValueLink,
          closerName: persona.closerName,
          responseDelayMin: persona.responseDelayMin,
          responseDelayMax: persona.responseDelayMax,
          objectionHandling: persona.objectionHandling,
          promptConfig: promptConfigPayload,
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
    } catch (err) {
      console.error('[persona] Failed to save persona:', err);
      toast.error(
        err instanceof Error
          ? `Failed to save: ${err.message}`
          : 'Failed to save'
      );
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
          // Document extraction never sets the response delay — preserve
          // whatever the user had configured before the upload.
          responseDelayMin: prev.responseDelayMin,
          responseDelayMax: prev.responseDelayMax,
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
          // Spread-merge promptConfig: first preserve prev, then overlay extracted.
          // Legacy flat fields fall back to prev. The SOP v2 nested objects use
          // hydrateNested so any partial extractor output keeps the rest of
          // prev intact (never blanking a sub-field the user already filled).
          promptConfig: {
            ...prev.promptConfig,
            ...epc,
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
            customRules: epc.customRules || prev.promptConfig.customRules,
            callHandoff: {
              closerRelation:
                epc.callHandoff?.closerRelation ||
                prev.promptConfig.callHandoff.closerRelation,
              closerRole:
                epc.callHandoff?.closerRole ||
                prev.promptConfig.callHandoff.closerRole
            },
            // ── SOP v2 hydration ────────────────────────────────────
            originStory: epc.originStory || prev.promptConfig.originStory,
            openingScripts: {
              ...prev.promptConfig.openingScripts,
              ...hydrateNested(
                epc.openingScripts,
                ['inbound', 'outbound', 'openingQuestion'] as const,
                'inbound'
              )
            },
            beginnerKeywords:
              keywordsToString(epc.beginnerKeywords) ||
              prev.promptConfig.beginnerKeywords,
            experiencedKeywords:
              keywordsToString(epc.experiencedKeywords) ||
              prev.promptConfig.experiencedKeywords,
            pathAScripts: {
              ...prev.promptConfig.pathAScripts,
              ...hydrateNested(
                epc.pathAScripts,
                ['opener', 'followUp', 'painPoint', 'resultsCheck'] as const,
                'opener'
              )
            },
            pathBScripts: {
              ...prev.promptConfig.pathBScripts,
              ...hydrateNested(
                epc.pathBScripts,
                [
                  'opener',
                  'followUp',
                  'jobContext',
                  'availabilityCheck'
                ] as const,
                'opener'
              )
            },
            goalEmotionalWhyScripts: {
              ...prev.promptConfig.goalEmotionalWhyScripts,
              ...hydrateNested(
                epc.goalEmotionalWhyScripts,
                [
                  'incomeGoal',
                  'empathyAnchor',
                  'obstacleQuestion',
                  'surfaceToRealBridge'
                ] as const,
                'incomeGoal'
              )
            },
            emotionalDisclosurePatterns:
              (typeof epc.emotionalDisclosurePatterns === 'string'
                ? epc.emotionalDisclosurePatterns
                : epc.emotionalDisclosurePatterns
                  ? JSON.stringify(epc.emotionalDisclosurePatterns, null, 2)
                  : '') || prev.promptConfig.emotionalDisclosurePatterns,
            urgencyScripts: {
              ...prev.promptConfig.urgencyScripts,
              ...hydrateNested(
                epc.urgencyScripts,
                ['primary', 'followUpIfLow', 'followUpIfHigh'] as const,
                'primary'
              )
            },
            softPitchScripts: {
              ...prev.promptConfig.softPitchScripts,
              ...hydrateNested(
                epc.softPitchScripts,
                ['beginner', 'experienced'] as const,
                'beginner'
              )
            },
            commitmentConfirmationScript:
              epc.commitmentConfirmationScript ||
              epc.softPitchScripts?.commitmentConfirmation ||
              prev.promptConfig.commitmentConfirmationScript,
            financialScreeningScripts: {
              ...prev.promptConfig.financialScreeningScripts,
              ...hydrateNested(
                epc.financialScreeningScripts,
                [
                  'level1Capital',
                  'level2Credit',
                  'level3CreditCard',
                  'level4Transition'
                ] as const,
                'level1Capital'
              )
            },
            lowTicketPitchScripts:
              (typeof epc.lowTicketPitchScripts === 'string'
                ? epc.lowTicketPitchScripts
                : epc.lowTicketPitchScripts
                  ? JSON.stringify(epc.lowTicketPitchScripts, null, 2)
                  : '') || prev.promptConfig.lowTicketPitchScripts,
            bookingScripts: {
              ...prev.promptConfig.bookingScripts,
              ...hydrateNested(
                epc.bookingScripts,
                [
                  'transition',
                  'proposeTime',
                  'doubleDown',
                  'collectInfo',
                  'confirmBooking',
                  'preCallContent'
                ] as const,
                'transition'
              )
            },
            incomeFramingRule:
              epc.incomeFramingRule || prev.promptConfig.incomeFramingRule
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

        {/* Section: Response Delay (humanizes AI replies) */}
        <Card>
          <CardHeader>
            <CardTitle>Response Delay</CardTitle>
            <CardDescription>
              How long the AI waits before replying. The actual delay is picked
              at random between the min and max so replies feel natural instead
              of robotic. Set both to 0 to send immediately.
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='grid gap-2'>
                <Label htmlFor='responseDelayMin'>
                  Minimum delay (seconds)
                </Label>
                <Input
                  id='responseDelayMin'
                  type='number'
                  min={0}
                  max={1800}
                  step={15}
                  value={persona.responseDelayMin}
                  onChange={(e) => {
                    // Only mutate the field the user is typing in. Auto-
                    // bumping the other field on every keystroke makes the
                    // inputs feel "linked" and prevents the user from typing
                    // values like min=30, max=60 (the first keystroke would
                    // bump max to 30 and overwrite their intended value).
                    // We validate min <= max once on save, not on input.
                    const v = Math.max(
                      0,
                      Math.min(1800, parseInt(e.target.value || '0', 10))
                    );
                    setPersona((prev) => ({ ...prev, responseDelayMin: v }));
                  }}
                />
                <p className='text-muted-foreground text-xs'>
                  {persona.responseDelayMin === 0
                    ? 'No minimum delay'
                    : `~${formatDelaySeconds(persona.responseDelayMin)}`}
                </p>
              </div>
              <div className='grid gap-2'>
                <Label htmlFor='responseDelayMax'>
                  Maximum delay (seconds)
                </Label>
                <Input
                  id='responseDelayMax'
                  type='number'
                  min={0}
                  max={1800}
                  step={15}
                  value={persona.responseDelayMax}
                  onChange={(e) => {
                    const v = Math.max(
                      0,
                      Math.min(1800, parseInt(e.target.value || '0', 10))
                    );
                    setPersona((prev) => ({ ...prev, responseDelayMax: v }));
                  }}
                />
                <p className='text-muted-foreground text-xs'>
                  {persona.responseDelayMax === 0
                    ? 'No maximum delay'
                    : `~${formatDelaySeconds(persona.responseDelayMax)}`}
                </p>
              </div>
            </div>
            {persona.responseDelayMin > persona.responseDelayMax &&
              persona.responseDelayMax > 0 && (
                <div className='rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'>
                  Minimum delay ({persona.responseDelayMin}s) is greater than
                  maximum delay ({persona.responseDelayMax}s). The save will be
                  blocked until you fix this.
                </div>
              )}
            <div className='bg-muted/40 text-muted-foreground rounded-md border p-3 text-xs'>
              <strong className='text-foreground'>How it works:</strong> When a
              lead messages you, the AI generates the reply at delivery time
              (not trigger time), so if the lead sends another message during
              the delay window, the reply will incorporate it. The
              &quot;september 2002&quot; test trigger always bypasses the delay
              so you can iterate fast. Maximum allowed: 1800 seconds (30
              minutes).
            </div>
          </CardContent>
        </Card>

        {/* Section: SOP Sales Flow Scripts (REQUIRED for v2 prompt) */}
        <Card className='border-amber-300 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-950/20'>
          <CardHeader>
            <CardTitle>
              SOP Sales Flow Scripts <span className='text-destructive'>*</span>
            </CardTitle>
            <CardDescription>
              The structured 7-stage flow the AI runs end-to-end. Every field
              marked with <span className='text-destructive'>*</span> is
              required — the save will be blocked until they&apos;re filled.
              Tip: upload your sales playbook above and the AI will auto-fill
              everything in this card.
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-8'>
            {/* Stage 1: Opening */}
            <div className='space-y-4'>
              <h4 className='border-b pb-1 text-sm font-semibold'>
                Stage 1: Opening
              </h4>
              <div className='grid gap-2'>
                <Label>
                  Inbound opener <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder='What you say when a lead messages you first'
                  value={persona.promptConfig.openingScripts.inbound}
                  onChange={(e) =>
                    updateNested('openingScripts', 'inbound', e.target.value)
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Outbound opener <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder='What you say when you DM a lead first'
                  value={persona.promptConfig.openingScripts.outbound}
                  onChange={(e) =>
                    updateNested('openingScripts', 'outbound', e.target.value)
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Opening question <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder='The question that gets the lead talking and triggers experience-level branching'
                  value={persona.promptConfig.openingScripts.openingQuestion}
                  onChange={(e) =>
                    updateNested(
                      'openingScripts',
                      'openingQuestion',
                      e.target.value
                    )
                  }
                />
              </div>
            </div>

            <Separator />

            {/* Stage 2: Experience Branching */}
            <div className='space-y-4'>
              <h4 className='border-b pb-1 text-sm font-semibold'>
                Stage 2: Experience-Level Branching
              </h4>
              <div className='grid gap-2'>
                <Label>
                  Beginner keywords <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder='Comma-separated list, e.g. just starting, never traded, complete beginner, just curious'
                  value={persona.promptConfig.beginnerKeywords}
                  onChange={(e) =>
                    updatePromptConfig('beginnerKeywords', e.target.value)
                  }
                />
                <p className='text-muted-foreground text-xs'>
                  When a lead uses any of these phrases, the AI routes them to
                  Path B (Beginner).
                </p>
              </div>
              <div className='grid gap-2'>
                <Label>
                  Experienced keywords{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder='Comma-separated list, e.g. been trading, years, prop firm, my strategy, my setups'
                  value={persona.promptConfig.experiencedKeywords}
                  onChange={(e) =>
                    updatePromptConfig('experiencedKeywords', e.target.value)
                  }
                />
                <p className='text-muted-foreground text-xs'>
                  When a lead uses any of these phrases, the AI routes them to
                  Path A (Experienced).
                </p>
              </div>

              <div className='bg-background/50 space-y-3 rounded-md border p-3'>
                <h5 className='text-muted-foreground text-xs font-semibold uppercase'>
                  Path A: Experienced Lead
                </h5>
                <div className='grid gap-2'>
                  <Label>
                    Opener <span className='text-destructive'>*</span>
                  </Label>
                  <Textarea
                    rows={2}
                    placeholder='Your first response to an experienced lead after they reveal their experience level'
                    value={persona.promptConfig.pathAScripts.opener}
                    onChange={(e) =>
                      updateNested('pathAScripts', 'opener', e.target.value)
                    }
                  />
                </div>
                <div className='grid gap-2'>
                  <Label>
                    Follow-up question{' '}
                    <span className='text-destructive'>*</span>
                  </Label>
                  <Textarea
                    rows={2}
                    placeholder='Discovery question to dig into their current setup'
                    value={persona.promptConfig.pathAScripts.followUp}
                    onChange={(e) =>
                      updateNested('pathAScripts', 'followUp', e.target.value)
                    }
                  />
                </div>
                <div className='grid gap-2'>
                  <Label>
                    Pain point question{' '}
                    <span className='text-destructive'>*</span>
                  </Label>
                  <Textarea
                    rows={2}
                    placeholder="Question that surfaces what's currently NOT working for them"
                    value={persona.promptConfig.pathAScripts.painPoint}
                    onChange={(e) =>
                      updateNested('pathAScripts', 'painPoint', e.target.value)
                    }
                  />
                </div>
                <div className='grid gap-2'>
                  <Label>
                    Results check{' '}
                    <span className='text-muted-foreground text-xs font-normal'>
                      (optional)
                    </span>
                  </Label>
                  <Textarea
                    rows={2}
                    placeholder='Question that validates how their current results actually look'
                    value={persona.promptConfig.pathAScripts.resultsCheck}
                    onChange={(e) =>
                      updateNested(
                        'pathAScripts',
                        'resultsCheck',
                        e.target.value
                      )
                    }
                  />
                </div>
              </div>

              <div className='bg-background/50 space-y-3 rounded-md border p-3'>
                <h5 className='text-muted-foreground text-xs font-semibold uppercase'>
                  Path B: Beginner Lead
                </h5>
                <div className='grid gap-2'>
                  <Label>
                    Opener <span className='text-destructive'>*</span>
                  </Label>
                  <Textarea
                    rows={2}
                    placeholder='Your first response to a beginner lead — encouraging and curious, never condescending'
                    value={persona.promptConfig.pathBScripts.opener}
                    onChange={(e) =>
                      updateNested('pathBScripts', 'opener', e.target.value)
                    }
                  />
                </div>
                <div className='grid gap-2'>
                  <Label>
                    Follow-up question{' '}
                    <span className='text-destructive'>*</span>
                  </Label>
                  <Textarea
                    rows={2}
                    placeholder='Discovery question — what got them interested, what they have tried'
                    value={persona.promptConfig.pathBScripts.followUp}
                    onChange={(e) =>
                      updateNested('pathBScripts', 'followUp', e.target.value)
                    }
                  />
                </div>
                <div className='grid gap-2'>
                  <Label>
                    Job context question{' '}
                    <span className='text-muted-foreground text-xs font-normal'>
                      (optional)
                    </span>
                  </Label>
                  <Textarea
                    rows={2}
                    placeholder='Question about their current job/income situation'
                    value={persona.promptConfig.pathBScripts.jobContext}
                    onChange={(e) =>
                      updateNested('pathBScripts', 'jobContext', e.target.value)
                    }
                  />
                </div>
                <div className='grid gap-2'>
                  <Label>
                    Availability check{' '}
                    <span className='text-muted-foreground text-xs font-normal'>
                      (optional)
                    </span>
                  </Label>
                  <Textarea
                    rows={2}
                    placeholder='Question about how much time they can commit'
                    value={persona.promptConfig.pathBScripts.availabilityCheck}
                    onChange={(e) =>
                      updateNested(
                        'pathBScripts',
                        'availabilityCheck',
                        e.target.value
                      )
                    }
                  />
                </div>
              </div>
            </div>

            <Separator />

            {/* Stage 3: Goal & Emotional Why */}
            <div className='space-y-4'>
              <h4 className='border-b pb-1 text-sm font-semibold'>
                Stage 3: Goal & Emotional Why
              </h4>
              <div className='grid gap-2'>
                <Label>
                  Income goal question{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder='Question that surfaces the income/result they want'
                  value={
                    persona.promptConfig.goalEmotionalWhyScripts.incomeGoal
                  }
                  onChange={(e) =>
                    updateNested(
                      'goalEmotionalWhyScripts',
                      'incomeGoal',
                      e.target.value
                    )
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Empathy anchor line{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder='The empathy line attached to the income question (e.g. "asking since I used to work jobs similar to that")'
                  value={
                    persona.promptConfig.goalEmotionalWhyScripts.empathyAnchor
                  }
                  onChange={(e) =>
                    updateNested(
                      'goalEmotionalWhyScripts',
                      'empathyAnchor',
                      e.target.value
                    )
                  }
                />
                <p className='text-muted-foreground text-xs'>
                  Bug 04 fix: this line MUST follow the income question every
                  time so the lead doesn&apos;t feel judged.
                </p>
              </div>
              <div className='grid gap-2'>
                <Label>
                  Obstacle question <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder="Question that uncovers what's stopping them from hitting their goal"
                  value={
                    persona.promptConfig.goalEmotionalWhyScripts
                      .obstacleQuestion
                  }
                  onChange={(e) =>
                    updateNested(
                      'goalEmotionalWhyScripts',
                      'obstacleQuestion',
                      e.target.value
                    )
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Surface-to-real bridge{' '}
                  <span className='text-muted-foreground text-xs font-normal'>
                    (optional)
                  </span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder='Bridge from surface answer to deeper why (family, freedom, etc.)'
                  value={
                    persona.promptConfig.goalEmotionalWhyScripts
                      .surfaceToRealBridge
                  }
                  onChange={(e) =>
                    updateNested(
                      'goalEmotionalWhyScripts',
                      'surfaceToRealBridge',
                      e.target.value
                    )
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Emotional disclosure response patterns{' '}
                  <span className='text-muted-foreground text-xs font-normal'>
                    (optional)
                  </span>
                </Label>
                <Textarea
                  rows={4}
                  placeholder='How to acknowledge deep personal disclosures (absent parent, financial stress, etc.). Reference specific details — never generic.'
                  value={persona.promptConfig.emotionalDisclosurePatterns}
                  onChange={(e) =>
                    updatePromptConfig(
                      'emotionalDisclosurePatterns',
                      e.target.value
                    )
                  }
                />
              </div>
            </div>

            <Separator />

            {/* Stage 4: Urgency */}
            <div className='space-y-4'>
              <h4 className='border-b pb-1 text-sm font-semibold'>
                Stage 4: Urgency (mandatory)
              </h4>
              <div className='grid gap-2'>
                <Label>
                  Primary urgency question{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={3}
                  placeholder='e.g. "scale of 1-10, how bad do you actually want this? if nothing changes in 12 months — are you good with that?"'
                  value={persona.promptConfig.urgencyScripts.primary}
                  onChange={(e) =>
                    updateNested('urgencyScripts', 'primary', e.target.value)
                  }
                />
                <p className='text-muted-foreground text-xs'>
                  Cannot be skipped. Fires before every soft pitch.
                </p>
              </div>
              <div className='grid gap-2'>
                <Label>
                  Follow-up if urgency is LOW{' '}
                  <span className='text-muted-foreground text-xs font-normal'>
                    (optional)
                  </span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder='What to say if they answer 1-5 — try to surface a bigger emotional driver'
                  value={persona.promptConfig.urgencyScripts.followUpIfLow}
                  onChange={(e) =>
                    updateNested(
                      'urgencyScripts',
                      'followUpIfLow',
                      e.target.value
                    )
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Follow-up if urgency is HIGH{' '}
                  <span className='text-muted-foreground text-xs font-normal'>
                    (optional)
                  </span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder='What to say if they answer 8-10 — validate and proceed to soft pitch'
                  value={persona.promptConfig.urgencyScripts.followUpIfHigh}
                  onChange={(e) =>
                    updateNested(
                      'urgencyScripts',
                      'followUpIfHigh',
                      e.target.value
                    )
                  }
                />
              </div>
            </div>

            <Separator />

            {/* Stage 5: Soft Pitch + Commitment */}
            <div className='space-y-4'>
              <h4 className='border-b pb-1 text-sm font-semibold'>
                Stage 5: Soft Pitch & Commitment Confirmation
              </h4>
              <div className='grid gap-2'>
                <Label>
                  Soft pitch — beginner version{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={4}
                  placeholder='How you pitch the call/program to a beginner lead — soft, no hard close'
                  value={persona.promptConfig.softPitchScripts.beginner}
                  onChange={(e) =>
                    updateNested('softPitchScripts', 'beginner', e.target.value)
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Soft pitch — experienced version{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={4}
                  placeholder='How you pitch the call/program to an experienced lead — focus on what they are missing'
                  value={persona.promptConfig.softPitchScripts.experienced}
                  onChange={(e) =>
                    updateNested(
                      'softPitchScripts',
                      'experienced',
                      e.target.value
                    )
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Commitment confirmation script{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={3}
                  placeholder='What you say AFTER they react positively to the soft pitch — locks in commitment before financial screening'
                  value={persona.promptConfig.commitmentConfirmationScript}
                  onChange={(e) =>
                    updatePromptConfig(
                      'commitmentConfirmationScript',
                      e.target.value
                    )
                  }
                />
                <p className='text-muted-foreground text-xs'>
                  Bug 01 fix: positive responses to the soft pitch route HERE,
                  not to a soft exit.
                </p>
              </div>
            </div>

            <Separator />

            {/* Stage 6: Financial Screening */}
            <div className='space-y-4'>
              <h4 className='border-b pb-1 text-sm font-semibold'>
                Stage 6: Financial Screening Waterfall
              </h4>
              <p className='text-muted-foreground text-xs'>
                4 levels in order. The AI moves to the next level only if the
                current one fails. Even Level 4 fail = soft exit.
              </p>
              <div className='grid gap-2'>
                <Label>
                  Level 1 — Liquid capital{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={3}
                  placeholder='Question + framing for liquid capital availability'
                  value={
                    persona.promptConfig.financialScreeningScripts.level1Capital
                  }
                  onChange={(e) =>
                    updateNested(
                      'financialScreeningScripts',
                      'level1Capital',
                      e.target.value
                    )
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Level 2 — Credit score{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={3}
                  placeholder='Question + framing for credit score (fires if Level 1 fails)'
                  value={
                    persona.promptConfig.financialScreeningScripts.level2Credit
                  }
                  onChange={(e) =>
                    updateNested(
                      'financialScreeningScripts',
                      'level2Credit',
                      e.target.value
                    )
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Level 3 — Credit card limit{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={3}
                  placeholder='Question + framing for credit card availability (fires if Level 2 fails)'
                  value={
                    persona.promptConfig.financialScreeningScripts
                      .level3CreditCard
                  }
                  onChange={(e) =>
                    updateNested(
                      'financialScreeningScripts',
                      'level3CreditCard',
                      e.target.value
                    )
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Level 4 — Low-ticket transition{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={3}
                  placeholder='How you transition into the low-ticket pitch (fires if Level 3 fails)'
                  value={
                    persona.promptConfig.financialScreeningScripts
                      .level4Transition
                  }
                  onChange={(e) =>
                    updateNested(
                      'financialScreeningScripts',
                      'level4Transition',
                      e.target.value
                    )
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Low-ticket pitch sequence{' '}
                  <span className='text-muted-foreground text-xs font-normal'>
                    (optional)
                  </span>
                </Label>
                <Textarea
                  rows={4}
                  placeholder='The full multi-message sequence for pitching your low-ticket offer (e.g. $497 course)'
                  value={persona.promptConfig.lowTicketPitchScripts}
                  onChange={(e) =>
                    updatePromptConfig('lowTicketPitchScripts', e.target.value)
                  }
                />
              </div>
            </div>

            <Separator />

            {/* Stage 7: Booking */}
            <div className='space-y-4'>
              <h4 className='border-b pb-1 text-sm font-semibold'>
                Stage 7: Booking Flow
              </h4>
              <p className='text-muted-foreground text-xs'>
                The booking link / available slots come from your calendar
                integration (Settings → Integrations). Don&apos;t paste any URLs
                into these scripts — the AI fills them in automatically.
              </p>
              <div className='grid gap-2'>
                <Label>
                  Transition into booking{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder='How you move from financial screening pass into booking the call'
                  value={persona.promptConfig.bookingScripts.transition}
                  onChange={(e) =>
                    updateNested('bookingScripts', 'transition', e.target.value)
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Propose times script{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder='How you offer specific calendar slots — the AI will inject real times here'
                  value={persona.promptConfig.bookingScripts.proposeTime}
                  onChange={(e) =>
                    updateNested(
                      'bookingScripts',
                      'proposeTime',
                      e.target.value
                    )
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Double-down script <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={3}
                  placeholder='What you say if they hesitate after seeing the times — reinforce why this matters'
                  value={persona.promptConfig.bookingScripts.doubleDown}
                  onChange={(e) =>
                    updateNested('bookingScripts', 'doubleDown', e.target.value)
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Collect-info script{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder='What you ask for after they pick a time (name, email, phone)'
                  value={persona.promptConfig.bookingScripts.collectInfo}
                  onChange={(e) =>
                    updateNested(
                      'bookingScripts',
                      'collectInfo',
                      e.target.value
                    )
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Confirm booking script{' '}
                  <span className='text-destructive'>*</span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder='Confirmation message after the appointment is created'
                  value={persona.promptConfig.bookingScripts.confirmBooking}
                  onChange={(e) =>
                    updateNested(
                      'bookingScripts',
                      'confirmBooking',
                      e.target.value
                    )
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Pre-call content message{' '}
                  <span className='text-muted-foreground text-xs font-normal'>
                    (optional)
                  </span>
                </Label>
                <Textarea
                  rows={2}
                  placeholder='What you send right after booking — videos to watch, what to prepare, etc.'
                  value={persona.promptConfig.bookingScripts.preCallContent}
                  onChange={(e) =>
                    updateNested(
                      'bookingScripts',
                      'preCallContent',
                      e.target.value
                    )
                  }
                />
              </div>
            </div>

            <Separator />

            {/* Optional: Origin Story + Income Framing */}
            <div className='space-y-4'>
              <h4 className='border-b pb-1 text-sm font-semibold'>
                Optional: Origin Story & Income Framing
              </h4>
              <div className='grid gap-2'>
                <Label>
                  Full origin story{' '}
                  <span className='text-muted-foreground text-xs font-normal'>
                    (optional but recommended)
                  </span>
                </Label>
                <Textarea
                  rows={5}
                  placeholder='The full first-person story of how you got started, the struggles, the breakthrough — used during trust objections'
                  value={persona.promptConfig.originStory}
                  onChange={(e) =>
                    updatePromptConfig('originStory', e.target.value)
                  }
                />
              </div>
              <div className='grid gap-2'>
                <Label>
                  Income framing rule{' '}
                  <span className='text-muted-foreground text-xs font-normal'>
                    (optional)
                  </span>
                </Label>
                <Textarea
                  rows={3}
                  placeholder='Standing instruction for how to frame any income/financial question — non-judgmental, empathetic'
                  value={persona.promptConfig.incomeFramingRule}
                  onChange={(e) =>
                    updatePromptConfig('incomeFramingRule', e.target.value)
                  }
                />
              </div>
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
                If the person taking the call is different from the DM persona,
                enter their name here. Leave empty if you take the calls
                yourself.
              </p>
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='closerRelation'>
                Closer Relationship{' '}
                <span className='text-muted-foreground text-xs font-normal'>
                  (optional — only if closer is set)
                </span>
              </Label>
              <Input
                id='closerRelation'
                placeholder='e.g. my partner, my co-founder, my business partner'
                value={persona.promptConfig.callHandoff.closerRelation}
                onChange={(e) =>
                  updateCallHandoff('closerRelation', e.target.value)
                }
              />
              <p className='text-muted-foreground text-xs'>
                How you naturally describe your relationship. The AI will say
                things like &ldquo;I&rsquo;d love to get you on a quick call
                with <em>my partner</em> {persona.closerName || '[closer]'}
                &rdquo;. Write it the way you&rsquo;d say it out loud.
              </p>
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='closerRole'>
                Closer Role{' '}
                <span className='text-muted-foreground text-xs font-normal'>
                  (optional)
                </span>
              </Label>
              <Input
                id='closerRole'
                placeholder='e.g. runs all our strategy calls, handles new clients, closes deals'
                value={persona.promptConfig.callHandoff.closerRole}
                onChange={(e) =>
                  updateCallHandoff('closerRole', e.target.value)
                }
              />
              <p className='text-muted-foreground text-xs'>
                What they do on the call. Used to introduce them naturally when
                pitching the call. Leave blank if just the name + relation is
                enough.
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
