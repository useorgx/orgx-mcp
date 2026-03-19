export const BILLING_SETTINGS_PATH = '/settings/billing';
export const PRICING_PATH = '/pricing';
export const DEFAULT_ORGX_WEB_URL = 'https://useorgx.com';

type BillingLinkQuery = Record<string, string | null | undefined>;

function appendQuery(
  path: string,
  query: BillingLinkQuery = {}
): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      params.set(key, value);
    }
  }

  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function resolveBase(baseUrl?: string | null): string {
  return typeof baseUrl === 'string' && baseUrl.trim().length > 0
    ? baseUrl
    : DEFAULT_ORGX_WEB_URL;
}

export function buildBillingSettingsPath(query: BillingLinkQuery = {}): string {
  return appendQuery(BILLING_SETTINGS_PATH, query);
}

export function buildBillingSettingsUrl(
  baseUrl?: string | null,
  query: BillingLinkQuery = {}
): string {
  return new URL(buildBillingSettingsPath(query), resolveBase(baseUrl)).toString();
}

export function buildPricingPath(query: BillingLinkQuery = {}): string {
  return appendQuery(PRICING_PATH, query);
}

export function buildPricingUrl(
  baseUrl?: string | null,
  query: BillingLinkQuery = {}
): string {
  return new URL(buildPricingPath(query), resolveBase(baseUrl)).toString();
}
