import { describe, expect, it } from 'vitest';

import {
  resolveAllowedMcpOrigins,
  validateMcpRequestOrigin,
} from '../src/mcpOriginValidation';

const productionEnv = {
  MCP_SERVER_URL: 'https://mcp.useorgx.com',
  ORGX_WEB_URL: 'https://useorgx.com',
};

describe('MCP Origin validation', () => {
  it('supports no-Origin CLI and server-to-server clients', () => {
    expect(
      validateMcpRequestOrigin(
        new Request('https://mcp.useorgx.com/mcp', { method: 'POST' }),
        productionEnv
      )
    ).toBeNull();
  });

  it.each([
    'https://mcp.useorgx.com',
    'https://useorgx.com',
    'https://www.useorgx.com',
    'https://claude.ai',
    'https://chatgpt.com',
    'https://chat.openai.com',
  ])('allows trusted hosted client origin %s', (origin) => {
    expect(
      validateMcpRequestOrigin(
        new Request('https://mcp.useorgx.com/mcp', {
          method: 'POST',
          headers: { Origin: origin },
        }),
        productionEnv
      )
    ).toBeNull();
  });

  it('allows explicitly configured additional origins', () => {
    const allowed = resolveAllowedMcpOrigins({
      ...productionEnv,
      MCP_ALLOWED_ORIGINS:
        'https://connector.example.com, https://review.example.com',
    });
    expect(allowed).toContain('https://connector.example.com');
    expect(allowed).toContain('https://review.example.com');
  });

  it.each(['https://attacker.example', 'null', 'not a URL'])(
    'rejects invalid present Origin %s with HTTP 403',
    async (origin) => {
      const response = validateMcpRequestOrigin(
        new Request('https://mcp.useorgx.com/mcp', {
          method: 'POST',
          headers: { Origin: origin },
        }),
        productionEnv
      );

      expect(response?.status).toBe(403);
      expect(response?.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(response?.headers.get('x-orgx-mcp-error-code')).toBe(
        'invalid_origin'
      );
      await expect(response?.json()).resolves.toMatchObject({
        error: { data: { code: 'invalid_origin' } },
      });
    }
  );

  it('allows cross-port loopback browser development without trusting it in production', () => {
    const localRequest = new Request('http://127.0.0.1:8787/mcp', {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(validateMcpRequestOrigin(localRequest, {})).toBeNull();

    const productionRequest = new Request('https://mcp.useorgx.com/mcp', {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(validateMcpRequestOrigin(productionRequest, productionEnv)?.status).toBe(
      403
    );
  });
});
