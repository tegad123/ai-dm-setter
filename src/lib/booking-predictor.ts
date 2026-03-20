import prisma from '@/lib/prisma';
import type { Conversation, Lead, Message } from '@prisma/client';

// ---------------------------------------------------------------------------
// Booking Probability Prediction Engine (Phase 6)
// Pure TypeScript logistic regression — no ML libraries required.
// ---------------------------------------------------------------------------

// ─── Stage Ordinal Encoding ───────────────────────────────────────────────

const STAGE_MAP: Record<string, number> = {
  opener: 0,
  qualification: 1,
  vision_building: 2,
  pain_identification: 3,
  urgency: 4,
  solution_offer: 5,
  capital_qualification: 6,
  booking: 7
} as const;

const INTENT_MAP: Record<string, number> = {
  HIGH_INTENT: 0,
  NEUTRAL: 1,
  RESISTANT: 2,
  UNQUALIFIED: 3
} as const;

// ─── Keyword Lists ────────────────────────────────────────────────────────

const FAMILY_KEYWORDS = [
  'family',
  'kids',
  'wife',
  'husband',
  'children',
  'daughter',
  'son'
];

const INCOME_KEYWORDS = [
  'income',
  'salary',
  'money',
  'earn',
  'k per month',
  'k/month',
  'financial'
];

// ─── Interfaces ───────────────────────────────────────────────────────────

export interface FeatureVector {
  currentStage: number;
  messagesSent: number;
  messagesReceived: number;
  leadSource: number;
  intentTag: number;
  avgResponseTimeLead: number;
  leadContinuedConversation: number; // BACKWARDS COMPAT: unused but reserved
  timeInCurrentStage: number;
  velocityVsBaseline: number;
  followUpAttempts: number;
  hasMentionedFamily: number;
  hasExpressedPain: number;
  hasStatedIncomeGoal: number;
}

/** Feature names in the order they map to weight indices. */
const FEATURE_NAMES: (keyof FeatureVector)[] = [
  'currentStage',
  'messagesSent',
  'messagesReceived',
  'leadSource',
  'intentTag',
  'avgResponseTimeLead',
  'timeInCurrentStage',
  'velocityVsBaseline',
  'followUpAttempts',
  'hasMentionedFamily',
  'hasExpressedPain',
  'hasStatedIncomeGoal'
];

export interface NormalizationParams {
  min: number[];
  max: number[];
}

export interface ModelWeights {
  weights: number[];
  bias: number;
  normalization: NormalizationParams;
}

export interface TrainResult {
  success: boolean;
  error?: string;
  modelId?: string;
  version?: number;
  metrics?: {
    accuracy: number;
    auc: number;
    precision: number;
    recall: number;
    trainingSize: number;
    holdoutSize: number;
  };
}

export interface PredictionResult {
  available: boolean;
  reason?: string;
  probability?: number;
  confidence?: 'early' | 'reliable';
  modelVersion?: number;
  features?: FeatureVector;
  stage?: string;
  velocity?: string;
}

export interface ModelEvaluation {
  modelId: string;
  version: number;
  totalPredictions: number;
  resolvedPredictions: number;
  accuracy: number;
  precision: number;
  recall: number;
  auc: number;
  holdoutAccuracy: number;
  holdoutAuc: number;
  degraded: boolean;
  warnings: string[];
}

// ─── Math Helpers ─────────────────────────────────────────────────────────

