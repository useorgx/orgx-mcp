import { describe, expect, it } from 'vitest';

import {
  buildNewSessionWelcomeStorageKey,
  buildNewSessionWelcomeText,
  NEW_SESSION_WELCOME_STORAGE_PREFIX,
} from '../src/sessionMessaging';

describe('sessionMessaging', () => {
  it('builds a durable first-run welcome key from user identity', () => {
    expect(buildNewSessionWelcomeStorageKey('user_123')).toBe(
      `${NEW_SESSION_WELCOME_STORAGE_PREFIX}:user_123`
    );
  });

  it('normalizes and encodes first-run welcome key identities', () => {
    expect(buildNewSessionWelcomeStorageKey(' user@example.com ')).toBe(
      `${NEW_SESSION_WELCOME_STORAGE_PREFIX}:user%40example.com`
    );
  });

  it('does not build a first-run welcome key without identity', () => {
    expect(buildNewSessionWelcomeStorageKey('')).toBeNull();
    expect(buildNewSessionWelcomeStorageKey(undefined)).toBeNull();
  });

  it('keeps the first-run welcome concise', () => {
    const text = buildNewSessionWelcomeText();

    expect(text).toContain('Connected to OrgX.');
    expect(text).toContain('scaffold_initiative');
    expect(text.length).toBeLessThan(130);
  });
});
