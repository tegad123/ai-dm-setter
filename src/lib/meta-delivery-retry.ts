import { classifyMetaDeliveryError } from './meta-delivery-errors';

/** Retry only an explicitly transient rejection, never an uncertain send. */
export async function retryMetaDelivery<T>(
  send: () => Promise<T>,
  options: {
    onFailure?: (error: unknown, attempt: number) => void;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {}
): Promise<T> {
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      options.onFailure?.(error, attempt);
      if (attempt >= 3 || !classifyMetaDeliveryError(error).retryable) {
        throw error;
      }
      await sleep(2 ** (attempt - 1) * 1000);
    }
  }
}
