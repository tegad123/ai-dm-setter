-- CreateTable
CREATE TABLE "PredictionModel" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "modelType" TEXT NOT NULL DEFAULT 'logistic_regression',
    "weights" JSONB NOT NULL,
    "features" JSONB NOT NULL,
    "trainingSize" INTEGER NOT NULL,
    "holdoutSize" INTEGER NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "auc" DOUBLE PRECISION NOT NULL,
    "precision" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recall" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "trainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PredictionModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PredictionLog" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "predictedProb" DOUBLE PRECISION NOT NULL,
    "actualOutcome" TEXT,
    "features" JSONB NOT NULL,
    "predictedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PredictionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PredictionModel_accountId_isActive_idx" ON "PredictionModel"("accountId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "PredictionModel_accountId_version_key" ON "PredictionModel"("accountId", "version");

-- CreateIndex
CREATE INDEX "PredictionLog_accountId_conversationId_idx" ON "PredictionLog"("accountId", "conversationId");

-- CreateIndex
CREATE INDEX "PredictionLog_modelId_predictedAt_idx" ON "PredictionLog"("modelId", "predictedAt");

-- AddForeignKey
ALTER TABLE "PredictionLog" ADD CONSTRAINT "PredictionLog_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "PredictionModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
