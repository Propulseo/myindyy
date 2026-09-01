import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import type { Request, RequestHandler } from 'express';

export const ETIENNE_ACTOR = Object.freeze({ id: 'etienne' as const });
export const INDY_USER_HEADER = 'X-Indy-User';
export const INDY_PROXY_SECRET_HEADER = 'X-Indy-Proxy-Secret';

export interface EtienneActor {
  readonly id: 'etienne';
}

declare global {
  namespace Express {
    interface Request {
      actor: EtienneActor;
    }
  }
}

export interface EtienneAuthOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly getRemoteAddress?: (request: Request) => string | undefined;
}

type AddressFamily = 'ipv4' | 'ipv6';

interface NetworkAddress {
  readonly address: string;
  readonly family: AddressFamily;
}

interface PrivateNetwork extends NetworkAddress {
  readonly prefix: number;
}

interface ProxyTrust {
  readonly blockList: BlockList;
  readonly ready: boolean;
}

interface CanonicalPublicOrigin {
  readonly host: string;
  readonly origin: string;
}

interface SingleHeader {
  readonly present: boolean;
  readonly value: string | null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const PRIVATE_NETWORKS: readonly PrivateNetwork[] = [
  { address: '10.0.0.0', family: 'ipv4', prefix: 8 },
  { address: '172.16.0.0', family: 'ipv4', prefix: 12 },
  { address: '192.168.0.0', family: 'ipv4', prefix: 16 },
  { address: '127.0.0.0', family: 'ipv4', prefix: 8 },
  { address: '169.254.0.0', family: 'ipv4', prefix: 16 },
  { address: 'fc00::', family: 'ipv6', prefix: 7 },
  { address: 'fe80::', family: 'ipv6', prefix: 10 },
  { address: '::1', family: 'ipv6', prefix: 128 },
];

const PRIVATE_BLOCKS = PRIVATE_NETWORKS.map((network) => {
  const blockList = new BlockList();
  blockList.addSubnet(network.address, network.prefix, network.family);
  return { blockList, network };
});

function normalizeAddress(rawAddress: string | undefined): NetworkAddress | null {
  if (!rawAddress) return null;
  const address = rawAddress.split('%', 1)[0].toLowerCase();
  if (address.startsWith('::ffff:')) {
    const ipv4 = address.slice('::ffff:'.length);
    if (isIP(ipv4) === 4) return { address: ipv4, family: 'ipv4' };
  }
  const version = isIP(address);
  if (version === 4) return { address, family: 'ipv4' };
  if (version === 6) return { address, family: 'ipv6' };
  return null;
}

function isPrivateSubnet(address: NetworkAddress, prefix: number): boolean {
  return PRIVATE_BLOCKS.some(({ blockList, network }) => (
    network.family === address.family
      && prefix >= network.prefix
      && blockList.check(address.address, address.family)
  ));
}

function parseTrustedProxyCidrs(value: string | undefined): ProxyTrust {
  const blockList = new BlockList();
  const entries = value?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
  if (entries.length === 0) return { blockList, ready: false };

  try {
    for (const entry of entries) {
      const slash = entry.lastIndexOf('/');
      const rawAddress = slash === -1 ? entry : entry.slice(0, slash);
      const normalized = normalizeAddress(rawAddress);
      if (!normalized) return { blockList: new BlockList(), ready: false };
      const maxPrefix = normalized.family === 'ipv4' ? 32 : 128;
      const prefixText = slash === -1 ? String(maxPrefix) : entry.slice(slash + 1);
      if (!/^\d+$/.test(prefixText)) return { blockList: new BlockList(), ready: false };
      const prefix = Number(prefixText);
      if (prefix < 0 || prefix > maxPrefix || !isPrivateSubnet(normalized, prefix)) {
        return { blockList: new BlockList(), ready: false };
      }
      blockList.addSubnet(normalized.address, prefix, normalized.family);
    }
  } catch {
    return { blockList: new BlockList(), ready: false };
  }

  return { blockList, ready: true };
}

function readMountedSecret(filePath: string | undefined): string | null {
  if (!filePath || !isAbsolute(filePath)) return null;
  try {
    const file = readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(file, 'utf8') > 4096) return null;
    const secret = file.replace(/\r?\n$/, '');
    if (/[\r\n]/.test(secret) || Buffer.byteLength(secret, 'utf8') < 32) return null;
    return secret;
  } catch {
    return null;
  }
}

function secretsMatch(expected: string, presented: string): boolean {
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const presentedDigest = createHash('sha256').update(presented, 'utf8').digest();
  return timingSafeEqual(expectedDigest, presentedDigest);
}

