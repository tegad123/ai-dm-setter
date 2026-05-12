export class HarnessSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessSafetyError';
  }
}

export class RateLimitExhaustedError extends Error {
  constructor(
    message: string,
    public readonly provider: 'anthropic' | 'openai' | 'unknown',
    public readonly attempts: number
  ) {
    super(message);
    this.name = 'RateLimitExhaustedError';
  }
}

export class BudgetExceededError extends Error {
  constructor(
    message: string,
    public readonly limitUsd: number,
    public readonly actualUsd: number
  ) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class HarnessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessConfigError';
  }
}
