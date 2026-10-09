import { describeConfig, loadConfig, type ConfigSchema } from '@xo/config';

const cliConfigSchema = {
  logLevel: { type: 'enum', values: ['trace', 'debug', 'info', 'warn', 'error'] as const, default: 'info' },
  registryUrl: { type: 'string', default: 'https://registry.xo.invalid' },
} as const satisfies ConfigSchema;

export function configShowCommand(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const config = loadConfig(cliConfigSchema, { env });
  return describeConfig(cliConfigSchema, config);
}