function isLoopback(rawAddress: string | undefined): boolean {
  const address = normalizeAddress(rawAddress);
  if (!address) return false;
  return PRIVATE_BLOCKS.some(({ blockList, network }) => (
    (network.address === '127.0.0.0' || network.address === '::1')
      && network.family === address.family
      && blockList.check(address.address, address.family)
  ));
}

function isTrustedProxy(trust: ProxyTrust, rawAddress: string | undefined): boolean {
  const address = normalizeAddress(rawAddress);
  return Boolean(address && trust.ready && trust.blockList.check(address.address, address.family));
}

function parseCanonicalPublicOrigin(value: string | undefined): CanonicalPublicOrigin | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || value !== parsed.origin) {
      return null;
    }
    return { host: parsed.host, origin: parsed.origin };
  } catch {
    return null;
  }
}

function singleHeader(request: Request, name: string): SingleHeader {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name.toLowerCase()) {
      values.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  if (values.length === 0) return { present: false, value: null };
  const [value] = values;
  if (values.length !== 1 || !value || value.includes(',')) {
    return { present: true, value: null };
  }
  return { present: true, value };
}

function normalizedRequestOrigin(request: Request, environment: NodeJS.ProcessEnv): string | null {
  const host = singleHeader(request, 'Host').value;
  if (!host) return null;
  try {
    const scheme = environment.NODE_ENV === 'development' ? 'http' : 'https';
    const url = new URL(`${scheme}://${host}`);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isBrowserRequestAllowed(
  request: Request,
  environment: NodeJS.ProcessEnv,
  publicOrigin: CanonicalPublicOrigin | null,
): boolean {
  const hostHeader = singleHeader(request, 'Host');
  const originHeader = singleHeader(request, 'Origin');
  const fetchSite = request.get('Sec-Fetch-Site');

  if (!hostHeader.value) return false;
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') return false;

  if (originHeader.present) {
    const origin = originHeader.value;
    if (!origin) return false;
    if (fetchSite !== 'same-origin') return false;
    try {
      const parsed = new URL(origin);
      const expectedProtocol = environment.NODE_ENV === 'development' ? 'http:' : 'https:';
      if (parsed.protocol !== expectedProtocol || parsed.origin !== origin) return false;
      if (environment.NODE_ENV === 'development') {
        return parsed.origin === normalizedRequestOrigin(request, environment);
      }
      return publicOrigin !== null
        && origin === publicOrigin.origin
        && hostHeader.value === publicOrigin.host;
    } catch {
      return false;
    }
  }

  if (!SAFE_METHODS.has(request.method.toUpperCase()) && fetchSite !== undefined) return false;
  return true;
}

export function createRequireEtienne(options: EtienneAuthOptions = {}): RequestHandler {
  const environment = options.environment ?? process.env;
  const proxyTrust = parseTrustedProxyCidrs(environment.INDY_TRUSTED_PROXY_CIDRS);
  const transportSecret = readMountedSecret(environment.INDY_PROXY_SECRET_FILE);
  const publicOrigin = parseCanonicalPublicOrigin(environment.INDY_PUBLIC_ORIGIN);
  const configurationReady = proxyTrust.ready
    && transportSecret !== null
    && (environment.NODE_ENV === 'development' || publicOrigin !== null);
  const getRemoteAddress = options.getRemoteAddress ?? ((request: Request) => request.socket.remoteAddress);

  return (request, response, next) => {
    const remoteAddress = getRemoteAddress(request);
    const developmentBypass = environment.NODE_ENV === 'development'
      && environment.INDY_DEV_ACTOR === 'etienne'
      && isLoopback(remoteAddress);

    const continueAsEtienne = () => {
      if (!isBrowserRequestAllowed(request, environment, publicOrigin)) {
        response.status(403).json({ error: 'Forbidden' });
        return;
      }
      request.actor = ETIENNE_ACTOR;
      next();
    };

    if (developmentBypass) {
      continueAsEtienne();
      return;
    }

    if (!configurationReady) {
      response.status(503).json({ error: 'Authentication unavailable' });
      return;
    }

    const presentedSecret = request.get(INDY_PROXY_SECRET_HEADER) ?? '';
    const trustedTransport = isTrustedProxy(proxyTrust, remoteAddress)
      && secretsMatch(transportSecret, presentedSecret);
    if (!trustedTransport) {
      response.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = request.get(INDY_USER_HEADER);
    if (!user) {
      response.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (user !== ETIENNE_ACTOR.id) {
      response.status(403).json({ error: 'Forbidden' });
      return;
    }

    continueAsEtienne();
  };
}

export const requireEtienne: RequestHandler = createRequireEtienne();
