import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { describeInputShape } from '../src/schemaIntrospection';

describe('schema introspection', () => {
  it('describes enums, optional fields, arrays, and records', () => {
    const descriptor = describeInputShape({
      title: z.string().describe('Title'),
      priority: z
        .enum(['low', 'medium', 'high'])
        .optional()
        .describe('Priority'),
      tags: z.array(z.string()).optional(),
      metadata: z.record(z.unknown()).optional(),
    });

    expect(descriptor.title).toMatchObject({
      type: 'string',
      required: true,
      description: 'Title',
    });
    expect(descriptor.priority).toMatchObject({
      type: 'enum',
      required: false,
      enum: ['low', 'medium', 'high'],
    });
    expect(descriptor.tags).toMatchObject({
      type: 'array',
      required: false,
      items: expect.objectContaining({ type: 'string' }),
    });
    expect(descriptor.metadata).toMatchObject({
      type: 'record',
      required: false,
    });
  });
});
