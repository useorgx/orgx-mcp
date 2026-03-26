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
      current = current._def.innerType;
      continue;
    }
    if (current instanceof z.ZodNullable) {
      nullable = true;
      current = current._def.innerType;
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
      enum: [...base.options],
    };
  }
  if (base instanceof z.ZodLiteral) {
    return {
      ...baseDescriptor(base, required, nullable, 'literal'),
      literal: base._def.value as string | number | boolean,
    };
  }
  if (base instanceof z.ZodArray) {
    return {
      ...baseDescriptor(base, required, nullable, 'array'),
      items: describeSchema(base._def.type),
    };
  }
  if (base instanceof z.ZodRecord) {
    return {
      ...baseDescriptor(base, required, nullable, 'record'),
      items: describeSchema(base._def.valueType),
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
      anyOf: base._def.options.map((option: z.ZodTypeAny) => describeSchema(option)),
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
