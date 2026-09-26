import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import {
  formatJudgeLeadContext,
  selectJudgeBranchForLead
} from '../../src/lib/ai-engine';

config({ quiet: true });
if (!process.argv.includes('--live-model')) {
  throw new Error(
    'Use --live-model to classify fixtures with the configured provider. No webhooks or Meta sends occur.'
  );
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../fixtures/final-discord-routing-2026-09-26.json',
      import.meta.url
    ),
    'utf8'
  )
);
const cases = [
  ...[
    [
      'new but market explicit',
      'hey, i am new to futures trading. where should i start?',
      'Futures'
    ],
    [
      'new with forex chosen',
      'new to forex, where do i start?',
      'Forex / Gold'
    ],
    [
      'new without a market',
      'brand new to trading, not picked anything yet',
      'New, no market yet'
    ],
    ['both markets explicit', 'i trade both forex and futures', 'Both'],
    ['futures adjacent', 'i trade nq on topstep', 'Futures'],
    ['pain without market', 'i keep blowing accounts', 'Named a pain instead']
  ].map(([name, reply, expected]) => ({
    name,
    step: 1,
    prior: '',
    reply,
    expected
  })),
  {
    name: 'live request with negated risk',
    step: 4,
    prior: 'New or still learning',
    reply:
      "yeah that sounds perfect honestly, i'm definitely not trying to risk money while i'm still figuring things out. a free discord with an actual process would be exactly what i'm looking for right now. yeah send the link over",
    expected: 'YES'
  },
  {
    name: 'short acceptance',
    step: 4,
    prior: 'New or still learning',
    reply: 'yes please',
    expected: 'YES'
  },
  {
    name: 'explicit refusal',
    step: 4,
    prior: 'New or still learning',
    reply: 'no thanks, not interested',
    expected: 'Hesitant'
  },
  {
    name: 'asks what it is',
    step: 4,
    prior: 'New or still learning',
    reply: 'what is it first?',
    expected: 'Hesitant'
  },
  {
    name: 'hesitant now accepts',
    step: 5,
    prior: 'Hesitant',
    reply: 'yeah for sure, send it over',
    expected: 'Hesitant, now yes'
  },
  {
    name: 'hesitant declines again',
    step: 5,
    prior: 'Hesitant',
    reply: 'no thanks, still not for me',
    expected: 'Soft exit'
  },
  {
    name: 'joined after link',
    step: 5,
    prior: 'YES',
    reply: 'yes i joined the discord',
    expected: 'Joined'
  },
  {
    name: 'not yet joined after link',
    step: 5,
    prior: 'YES',
    reply: 'not yet, will join later',
    expected: 'Not in yet'
  }
];

async function main() {
  let passed = 0;
  // Bounded concurrency keeps this semantic benchmark quick without touching production.
  for (let i = 0; i < cases.length; i += 2) {
    await Promise.all(
      cases.slice(i, i + 2).map(async (item) => {
        const started = Date.now();
        const result = await selectJudgeBranchForLead(
          fixture.steps.find(
            (step: { stepNumber: number }) => step.stepNumber === item.step
          ),
          formatJudgeLeadContext({
            recentLeadMessages:
              item.step === 1
                ? [item.reply]
                : ['nah not yet, still learning', item.reply],
            previousCompletedBranch:
              item.step === 1
                ? null
                : {
                    stepNumber: item.step - 1,
                    label: item.prior
                  }
          })
        );
        const ok = result.branchLabel === item.expected;
        if (ok) passed++;
        console.log(
          JSON.stringify({
            name: item.name,
            expected: item.expected,
            actual: result.branchLabel,
            pass: ok,
            elapsedMs: Date.now() - started,
            trace: result.classifierTrace
          })
        );
      })
    );
  }
  console.log(
    `Routing benchmark: ${passed}/${cases.length} passed; script ${fixture.scriptId}, version ${fixture.updatedAt}`
  );
  if (passed !== cases.length) process.exitCode = 1;
}
void main();
