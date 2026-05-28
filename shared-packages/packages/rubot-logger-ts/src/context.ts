export interface RequestContext {
  traceId: string | null;
  tenantId: string | null;
  chatSourceSessionId: string | null;
  senderId: string | null;
}

const contextStore = new WeakMap<object, RequestContext>();

export function setContext(key: object, ctx: RequestContext): void {
  contextStore.set(key, ctx);
}

export function getContext(key: object): RequestContext | null {
  return contextStore.get(key) ?? null;
}

export function createEmptyContext(): RequestContext {
  return {
    traceId: null,
    tenantId: null,
    chatSourceSessionId: null,
    senderId: null,
  };
}