function sigmoid(z: number): number {
  if (z < -500) return 0;
  if (z > 500) return 1;
  return 1 / (1 + Math.exp(-z));
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

// ─── AUC Calculation (Trapezoidal Rule) ───────────────────────────────────

/**
 * Calculate AUC-ROC using the trapezoidal rule.
 * Sort predictions descending by probability, walk through thresholds,
 * count TP/FP at each step, and integrate.
 */
function calculateAUC(predictions: number[], labels: number[]): number {
  const totalPositives = labels.filter((l) => l === 1).length;
  const totalNegatives = labels.length - totalPositives;

  if (totalPositives === 0 || totalNegatives === 0) return 0.5;

  // Create sorted index pairs (descending by prediction)
  const indices = predictions
    .map((p, i) => ({ prob: p, label: labels[i] }))
    .sort((a, b) => b.prob - a.prob);

  let tp = 0;
  let fp = 0;
  let prevTPR = 0;
  let prevFPR = 0;
  let auc = 0;

  for (let i = 0; i < indices.length; i++) {
    if (indices[i].label === 1) {
      tp++;
    } else {
      fp++;
    }

    const tpr = tp / totalPositives;
    const fpr = fp / totalNegatives;

    // Trapezoidal area
    auc += ((fpr - prevFPR) * (tpr + prevTPR)) / 2;

    prevTPR = tpr;
    prevFPR = fpr;
  }

  return auc;
}

// ─── Feature Normalization ────────────────────────────────────────────────

function computeNormalizationParams(
  featureMatrix: number[][]
): NormalizationParams {
  const numFeatures = featureMatrix[0].length;
  const min = new Array<number>(numFeatures).fill(Infinity);
  const max = new Array<number>(numFeatures).fill(-Infinity);

  for (const row of featureMatrix) {
    for (let j = 0; j < numFeatures; j++) {
      if (row[j] < min[j]) min[j] = row[j];
      if (row[j] > max[j]) max[j] = row[j];
    }
  }

  // Avoid division by zero — set range to 1 where min === max
  for (let j = 0; j < numFeatures; j++) {
    if (max[j] === min[j]) {
      max[j] = min[j] + 1;
    }
  }

  return { min, max };
}

function normalizeRow(row: number[], params: NormalizationParams): number[] {
  return row.map(
    (val, j) => (val - params.min[j]) / (params.max[j] - params.min[j])
  );
}

function normalizeMatrix(
  matrix: number[][],
  params: NormalizationParams
): number[][] {
  return matrix.map((row) => normalizeRow(row, params));
}

// ─── Feature Extraction ──────────────────────────────────────────────────

/**
 * Determine the highest conversation stage reached, based on timestamp fields.
 */
function getCurrentStage(conversation: Conversation): number {
  if (conversation.stageBookingAt) return STAGE_MAP.booking;
  if (conversation.stageCapitalQualificationAt)
    return STAGE_MAP.capital_qualification;
  if (conversation.stageSolutionOfferAt) return STAGE_MAP.solution_offer;
  if (conversation.stageUrgencyAt) return STAGE_MAP.urgency;
  if (conversation.stagePainIdentificationAt)
    return STAGE_MAP.pain_identification;
  if (conversation.stageVisionBuildingAt) return STAGE_MAP.vision_building;
  if (conversation.stageQualificationAt) return STAGE_MAP.qualification;
  return STAGE_MAP.opener;
}

/**
 * Get the timestamp when the current (highest) stage was entered.
 */
function getCurrentStageEnteredAt(conversation: Conversation): Date {
  if (conversation.stageBookingAt) return conversation.stageBookingAt;
  if (conversation.stageCapitalQualificationAt)
    return conversation.stageCapitalQualificationAt;
  if (conversation.stageSolutionOfferAt)
    return conversation.stageSolutionOfferAt;
  if (conversation.stageUrgencyAt) return conversation.stageUrgencyAt;
  if (conversation.stagePainIdentificationAt)
    return conversation.stagePainIdentificationAt;
  if (conversation.stageVisionBuildingAt)
    return conversation.stageVisionBuildingAt;
  if (conversation.stageQualificationAt)
    return conversation.stageQualificationAt;
  return conversation.createdAt;
}

/**
 * Calculate average response time of the lead (seconds between AI message and
 * next lead reply) using pre-computed responseTimeSeconds on AI messages.
 */
function calcAvgResponseTimeLead(messages: Message[]): number {
  const responseTimes = messages
    .filter((m) => m.sender === 'AI' && m.responseTimeSeconds != null)
    .map((m) => m.responseTimeSeconds!);

  if (responseTimes.length === 0) return 0;
  return responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
}

/**
 * Compute the average time-to-book (in minutes) for all BOOKED conversations
 * belonging to the same account. Used as the baseline velocity denominator.
 */
async function getBaselineTimeToBook(accountId: string): Promise<number> {
  const booked = await prisma.conversation.findMany({
    where: {
      lead: { accountId },
      outcome: 'BOOKED',
      stageBookingAt: { not: null }
    },
    select: { createdAt: true, stageBookingAt: true }
  });

  if (booked.length === 0) return 60 * 24; // Fallback: 1 day in minutes

  const totalMinutes = booked.reduce((sum, c) => {
    const diff = (c.stageBookingAt!.getTime() - c.createdAt.getTime()) / 60000;
    return sum + diff;
  }, 0);

  return totalMinutes / booked.length;
}

function containsAnyKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Extract a FeatureVector from a conversation, lead, and its messages.
 */
export function extractFeatures(
  conversation: Conversation,
  lead: Lead,
  messages: Message[]
): FeatureVector {
  const aiMessages = messages.filter((m) => m.sender === 'AI');
  const leadMessages = messages.filter((m) => m.sender === 'LEAD');
  const allContent = messages.map((m) => m.content).join(' ');

  const currentStage = getCurrentStage(conversation);
  const stageEnteredAt = getCurrentStageEnteredAt(conversation);
  const timeInCurrentStage = (Date.now() - stageEnteredAt.getTime()) / 60000; // minutes

  const followUpAttempts = aiMessages.filter(
    (m) => m.followUpAttemptNumber != null && m.followUpAttemptNumber > 0
  ).length;

  return {
    currentStage,
    messagesSent: aiMessages.length,
    messagesReceived: leadMessages.length,
    leadSource: conversation.leadSource === 'INBOUND' ? 0 : 1,
    intentTag: INTENT_MAP[conversation.leadIntentTag] ?? 1,
    avgResponseTimeLead: calcAvgResponseTimeLead(messages),
    leadContinuedConversation: 0, // reserved
    timeInCurrentStage,
    velocityVsBaseline: 0, // set externally when baseline is known
    followUpAttempts,
    hasMentionedFamily: containsAnyKeyword(allContent, FAMILY_KEYWORDS) ? 1 : 0,
    hasExpressedPain: conversation.stagePainIdentificationAt ? 1 : 0,
    hasStatedIncomeGoal: containsAnyKeyword(allContent, INCOME_KEYWORDS) ? 1 : 0
  };
}

/**
 * Convert FeatureVector to a numeric array in FEATURE_NAMES order.
 */
function featureVectorToArray(fv: FeatureVector): number[] {
  return FEATURE_NAMES.map((name) => fv[name] as number);
}

// ─── Logistic Regression Training ─────────────────────────────────────────

interface TrainingData {
  features: number[][];
  labels: number[];
}

function trainLogisticRegression(
  data: TrainingData,
  normParams: NormalizationParams,
  learningRate = 0.01,
  iterations = 1000,
  lambda = 0.01
): { weights: number[]; bias: number } {
  const X = normalizeMatrix(data.features, normParams);
  const y = data.labels;
  const n = X.length;
  const d = X[0].length;

  const weights = new Array<number>(d).fill(0);
  let bias = 0;

  for (let iter = 0; iter < iterations; iter++) {
    const gradW = new Array<number>(d).fill(0);
    let gradB = 0;

    for (let i = 0; i < n; i++) {
      const z = dot(weights, X[i]) + bias;
      const pred = sigmoid(z);
      const err = pred - y[i];

      for (let j = 0; j < d; j++) {
        gradW[j] += err * X[i][j];
      }
      gradB += err;
    }

    // Average gradients + L2 regularization on weights
    for (let j = 0; j < d; j++) {
      weights[j] =
        weights[j] - learningRate * (gradW[j] / n + lambda * weights[j]);
    }
    bias = bias - learningRate * (gradB / n);
  }

  return { weights, bias };
}

// ─── Evaluation Helpers ───────────────────────────────────────────────────

function evaluateOnSet(
  X: number[][],
  y: number[],
  weights: number[],
  bias: number,
  normParams: NormalizationParams
): { accuracy: number; auc: number; precision: number; recall: number } {
  const Xn = normalizeMatrix(X, normParams);
  const predictions = Xn.map((row) => sigmoid(dot(weights, row) + bias));

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;

  for (let i = 0; i < y.length; i++) {
    const predicted = predictions[i] >= 0.5 ? 1 : 0;
    if (predicted === 1 && y[i] === 1) tp++;
    else if (predicted === 1 && y[i] === 0) fp++;
    else if (predicted === 0 && y[i] === 0) tn++;
    else fn++;
  }

  const accuracy = (tp + tn) / y.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const auc = calculateAUC(predictions, y);

  return { accuracy, auc, precision, recall };
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Train a logistic regression model on all resolved conversations for the
 * given account. Requires at least 200 resolved conversations.
 */
export async function trainModel(accountId: string): Promise<TrainResult> {
  // Fetch all resolved conversations with leads and messages
  const conversations = await prisma.conversation.findMany({
    where: {
      lead: { accountId },
      outcome: { not: 'ONGOING' }
    },
    include: {
      lead: true,
      messages: { orderBy: { timestamp: 'asc' } }
    }
  });

  if (conversations.length < 200) {
    return {
      success: false,
      error: `Insufficient data: ${conversations.length} resolved conversations found, minimum 200 required.`
    };
  }

  // Compute baseline time-to-book for velocity feature
  const baselineMinutes = await getBaselineTimeToBook(accountId);

  // Extract features and labels
  const allFeatures: number[][] = [];
  const allLabels: number[] = [];

  for (const conv of conversations) {
    const fv = extractFeatures(conv, conv.lead, conv.messages);

    // Velocity vs baseline: ratio of conversation duration to baseline
    const convDuration =
      ((conv.stageBookingAt ?? conv.updatedAt).getTime() -
        conv.createdAt.getTime()) /
        60000 || 1;
    fv.velocityVsBaseline = convDuration / baselineMinutes;

    allFeatures.push(featureVectorToArray(fv));
    allLabels.push(conv.outcome === 'BOOKED' ? 1 : 0);
  }

  // 80/20 split (deterministic — first 80% train, last 20% holdout)
  const splitIdx = Math.floor(allFeatures.length * 0.8);
  const trainFeatures = allFeatures.slice(0, splitIdx);
  const trainLabels = allLabels.slice(0, splitIdx);
  const holdoutFeatures = allFeatures.slice(splitIdx);
  const holdoutLabels = allLabels.slice(splitIdx);

  // Compute normalization from training set only
  const normParams = computeNormalizationParams(trainFeatures);

  // Train
  const { weights, bias } = trainLogisticRegression(
    { features: trainFeatures, labels: trainLabels },
    normParams
  );

  // Evaluate on holdout
  const metrics = evaluateOnSet(
    holdoutFeatures,
    holdoutLabels,
    weights,
    bias,
    normParams
  );

  // Determine next model version
  const latestModel = await prisma.predictionModel.findFirst({
    where: { accountId },
    orderBy: { version: 'desc' },
    select: { version: true }
  });
  const nextVersion = (latestModel?.version ?? 0) + 1;

  // Deactivate previous active models
  await prisma.predictionModel.updateMany({
    where: { accountId, isActive: true },
    data: { isActive: false }
  });

  // Save new model
  const modelWeights: ModelWeights = {
    weights,
    bias,
    normalization: normParams
  };

  const saved = await prisma.predictionModel.create({
    data: {
      accountId,
      version: nextVersion,
      modelType: 'logistic_regression',
      weights: modelWeights as any,
      features: FEATURE_NAMES as any,
      trainingSize: trainFeatures.length,
      holdoutSize: holdoutFeatures.length,
      accuracy: metrics.accuracy,
      auc: metrics.auc,
      precision: metrics.precision,
      recall: metrics.recall,
      isActive: true
    }
  });

  return {
    success: true,
    modelId: saved.id,
    version: nextVersion,
    metrics: {
      ...metrics,
      trainingSize: trainFeatures.length,
      holdoutSize: holdoutFeatures.length
    }
  };
}

/**
 * Predict the booking probability for an active conversation.
 */
export async function predictBookingProbability(
  accountId: string,
  conversationId: string
): Promise<PredictionResult> {
  // Load active model
  const model = await prisma.predictionModel.findFirst({
    where: { accountId, isActive: true },
    orderBy: { version: 'desc' }
  });

  if (!model) {
    return { available: false, reason: 'Model not trained yet' };
  }

  // Load conversation with lead and messages
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      lead: true,
      messages: { orderBy: { timestamp: 'asc' } }
    }
  });

  if (!conversation) {
    return { available: false, reason: 'Conversation not found' };
  }

  // Extract features
  const fv = extractFeatures(
    conversation,
    conversation.lead,
    conversation.messages
  );

  // Compute velocity vs baseline
  const baselineMinutes = await getBaselineTimeToBook(accountId);
  const convDuration =
    (Date.now() - conversation.createdAt.getTime()) / 60000 || 1;
  fv.velocityVsBaseline = convDuration / baselineMinutes;

  const featureArray = featureVectorToArray(fv);

  // Apply model
  const modelWeights = model.weights as unknown as ModelWeights;
  const normalized = normalizeRow(featureArray, modelWeights.normalization);
  const probability = sigmoid(
    dot(modelWeights.weights, normalized) + modelWeights.bias
  );

  // Confidence based on message count
  const totalMessages = fv.messagesSent + fv.messagesReceived;
  const confidence: 'early' | 'reliable' =
    totalMessages < 6 ? 'early' : 'reliable';

  // Log prediction
  await prisma.predictionLog.create({
    data: {
      accountId,
      conversationId,
      modelId: model.id,
      predictedProb: probability,
      features: fv as any
    }
  });

  // Derive human-readable stage name from ordinal
  const stageNames = Object.keys(STAGE_MAP);
  const stageName =
    stageNames.find((k) => STAGE_MAP[k] === fv.currentStage) ?? 'opener';

  // Derive velocity label from ratio
  const velocityLabel =
    fv.velocityVsBaseline < 0.8
      ? 'Fast'
      : fv.velocityVsBaseline <= 1.2
        ? 'Normal'
        : 'Slow';

  return {
    available: true,
    probability,
    confidence,
    modelVersion: model.version,
    features: fv,
    stage: stageName,
    velocity: velocityLabel
  };
}

