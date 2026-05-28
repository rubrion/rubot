export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface ErrorDetail {
  type: string;
  message: string;
  stack?: string;
}

export interface LogEnvelope {
  timestamp: string;
  log_level: LogLevel;
  service: string;
  component: string;
  environment: string;
  deployment_hash: string;
  tenant_id?: string | null;
  sender_id?: string | null;
  chat_source_session_id?: string | null;
  trace_id?: string | null;
  span_id?: string | null;
  event_type: string;
  message: string;
  error?: ErrorDetail | null;
  extra?: Record<string, unknown>;
  agent?: Record<string, unknown> | null;
}
