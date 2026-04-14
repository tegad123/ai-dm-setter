// ---------------------------------------------------------------------------
// seed-default-script.ts
// ---------------------------------------------------------------------------
// Creates Dae's 10-Step B2C DM Setting Framework as a Script with all
// steps, branches, actions, and forms for a given account.
//
// Usage:
//   import { seedDefaultScript } from './seed-default-script';
//   const scriptId = await seedDefaultScript(accountId);
// ---------------------------------------------------------------------------

import { PrismaClient, ScriptActionType } from '@prisma/client';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Template Data
// ---------------------------------------------------------------------------

interface TemplateAction {
  actionType: ScriptActionType;
  content?: string | null;
  linkUrl?: string | null;
  linkLabel?: string | null;
  formRefKey?: string; // maps to a form by key
  waitDuration?: number | null;
  sortOrder: number;
}

interface TemplateBranch {
  branchLabel: string;
  conditionDescription: string;
  sortOrder: number;
  actions: TemplateAction[];
}

interface TemplateStep {
  stepNumber: number;
  title: string;
  description: string;
  objective: string;
  branches: TemplateBranch[];
  directActions: TemplateAction[];
}

interface TemplateForm {
  key: string; // internal ref key
  name: string;
  description: string;
  fields: { fieldLabel: string; fieldValue: string; sortOrder: number }[];
}

const TEMPLATE_FORMS: TemplateForm[] = [
  {
    key: 'trading_faqs',
    name: 'Trading FAQs',
    description: 'Common questions and answers about the trading program',
    fields: [
      {
        fieldLabel: 'What markets do you trade?',
        fieldValue: '',
        sortOrder: 0
      },
      {
        fieldLabel: 'How much starting capital is needed?',
        fieldValue: '',
        sortOrder: 1
      },
      {
        fieldLabel: 'How long before I see results?',
        fieldValue: '',
        sortOrder: 2
      },
      {
        fieldLabel: 'What makes this different from other programs?',
        fieldValue: '',
        sortOrder: 3
      },
      { fieldLabel: 'What support is included?', fieldValue: '', sortOrder: 4 }
    ]
  },
  {
    key: 'post_call_feedback',
    name: 'Post-Call Feedback',
    description: 'Feedback form sent after the consultation call',
    fields: [
      { fieldLabel: 'How was the call?', fieldValue: '', sortOrder: 0 },
      { fieldLabel: 'What was most helpful?', fieldValue: '', sortOrder: 1 },
      { fieldLabel: 'Any remaining questions?', fieldValue: '', sortOrder: 2 }
    ]
  }
];

