/**
 * Dependency-free idempotency key schemas, shared by operation contracts and
 * the registration guard in ./idempotencyKeys.ts.
 */
import { z } from 'zod';

export const IDEMPOTENCY_KEY_DESCRIPTION =
  'Required idempotency key for this write. Generate one stable value per intended change (for example "<client>:<operation>:<uuid>") and resend the same key with identical input when retrying after a timeout or unknown outcome; OrgX applies the write at most once and replays the original result. Use a new key for a different change; reusing a key with different input is rejected.';

export const IDEMPOTENCY_KEY_REQUIRED_MESSAGE =
  'idempotency_key is required for this write. Send one stable key per intended change and reuse it only to retry identical input.';

/** Shared required key: 1-200 characters after trimming. */
export const idempotencyKeySchema = z
  .string({ required_error: IDEMPOTENCY_KEY_REQUIRED_MESSAGE, invalid_type_error: IDEMPOTENCY_KEY_REQUIRED_MESSAGE })
  .trim()
  .min(1, IDEMPOTENCY_KEY_REQUIRED_MESSAGE)
  .max(200)
  .describe(IDEMPOTENCY_KEY_DESCRIPTION);

/** Portable receipt keys travel in the import body and keep their stricter pattern. */
export const receiptIdempotencyKeySchema = z
  .string({ required_error: IDEMPOTENCY_KEY_REQUIRED_MESSAGE, invalid_type_error: IDEMPOTENCY_KEY_REQUIRED_MESSAGE })
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/, 'idempotency_key must start with a letter or digit and use only letters, digits, and . _ : / - (max 160 characters).')
  .describe(`${IDEMPOTENCY_KEY_DESCRIPTION} Bound to this receipt document; up to 160 characters of letters, digits, and . _ : / -.`);

/** Satisfies both key schemas; used only to validate the other fields. */
export const IDEMPOTENCY_KEY_PLACEHOLDER = 'mcp:idempotency-key-placeholder';
