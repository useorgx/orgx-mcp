import { WIDGET_OUTPUT_SCHEMAS } from './openaiOutputSchemas/widgets';

/** The API may add diagnostics before this worker advertises them to clients. */
export function projectExecutionReadiness(data: Record<string, unknown>): Record<string, unknown> {
  const { shape } = WIDGET_OUTPUT_SCHEMAS.check_execution_readiness;
  return Object.fromEntries(Object.entries(data).filter(([key]) => Object.hasOwn(shape, key)));
}