const TEMPLATE_STEPS: TemplateStep[] = [
  {
    stepNumber: 1,
    title: 'Initial Engagement',
    description:
      'First response to an incoming DM. Acknowledge their message and gauge initial interest.',
    objective:
      'Get the lead talking and determine if they are interested or need re-engagement.',
    branches: [
      {
        branchLabel: 'Interested',
        conditionDescription:
          'Lead shows interest or asks a question about the offer',
        sortOrder: 0,
        actions: [
          {
            actionType: 'send_message',
            content:
              'Hey! Thanks for reaching out \u{1F64C} What made you interested in [your offer]?',
            sortOrder: 0
          },
          { actionType: 'wait_for_response', sortOrder: 1 }
        ]
      },
      {
        branchLabel: 'Not Interested',
        conditionDescription:
          'Lead seems uninterested, confused, or was just browsing',
        sortOrder: 1,
        actions: [
          {
            actionType: 'send_message',
            content:
              'No worries! Just curious, what caught your eye about the post/story?',
            sortOrder: 0
          },
          { actionType: 'wait_for_response', sortOrder: 1 }
        ]
      }
    ],
    directActions: []
  },
  {
    stepNumber: 2,
    title: 'Qualification',
    description:
      "Ask qualifying questions to understand the lead's situation, experience level, and needs.",
    objective:
      'Determine if the lead is a good fit and which path to route them down.',
    branches: [],
    directActions: [
      {
        actionType: 'ask_question',
        content:
          'Quick question, have you ever [done X] before or would this be completely new for you?',
        sortOrder: 0
      },
      { actionType: 'wait_for_response', sortOrder: 1 },
      {
        actionType: 'ask_question',
        content:
          "Got it! And what's your current situation looking like? Like what do you do for work right now?",
        sortOrder: 2
      },
      { actionType: 'wait_for_response', sortOrder: 3 }
    ]
  },
  {
    stepNumber: 3,
    title: 'Build Rapport',
    description:
      'Create a personal connection with the lead. Mirror their energy and communication style.',
    objective:
      'Build trust and make the lead feel comfortable before presenting the offer.',
    branches: [],
    directActions: [
      {
        actionType: 'runtime_judgment',
        content:
          "Match the lead's tone and energy. If they're casual, be casual. If they're formal, adjust accordingly. Reference specific details they've shared to show you're listening.",
        sortOrder: 0
      },
      {
        actionType: 'send_message',
        content:
          "That's dope, I respect that. I was in a similar spot before I got into [your field]...",
        sortOrder: 1
      },
      { actionType: 'wait_for_response', sortOrder: 2 }
    ]
  },
  {
    stepNumber: 4,
    title: 'Present Offer',
    description:
      'Pitch the product or service. Share relevant links and social proof.',
    objective:
      'Clearly communicate the value proposition and get the lead excited about the offer.',
    branches: [],
    directActions: [
      {
        actionType: 'send_message',
        content:
          "So here's what I do... I help people [your value prop]. We've had students go from [before] to [after result].",
        sortOrder: 0
      },
      {
        actionType: 'send_link',
        content: 'Check out this breakdown of what we cover',
        linkUrl: '',
        linkLabel: 'Program Overview',
        sortOrder: 1
      },
      {
        actionType: 'send_video',
        content: "Here's a quick video showing some student results",
        linkUrl: '',
        linkLabel: 'Results Video',
        sortOrder: 2
      },
      { actionType: 'wait_for_response', sortOrder: 3 }
    ]
  },
  {
    stepNumber: 5,
    title: 'Handle Objections',
    description:
      'Address common objections: price, time, skepticism, past failures, complexity.',
    objective:
      'Overcome resistance and move the lead closer to booking a call.',
    branches: [
      {
        branchLabel: 'Price Objection',
        conditionDescription:
          "Lead says it's too expensive, can't afford it, needs to think about the money",
        sortOrder: 0,
        actions: [
          {
            actionType: 'send_message',
            content:
              "I totally get that. When I started I was in the same boat. Can I ask, what's your current monthly income looking like?",
            sortOrder: 0
          },
          { actionType: 'wait_for_response', sortOrder: 1 }
        ]
      },
      {
        branchLabel: 'Time Objection',
        conditionDescription:
          "Lead says they don't have time, too busy, bad timing",
        sortOrder: 1,
        actions: [
          {
            actionType: 'send_message',
            content:
              'I hear you. Most of our successful students work full-time too. This only takes about [X hours/week]. What does your typical day look like?',
            sortOrder: 0
          },
          { actionType: 'wait_for_response', sortOrder: 1 }
        ]
      },
      {
        branchLabel: 'Skepticism',
        conditionDescription:
          'Lead doubts it works, seems skeptical, questions legitimacy',
        sortOrder: 2,
        actions: [
          {
            actionType: 'send_message',
            content:
              "That's a fair concern. I was skeptical too. Let me show you some actual results from people who started exactly where you are...",
            sortOrder: 0
          },
          {
            actionType: 'form_reference',
            content: 'See frequently asked questions',
            formRefKey: 'trading_faqs',
            sortOrder: 1
          },
          { actionType: 'wait_for_response', sortOrder: 2 }
        ]
      },
      {
        branchLabel: 'Past Failure',
        conditionDescription:
          "Lead tried something similar before and it didn't work",
        sortOrder: 3,
        actions: [
          {
            actionType: 'send_message',
            content:
              "I appreciate you being real with me. What was different about that experience? Usually when people struggle it's because of [common reason]...",
            sortOrder: 0
          },
          { actionType: 'wait_for_response', sortOrder: 1 }
        ]
      },
      {
        branchLabel: 'Complexity',
        conditionDescription:
          "Lead thinks it's too complicated or too hard to learn",
        sortOrder: 4,
        actions: [
          {
            actionType: 'send_message',
            content:
              'I get it, it can seem overwhelming from the outside. But we break it down step by step. Most students say it clicked within the first [timeframe].',
            sortOrder: 0
          },
          { actionType: 'wait_for_response', sortOrder: 1 }
        ]
      }
    ],
    directActions: []
  },
  {
    stepNumber: 6,
    title: 'Close',
    description:
      "Ask for the commitment. Determine if they're ready to book or need more time.",
    objective: 'Get a clear yes/no on booking a call.',
    branches: [
      {
        branchLabel: 'Ready to Book',
        conditionDescription: 'Lead agrees to book a call, shows commitment',
        sortOrder: 0,
        actions: [
          {
            actionType: 'send_message',
            content: "Let's get you booked in! What timezone are you in?",
            sortOrder: 0
          },
          { actionType: 'wait_for_response', sortOrder: 1 }
        ]
      },
      {
        branchLabel: 'Needs More Time',
        conditionDescription: 'Lead wants to think about it, not ready yet',
        sortOrder: 1,
        actions: [
          {
            actionType: 'send_message',
            content:
              'No pressure at all. Just so you know, spots fill up fast. When would be a good time to follow up with you?',
            sortOrder: 0
          },
          { actionType: 'wait_for_response', sortOrder: 1 }
        ]
      }
    ],
    directActions: []
  },
  {
    stepNumber: 7,
    title: 'Book Call',
    description:
      'Calendar booking flow. Collect timezone, propose times, get confirmation.',
    objective: 'Successfully book a consultation call.',
    branches: [],
    directActions: [
      {
        actionType: 'send_message',
        content: "Here's my calendar, pick a time that works best for you:",
        sortOrder: 0
      },
      {
        actionType: 'send_link',
        content: 'Book your call here',
        linkUrl: '',
        linkLabel: 'Calendar Link',
        sortOrder: 1
      },
      { actionType: 'wait_for_response', sortOrder: 2 }
    ]
  },
  {
    stepNumber: 8,
    title: 'Pre-Call Nurture',
    description:
      'Between booking and the call. Build excitement and reduce no-show risk.',
    objective: 'Keep the lead engaged and excited before their call.',
    branches: [],
    directActions: [
      {
        actionType: 'send_voice_note',
        content: 'Personal voice note building excitement for the call',
        sortOrder: 0
      },
      {
        actionType: 'send_message',
        content:
          "Hey! Just wanted to say I'm looking forward to our call. Before we chat, think about what your ideal [outcome] looks like. It'll help us make the most of our time together.",
        sortOrder: 1
      }
    ]
  },
  {
    stepNumber: 9,
    title: 'No-Show Recovery',
    description: 'If the lead misses their call. Follow up to reschedule.',
    objective: 'Recover no-shows and get them rebooked.',
    branches: [],
    directActions: [
      {
        actionType: 'send_message',
        content:
          "Hey! I noticed you couldn't make the call today. No worries at all, life happens. Want to reschedule for another time this week?",
        sortOrder: 0
      },
      {
        actionType: 'send_voice_note',
        content: 'Casual voice note checking in about the missed call',
        sortOrder: 1
      },
      { actionType: 'wait_for_response', sortOrder: 2 }
    ]
  },
  {
    stepNumber: 10,
    title: 'Post-Call Follow-Up',
    description:
      'After the consultation call. Send follow-up and collect feedback.',
    objective: 'Solidify the relationship and gather feedback.',
    branches: [],
    directActions: [
      {
        actionType: 'send_message',
        content:
          "Great talking to you today! As promised, here's a recap of what we discussed and next steps.",
        sortOrder: 0
      },
      {
        actionType: 'form_reference',
        content: 'Quick feedback on our call',
        formRefKey: 'post_call_feedback',
        sortOrder: 1
      }
    ]
  }
];

