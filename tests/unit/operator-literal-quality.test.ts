import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  scoreVoiceQuality,
  type VoiceQualityOptions
} from '../../src/lib/voice-quality-gate';

const literal =
  "my whole thing is if I don't trade with you for two weeks, can you still feed yourself and your family? that's the only version of this worth doing";
const ask = 'want me to put you on the waitlist?';
const options: VoiceQualityOptions = {
  suppressBookingLanguage: true,
  currentStepHasAnyAskAction: true,
  currentStepScriptedQuestions: [ask],
  activeBranchScriptedQuestions: [ask],
  activeBranchRequiredMessages: [{ content: literal }]
};
const offscript = (reply: string, config = options) =>
  scoreVoiceQuality(reply, config).hardFails.some((f) =>
    f.includes('offscript_question_on_lowticket')
  );

describe('exact selected-branch copy in voice quality', () => {
  it('does not label an authored rhetorical question as improvised discovery', () => {
    assert.equal(offscript(literal), false);
  });
  it('still rejects an added off-script question', () => {
    assert.equal(
      offscript('what is your biggest obstacle with consistency?'),
      true
    );
    assert.equal(
      offscript(literal + ' what is your biggest obstacle with consistency?'),
      true
    );
  });
  it('does not grant the exemption to a sibling or generated placeholder', () => {
    assert.equal(
      offscript(literal, {
        ...options,
        activeBranchRequiredMessages: [],
        currentStepRequiredMessages: [literal]
      }),
      true
    );
    assert.equal(
      offscript(literal, {
        ...options,
        activeBranchRequiredMessages: [
          { content: literal, isPlaceholder: true }
        ]
      }),
      true
    );
  });
  it('preserves scripted emoji but rejects it in newly generated text', () => {
    const text = 'welcome aboard 🙏';
    const config = { activeBranchRequiredMessages: [{ content: text }] };
    const banned = (reply: string) =>
      scoreVoiceQuality(reply, config).hardFails.some((f) =>
        f.includes('banned_emoji')
      );
    assert.equal(banned(text), false);
    assert.equal(banned('thanks for joining 🙏'), true);
    assert.equal(banned(text + ' glad you are here'), true);
  });
});
