export const EXPECTED_DURABLE_OBJECT_DEPLOY_RESET =
  'Durable Object reset because its code was updated.';

const DURABLE_OBJECT_STORAGE_TIMEOUT =
  'Durable Object storage operation exceeded timeout which caused object to be reset.';

const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'DELETE']);

type DurableObjectError = {
  message?: unknown;
  overloaded?: unknown;
  retryable?: unknown;
};

export interface DurableObjectTransportRecovery {
  error: unknown;
  response: Response | null;
  retried: boolean;
}

function asDurableObjectError(error: unknown): DurableObjectError {
  return error !== null && typeof error === 'object'
    ? (error as DurableObjectError)
    : {};
}

function errorMessage(error: unknown): string {
  const candidate = asDurableObjectError(error).message;
  return typeof candidate === 'string' ? candidate : '';
}

export function shouldRetryDurableObjectTransportRequest(
  request: Request,
  error: unknown,
): boolean {
  if (!RETRYABLE_METHODS.has(request.method.toUpperCase())) return false;

  const durableObjectError = asDurableObjectError(error);
  if (durableObjectError.overloaded === true) return false;
  if (durableObjectError.retryable === true) return true;

  const message = errorMessage(error);
  return (
    message === EXPECTED_DURABLE_OBJECT_DEPLOY_RESET ||
    message === DURABLE_OBJECT_STORAGE_TIMEOUT
  );
}

export async function recoverDurableObjectTransportRequest(
  request: Request,
  error: unknown,
  fetcher: (retryRequest: Request) => Promise<Response>,
  options: {
    delayMs?: number;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<DurableObjectTransportRecovery> {
  if (!shouldRetryDurableObjectTransportRequest(request, error)) {
    return { error, response: null, retried: false };
  }

  const delayMs = options.delayMs ?? 50;
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  await wait(delayMs);

  try {
    return {
      error,
      response: await fetcher(new Request(request)),
      retried: true,
    };
  } catch (retryError) {
    return { error: retryError, response: null, retried: true };
  }
}