// ---------------------------------------------------------------------------
// seedDefaultScript
// ---------------------------------------------------------------------------

export async function seedDefaultScript(
  accountId: string,
  prismaClient?: PrismaClient
): Promise<string> {
  const db = prismaClient || prisma;

  // 1. Create the Script record
  const script = await db.script.create({
    data: {
      accountId,
      name: "Dae's B2C DM Setting Framework",
      description:
        '10-step B2C appointment setting framework. Customize the messages, links, and voice notes for your business.',
      isDefault: true,
      isActive: false
    }
  });

  // 2. Create ScriptForms (need IDs before creating form_reference actions)
  const formIdMap: Record<string, string> = {};

  for (const tmplForm of TEMPLATE_FORMS) {
    const form = await db.scriptForm.create({
      data: {
        scriptId: script.id,
        name: tmplForm.name,
        description: tmplForm.description
      }
    });
    formIdMap[tmplForm.key] = form.id;

    // Create fields for this form
    await db.scriptFormField.createMany({
      data: tmplForm.fields.map((f) => ({
        formId: form.id,
        fieldLabel: f.fieldLabel,
        fieldValue: f.fieldValue || null,
        sortOrder: f.sortOrder
      }))
    });
  }

  // 3. Create Steps, Branches, and Actions
  for (const tmplStep of TEMPLATE_STEPS) {
    const step = await db.scriptStep.create({
      data: {
        scriptId: script.id,
        stepNumber: tmplStep.stepNumber,
        title: tmplStep.title,
        description: tmplStep.description,
        objective: tmplStep.objective
      }
    });

    // Create branches and their actions
    for (const tmplBranch of tmplStep.branches) {
      const branch = await db.scriptBranch.create({
        data: {
          stepId: step.id,
          branchLabel: tmplBranch.branchLabel,
          conditionDescription: tmplBranch.conditionDescription,
          sortOrder: tmplBranch.sortOrder
        }
      });

      // Create actions for this branch
      await db.scriptAction.createMany({
        data: tmplBranch.actions.map((a) => ({
          stepId: step.id,
          branchId: branch.id,
          actionType: a.actionType,
          content: a.content ?? null,
          linkUrl: a.linkUrl ?? null,
          linkLabel: a.linkLabel ?? null,
          formId: a.formRefKey ? (formIdMap[a.formRefKey] ?? null) : null,
          waitDuration: a.waitDuration ?? null,
          sortOrder: a.sortOrder
        }))
      });
    }

    // Create direct actions (no branch)
    if (tmplStep.directActions.length > 0) {
      await db.scriptAction.createMany({
        data: tmplStep.directActions.map((a) => ({
          stepId: step.id,
          branchId: null,
          actionType: a.actionType,
          content: a.content ?? null,
          linkUrl: a.linkUrl ?? null,
          linkLabel: a.linkLabel ?? null,
          formId: a.formRefKey ? (formIdMap[a.formRefKey] ?? null) : null,
          waitDuration: a.waitDuration ?? null,
          sortOrder: a.sortOrder
        }))
      });
    }
  }

  return script.id;
}

// Allow running directly: npx tsx prisma/seed-default-script.ts <accountId>
if (require.main === module) {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error('Usage: npx tsx prisma/seed-default-script.ts <accountId>');
    process.exit(1);
  }
  seedDefaultScript(accountId)
    .then((id) => {
      console.log(`Created default script: ${id}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed to seed default script:', err);
      process.exit(1);
    });
}
