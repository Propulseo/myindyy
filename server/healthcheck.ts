import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

export interface HealthcheckOptions {
  readonly host: string;
  readonly port: number;
  readonly secretFile: string;
  readonly timeoutMs?: number;
}

function mountedSecret(path: string): string {
  const value = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  if (Buffer.byteLength(value, 'utf8') < 32 || /[\r\n]/.test(value)) {
    throw new Error('Invalid mounted proxy secret');
  }
  return value;
}

function probeHealth(options: HealthcheckOptions, path: '/api/health/live' | '/api/health/ready'): Promise<void> {
  const secret = mountedSecret(options.secretFile);
  return new Promise((resolve, reject) => {
    const probe = request({
      host: '127.0.0.1',
      port: options.port,
      path,
      method: 'GET',
      headers: {
        Host: options.host,
        'X-Indy-User': 'etienne',
        'X-Indy-Proxy-Secret': secret,
      },
      timeout: options.timeoutMs ?? 5_000,
    }, (response) => {
      response.resume();
      response.once('end', () => {
        if (response.statusCode === 200) resolve();
        else reject(new Error(`Health probe returned HTTP ${response.statusCode ?? 0}`));
      });
    });
    probe.once('timeout', () => probe.destroy(new Error('Health probe timed out')));
    probe.once('error', reject);
    probe.end();
  });
}

export function probeLive(options: HealthcheckOptions): Promise<void> {
  return probeHealth(options, '/api/health/live');
}

export function probeReady(options: HealthcheckOptions): Promise<void> {
  return probeHealth(options, '/api/health/ready');
}

export function healthcheckOptionsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): HealthcheckOptions {
  const origin = new URL(environment.INDY_PUBLIC_ORIGIN ?? '');
  const port = Number.parseInt(environment.PORT ?? '6969', 10);
  const secretFile = environment.INDY_PROXY_SECRET_FILE ?? '';
  if (origin.protocol !== 'https:' || !origin.host || !Number.isInteger(port) || port < 1 || !secretFile) {
    throw new Error('Healthcheck configuration is incomplete');
  }
  return { host: origin.host, port, secretFile };
}

async function main(): Promise<void> {
  await probeLive(healthcheckOptionsFromEnvironment());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
