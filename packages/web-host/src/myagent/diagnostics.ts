import type { JsonObject } from './gateway.js';

export type GatewayHealth = {
  ok: boolean;
  status: string;
  inFlightModelCalls: number;
  pendingRequests: number;
  processingRequests: number;
};

/** Build a Gateway /control body with a stable, caller-supplied message identity. */
export function buildGatewayControlPayload(
  command: '/stop' | '/steer' | '/new',
  conversationId: string,
  messageId: string,
  goal?: string,
): JsonObject {
  if (!['/stop', '/steer', '/new'].includes(command) || !conversationId.trim() || !messageId.trim()) {
    throw new Error('INVALID_GATEWAY_CONTROL_INPUT');
  }
  return {
    command,
    conversation_id: conversationId,
    metadata: { message_id: messageId },
    ...(goal?.trim() ? { goal } : {}),
  };
}

function objectOf(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function countOf(value: unknown): number {
  const count = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

/** Normalize flat and grouped Gateway /status counters without coercing truthy health flags. */
export function summarizeGatewayHealth(statusPayload: JsonObject): GatewayHealth {
  const modelCalls = objectOf(statusPayload.model_calls);
  const activity = objectOf(statusPayload.model_call_activity);
  const requests = objectOf(statusPayload.requests);
  const queue = objectOf(statusPayload.queue);
  return {
    ok: statusPayload.ok === true,
    status: typeof statusPayload.status === 'string' && statusPayload.status.trim() ? statusPayload.status : 'unknown',
    inFlightModelCalls: countOf(statusPayload.in_flight_model_calls ?? modelCalls.in_flight ?? activity.in_flight_count),
    pendingRequests: countOf(statusPayload.pending_requests ?? requests.pending ?? queue.pending),
    processingRequests: countOf(statusPayload.processing_requests ?? requests.processing ?? queue.processing),
  };
}
