import type { LogLevel, LogEnvelope, ErrorDetail } from "./envelope";
import { getConfig } from "./config";
import { getContext, type RequestContext } from "./context";

export interface LogOptions {
  error?: Error;
  extra?: Record<string, unknown>;
  agent?: Record<string, unknown>;
}

export class RubotLogger {
  private component: string;
  private contextKey: object | null;

  constructor(component: string, contextKey?: object) {
    this.component = component;
    this.contextKey = contextKey ?? null;
  }

  withContext(key: object): RubotLogger {
    return new RubotLogger(this.component, key);
  }

  private emit(
    level: LogLevel,
    eventType: string,
    message: string,
    opts?: LogOptions,
  ): void {
    const cfg = getConfig();
    const ctx: RequestContext | null = this.contextKey
      ? getContext(this.contextKey)
      : null;

    let errDetail: ErrorDetail | undefined;
    if (opts?.error) {
      errDetail = {
        type: opts.error.constructor.name,
        message: opts.error.message,
        stack: opts.error.stack,
      };
    }

    const envelope: LogEnvelope = {
      timestamp: new Date().toISOString(),
      log_level: level,
      service: cfg.service,
      component: this.component,
      environment: cfg.environment,
      deployment_hash: cfg.deploymentHash,
      tenant_id: ctx?.tenantId ?? null,
      sender_id: ctx?.senderId ?? null,
      chat_source_session_id: ctx?.chatSourceSessionId ?? null,
      trace_id: ctx?.traceId ?? null,
      event_type: eventType,
      message,
      error: errDetail ?? null,
      extra: opts?.extra ?? {},
      agent: opts?.agent ?? null,
    };

    const clean = Object.fromEntries(
      Object.entries(envelope).filter(([, v]) => v !== null && v !== undefined),
    );
    const line = JSON.stringify(clean);

    switch (level) {
      case "ERROR":
        console.error(line);
        break;
      case "WARN":
        console.warn(line);
        break;
      case "DEBUG":
        console.debug(line);
        break;
      default:
        console.log(line);
        break;
    }
  }

  debug(eventType: string, message: string, opts?: LogOptions): void {
    this.emit("DEBUG", eventType, message, opts);
  }

  info(eventType: string, message: string, opts?: LogOptions): void {
    this.emit("INFO", eventType, message, opts);
  }

  warn(eventType: string, message: string, opts?: LogOptions): void {
    this.emit("WARN", eventType, message, opts);
  }

  error(eventType: string, message: string, opts?: LogOptions): void {
    this.emit("ERROR", eventType, message, opts);
  }
}

export function getLogger(component: string): RubotLogger {
  return new RubotLogger(component);
}
