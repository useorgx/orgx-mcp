export const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self' https://*.clerk.accounts.dev https://clerk.useorgx.com https://accounts.useorgx.com",
    "img-src 'self' data: https:",
    "font-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline' https:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
    "connect-src 'self' https://mcp.useorgx.com https://useorgx.com https://www.useorgx.com https://*.useorgx.com https://*.clerk.accounts.dev https://clerk.useorgx.com https://accounts.useorgx.com wss:",
    "worker-src 'self' blob:",
    "frame-src 'self' https://*.clerk.accounts.dev https://clerk.useorgx.com https://accounts.useorgx.com",
    'upgrade-insecure-requests',
  ].join('; '),
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)',
} as const;

export function withSecurityHeaders(response: Response): Response {
  if (response.status === 101) {
    return response;
  }

  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
