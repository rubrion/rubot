export interface LoggerConfig {
  service: string;
  environment: string;
  deploymentHash: string;
}

let _config: LoggerConfig | null = null;

export function configure(
  config: Partial<LoggerConfig> & { service: string },
): LoggerConfig {
  _config = {
    service: config.service,
    environment: config.environment ?? "dev",
    deploymentHash: config.deploymentHash ?? "",
  };
  return _config;
}

export function getConfig(): LoggerConfig {
  if (!_config) {
    throw new Error(
      "@rubot/logger not configured. Call configure() first.",
    );
  }
  return _config;
}