/**
 * Evaluate the active model against real-world predictions that now have
 * known outcomes. Compare live performance to the original holdout metrics
 * and flag degradation.
 */
export async function evaluateModel(
  accountId: string
): Promise<ModelEvaluation> {
  const model = await prisma.predictionModel.findFirst({
    where: { accountId, isActive: true },
    orderBy: { version: 'desc' }
  });

  if (!model) {
    throw new Error('No active prediction model found for this account.');
  }

  // Fetch prediction logs that have been resolved (actualOutcome filled)
  const logs = await prisma.predictionLog.findMany({
    where: {
      modelId: model.id,
      actualOutcome: { not: null }
    },
    select: {
      predictedProb: true,
      actualOutcome: true
    }
  });

  const totalLogs = await prisma.predictionLog.count({
    where: { modelId: model.id }
  });

  const predictions = logs.map((l) => l.predictedProb);
  const labels = logs.map((l) => (l.actualOutcome === 'BOOKED' ? 1 : 0));

  let accuracy = 0;
  let precision = 0;
  let recall = 0;
  let auc = 0.5;

  if (logs.length > 0) {
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;

    for (let i = 0; i < labels.length; i++) {
      const predicted = predictions[i] >= 0.5 ? 1 : 0;
      if (predicted === 1 && labels[i] === 1) tp++;
      else if (predicted === 1 && labels[i] === 0) fp++;
      else if (predicted === 0 && labels[i] === 0) tn++;
      else fn++;
    }

    accuracy = (tp + tn) / labels.length;
    precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    auc = calculateAUC(predictions, labels);
  }

  const warnings: string[] = [];
  if (accuracy < 0.6) {
    warnings.push(
      `Live accuracy (${(accuracy * 100).toFixed(1)}%) is below 60% threshold. Model may need retraining.`
    );
  }
  if (model.accuracy - accuracy > 0.1) {
    warnings.push(
      `Accuracy degraded by ${((model.accuracy - accuracy) * 100).toFixed(1)}% compared to holdout (${(model.accuracy * 100).toFixed(1)}% -> ${(accuracy * 100).toFixed(1)}%).`
    );
  }
  if (model.auc - auc > 0.1) {
    warnings.push(
      `AUC degraded by ${((model.auc - auc) * 100).toFixed(1)}% compared to holdout (${(model.auc * 100).toFixed(1)}% -> ${(auc * 100).toFixed(1)}%).`
    );
  }

  return {
    modelId: model.id,
    version: model.version,
    totalPredictions: totalLogs,
    resolvedPredictions: logs.length,
    accuracy,
    precision,
    recall,
    auc,
    holdoutAccuracy: model.accuracy,
    holdoutAuc: model.auc,
    degraded: accuracy < 0.6,
    warnings
  };
}
