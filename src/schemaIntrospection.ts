import { z } from 'zod';

export interface SchemaFieldDescriptor {
  type: string;
  required: boolean;
  nullable?: boolean;
  description?: string;
  enum?: string[];
  literal?: string | number | boolean;
  properties?: Record<string, SchemaFieldDescriptor>;
  items?: SchemaFieldDescriptor;
  anyOf?: SchemaFieldDescriptor[];
}

type UnwrappedSchema = {
  schema: z.ZodTypeAny;
  required: boolean;
  nullable: boolean;
};

function unwrapSchema(schema: z.ZodTypeAny): UnwrappedSchema {
  let current = schema;
  let required = true;
  let nullable = false;

  while (true) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
      required = false;
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodNullable) {
      nullable = true;
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    break;
  }

  return { schema: current, required, nullable };
}

function baseDescriptor(
  schema: z.ZodTypeAny,
  required: boolean,
  nullable: boolean,
  type: string
): SchemaFieldDescriptor {
  const description =
    typeof schema.description === 'string' && schema.description.length > 0
      ? schema.description
      : undefined;

  return {
    type,
    required,
    ...(nullable ? { nullable: true } : {}),
    ...(description ? { description } : {}),
  };
}

export function describeSchema(schema: z.ZodTypeAny): SchemaFieldDescriptor {
  const unwrapped = unwrapSchema(schema);
  const { schema: base, required, nullable } = unwrapped;

  if (base instanceof z.ZodString) {
    return baseDescriptor(base, required, nullable, 'string');
  }
  if (base instanceof z.ZodNumber) {
    return baseDescriptor(base, required, nullable, 'number');
  }
  if (base instanceof z.ZodBoolean) {
    return baseDescriptor(base, required, nullable, 'boolean');
  }
  if (base instanceof z.ZodEnum) {
    return {
      ...baseDescriptor(base, required, nullable, 'enum'),
      enum: base.options.map((option) => String(option)),
    };
  }
  if (base instanceof z.ZodLiteral) {
    return {
      ...baseDescriptor(base, required, nullable, 'literal'),
      literal: base.value as string | number | boolean,
    };
  }
  if (base instanceof z.ZodArray) {
    return {
      ...baseDescriptor(base, required, nullable, 'array'),
      items: describeSchema(base.element as z.ZodTypeAny),
    };
  }
  if (base instanceof z.ZodRecord) {
    return {
      ...baseDescriptor(base, required, nullable, 'record'),
      items: describeSchema(base.valueType as z.ZodTypeAny),
    };
  }
  if (base instanceof z.ZodObject) {
    return {
      ...baseDescriptor(base, required, nullable, 'object'),
      properties: describeInputShape(base.shape),
    };
  }
  if (base instanceof z.ZodUnion) {
    return {
      ...baseDescriptor(base, required, nullable, 'union'),
      anyOf: base.options.map((option) => describeSchema(option as z.ZodTypeAny)),
    };
  }
  if (base instanceof z.ZodUnknown) {
    return baseDescriptor(base, required, nullable, 'unknown');
  }
  if (base instanceof z.ZodAny) {
    return baseDescriptor(base, required, nullable, 'any');
  }

  return baseDescriptor(base, required, nullable, 'unknown');
}

export function describeInputShape(
  shape: Record<string, z.ZodTypeAny>
): Record<string, SchemaFieldDescriptor> {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [key, describeSchema(schema)])
  );
}
