import assert from 'node:assert/strict';
import {
  mapAIStageToLeadStage,
  resolvePlatformAwayMode,
  shouldMarkEngagedFromLeadMessage
} from '../src/lib/stage-progression';

function testEngagedOnLeadReply() {
  assert.equal(shouldMarkEngagedFromLeadMessage('NEW_LEAD', 1), true);
  assert.equal(shouldMarkEngagedFromLeadMessage('NEW_LEAD', 0), false);
  assert.equal(shouldMarkEngagedFromLeadMessage('QUALIFYING', 3), false);
}

function testOpeningMapsToEngaged() {
  assert.equal(
    mapAIStageToLeadStage('OPENING', null, 'not_evaluated'),
    'ENGAGED'
  );
}

function testSuggestionApprovalStageMapping() {
  assert.equal(
    mapAIStageToLeadStage('SOFT_PITCH_COMMITMENT', null, 'not_evaluated'),
    'QUALIFIED'
  );
}

function testBookingSubStagesMapToCallProposed() {
  assert.equal(
    mapAIStageToLeadStage('BOOKING_TZ_ASK', null, 'not_evaluated'),
    'CALL_PROPOSED'
  );
  assert.equal(
    mapAIStageToLeadStage('BOOKING_CONFIRM', null, 'not_evaluated'),
    'CALL_PROPOSED'
  );
}

function testUnknownStageWarnsAndDoesNotCrash() {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    assert.equal(
      mapAIStageToLeadStage('UNRECOGNIZED_STAGE', null, 'not_evaluated', {
        warnUnknown: true
      }),
      null
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Unknown AI stage: UNRECOGNIZED_STAGE/);
}

function testAwayModePlatformFlagPriority() {
  assert.equal(
    resolvePlatformAwayMode(
      {
        awayMode: true,
        awayModeInstagram: false,
        awayModeFacebook: true
      },
      'INSTAGRAM'
    ),
    false
  );
  assert.equal(
    resolvePlatformAwayMode(
      {
        awayMode: false,
        awayModeInstagram: true,
        awayModeFacebook: false
      },
      'INSTAGRAM'
    ),
    true
  );
  assert.equal(
    resolvePlatformAwayMode(
      {
        awayMode: true,
        awayModeInstagram: null,
        awayModeFacebook: false
      },
      'INSTAGRAM'
    ),
    true
  );
}

testEngagedOnLeadReply();
testOpeningMapsToEngaged();
testSuggestionApprovalStageMapping();
testBookingSubStagesMapToCallProposed();
testUnknownStageWarnsAndDoesNotCrash();
testAwayModePlatformFlagPriority();

console.log('pipeline stage progression tests passed');
