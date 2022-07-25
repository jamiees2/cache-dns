import * as dns from 'dns';
import * as ipaddr from 'ipaddr.js';
import * as os from 'os';

type CacheDnsDefaults = {
  defaultFamily: number | undefined;
  defaultHints: number | undefined;
};

interface DnsRecord extends dns.RecordWithTtl {
  family: LookupType;
}

interface StrictLookupOptions extends dns.LookupOptions {
  family: LookupType;
}

type AddressCacheEntry = {
  records: DnsRecord[];
  expiry: number;
};

class AddressCache {
  private cache = new Map<string, AddressCacheEntry>();

  get(key: string): DnsRecord[] | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }
    const {records, expiry} = entry;
    if (records.length === 0 || expiry <= Date.now()) {
      this.cache.delete(key);
      return null;
    }

    return records;
  }

  set(key: string, records: DnsRecord[]) {
    if (records.length === 0) {
      return;
    }
    const expiry = Math.min(
      ...records.map(record => Date.now() + record.ttl * 1000)
    );
    this.cache.set(key, {
      records: records,
      expiry: expiry,
    });
  }
}

let cacheDnsDefaults: CacheDnsDefaults = {
  defaultFamily: undefined,
  defaultHints: undefined,
};
const addressCache = new AddressCache();

// dns.NODATA and dns.NONAME errors are internally translated by lookup() to ENOTFOUND
const makeNotFoundError = (
  code: number | undefined,
  syscall: string,
  hostname?: string
): NodeJS.ErrnoException => {
  const message = `${syscall} ${code}${hostname ? ` ${hostname}` : ''}`;
  const error = new Error(message) as NodeJS.ErrnoException;

  error.code = dns.NOTFOUND;
  error.errno = code;
  error.syscall = syscall;
  if (hostname) {
    (error as any).hostname = hostname;
  }

  return error;
};

enum LookupType {
  IPv4 = 4,
  IPv6 = 6,
}

function lookup(
  hostname: string,
  family: number,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string,
    family: number
  ) => void
): void;
function lookup(
  hostname: string,
  options: dns.LookupOneOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string,
    family: number
  ) => void
): void;
function lookup(
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    addresses: dns.LookupAddress[]
  ) => void
): void;
function lookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family: number
  ) => void
): void;
function lookup(
  hostname: string,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string,
    family: number
  ) => void
): void;

function lookup(
  hostname: string,
  callbackOrOptionsOrFamily: any,
  callback?: Function
) {
  let options: dns.LookupOptions;
  if (typeof callbackOrOptionsOrFamily === 'number') {
    options = {family: callbackOrOptionsOrFamily};
  } else if (typeof callbackOrOptionsOrFamily === 'function') {
    callback = callbackOrOptionsOrFamily;
    options = {};
  } else {
    options = callbackOrOptionsOrFamily;
  }

  if (typeof callback !== 'function') {
    throw new Error('callback must be a function');
  }
  // typescript ignores the above type guard for future callbacks
  const strictCallback = callback;

  lookupPromise(hostname, options).then(
    (result: dns.LookupAddress | dns.LookupAddress[]) => {
      if (Array.isArray(result)) {
        strictCallback(null, result);
      } else {
        strictCallback(null, result.address, result.family);
      }
    },
    err => strictCallback(err)
  );
}

function lookupPromise(
  hostname: string,
  options: dns.LookupAllOptions
): Promise<dns.LookupAddress[]>;
function lookupPromise(
  hostname: string,
  options?: dns.LookupOneOptions | number
): Promise<dns.LookupAddress>;
function lookupPromise(
  hostname: string,
  options: dns.LookupOptions
): Promise<dns.LookupAddress | dns.LookupAddress[]>;

async function lookupPromise(
  hostname: string,
  optionsOrFamily?: any
): Promise<dns.LookupAddress | dns.LookupAddress[]> {
  let options: dns.LookupOptions;
  if (typeof optionsOrFamily === 'number') {
    options = {family: optionsOrFamily};
  } else if (!optionsOrFamily) {
    options = {};
  } else {
    options = optionsOrFamily;
  }

  if (!options.family) {
    options.family = cacheDnsDefaults.defaultFamily;
  }
  if (!options.hints) {
    options.hints = cacheDnsDefaults.defaultHints;
  }

  // TODO: DEP0118
  if (!hostname) {
    const family =
      options.family === LookupType.IPv6 ? LookupType.IPv6 : LookupType.IPv4;
    if (options.all) {
      return [];
    } else {
      return {
        address: null as unknown as string, // not great but this is what dns.promises.lookup returns
        family,
      };
    }
  }

  if (options.hints && options.hints & dns.ADDRCONFIG) {
    const supportedFamilies = getSupportedFamilies();
    if (supportedFamilies !== undefined) {
      if (!options.family) {
        options.family = supportedFamilies;
      } else if (options.family !== supportedFamilies) {
        // If we specified a family, and we can't support it with this lookup, reject
        throw makeNotFoundError(undefined, 'getaddrinfo', hostname);
      }
    }
  }
  const resultHandler = (results: dns.LookupAddress[]) =>
    options.all ? results : results[0];
  // Handle getaddrinfo flags
  if (
    options.family === LookupType.IPv6 &&
    options.hints &&
    options.hints & dns.V4MAPPED
  ) {
    return await resolveBoth(hostname, options)
      .then(results => mapAddresses(results, options))
      .then(resultHandler);
  }
  switch (options.family) {
    case LookupType.IPv4:
    case LookupType.IPv6:
      return await resolve(hostname, options as StrictLookupOptions).then(
        resultHandler
      );
    case undefined:
      return await resolveBoth(hostname, options).then(resultHandler);
    default:
      throw new Error('invalid family number');
  }
}

const pendingLookups = new Map<string, Promise<DnsRecord[]>>();

const resolve = async (
  hostname: string,
  options: StrictLookupOptions
): Promise<dns.LookupAddress[]> => {
  const key = `${hostname}_${options.family}`;
  let records = addressCache.get(key);
  if (records === null) {
    let pendingPromise = pendingLookups.get(key);
    if (!pendingPromise) {
      const resolveFunc =
        options.family === LookupType.IPv6
          ? dns.promises.resolve6
          : dns.promises.resolve4;
      pendingPromise = resolveFunc(hostname, {ttl: true}).then(records => {
        if (records.length === 0) {
          // We got no records back, this is a getaddrinfo ENOTFOUND
          // note that resolve(4|6) handles errors differently than getaddrinfo, most importantly, it's perfectly fine to have a domain that resolves to *something*, just not an A record.
          throw makeNotFoundError(undefined, 'getaddrinfo', hostname);
        }
        return records.map(record => ({...record, family: options.family}));
      });
      pendingLookups.set(key, pendingPromise);

      pendingPromise
        .then(
          records => addressCache.set(key, records),
          () => {}
        )
        .finally(() => pendingLookups.delete(key));
    }
    try {
      records = await pendingPromise;
    } catch (e: any) {
      if (e && (e.code === dns.NODATA || e.code === dns.NONAME)) {
        throw makeNotFoundError(e.code, e.syscall, hostname);
      }
      throw e;
    }
  }

  if (options.all) {
    return records.map(record => ({
      address: record.address,
      family: record.family,
    }));
  } else {
    const record = roundRobin(records);
    if (!record) {
      return [];
    }
    return [
      {
        address: record.address,
        family: record.family,
      },
    ];
  }
};

const resolveBoth = async (
  hostname: string,
  options: dns.LookupOptions
): Promise<dns.LookupAddress[]> => {
  const wrapNotFound = async (
    promise: Promise<dns.LookupAddress[]>
  ): Promise<dns.LookupAddress[]> => {
    try {
      return await promise;
    } catch (e: any) {
      if (e && e.code === dns.NOTFOUND) {
        return [];
      }
      throw e;
    }
  };

  return Promise.all([
    wrapNotFound(resolve(hostname, {...options, family: LookupType.IPv4})),
    wrapNotFound(resolve(hostname, {...options, family: LookupType.IPv6})),
  ]).then(records => {
    const [v4records, v6records] = records;
    let result: dns.LookupAddress[];
    if (options.all) {
      result = v4records.concat(v6records);
    } else if (v4records.length > 0) {
      result = v4records;
    } else {
      result = v6records;
    }

    if (result.length === 0) {
      throw makeNotFoundError(undefined, 'getaddrinfo', hostname);
    }
    return result;
  });
};

const roundRobin = <T>(arr: T[]): T | undefined => {
  if (arr.length === 0) {
    return undefined;
  }
  const arrWithRR = arr as T[] & {_rr?: number};
  if (arrWithRR._rr === undefined || arrWithRR._rr === null) {
    arrWithRR._rr = 0;
    return arr[0];
  }
  if (arrWithRR.length === 1) {
    return arr[0];
  }

  if (arrWithRR._rr >= arr.length - 1 || arrWithRR._rr < 0) {
    arrWithRR._rr = 0;
    return arr[0];
  } else {
    arrWithRR._rr++;
    return arr[arrWithRR._rr];
  }
};

const mapAddresses = (
  results: dns.LookupAddress[],
  options: dns.LookupOptions
): dns.LookupAddress[] => {
  const pushBothv4Andv4Mapped = !!options.hints && !!(options.hints & dns.ALL);
  const newResults: dns.LookupAddress[] = [];
  for (const result of results) {
    if (result.family === LookupType.IPv6) {
      newResults.push(result);
      continue;
    }
    if (pushBothv4Andv4Mapped) {
      newResults.push(result);
    }

    const parsedAddr = ipaddr.parse(result.address) as ipaddr.IPv4;
    newResults.push({
      address: parsedAddr.toIPv4MappedAddress().toString(),
      family: LookupType.IPv6,
    });
  }
  return newResults;
};

let cachedSupportedFamilies: LookupType | undefined | null = null;
const getSupportedFamilies = (): LookupType | undefined => {
  if (cachedSupportedFamilies === null) {
    const supported = new Set<LookupType>();
    Object.values(os.networkInterfaces()).forEach(
      (iface: os.NetworkInterfaceInfo[] | undefined) => {
        if (!iface) {
          return;
        }
        iface.forEach((net: os.NetworkInterfaceInfo) => {
          // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
          if (net.internal) {
            return;
          }
          // 'IPv4' is in Node <= 17, from 18 it's a number 4 or 6
          const familyV4Value = typeof net.family === 'string' ? 'IPv4' : 4;
          const familyV6Value = typeof net.family === 'string' ? 'IPv6' : 6;
          if (net.family === familyV4Value) {
            supported.add(LookupType.IPv4);
          } else if (net.family === familyV6Value) {
            supported.add(LookupType.IPv6);
          }
        });
      }
    );
    if (supported.size === 0 || supported.size === 2) {
      cachedSupportedFamilies = undefined;
      return undefined;
    } else {
      const result = supported.entries().next().value;
      cachedSupportedFamilies = result;
      return result;
    }
  } else {
    return cachedSupportedFamilies;
  }
};

const clearSupportedFamilies = () => {
  cachedSupportedFamilies = null;
};

const patchDnsLookup = () => {
  const dnsLib = require('dns');
  dnsLib.uncachedLookup = dnsLib.lookup;
  dnsLib.lookup = lookup;
  dnsLib.promises.uncachedLookup = dnsLib.promises.lookup;
  dnsLib.promises.lookup = lookupPromise;
};

const unpatchDnsLookup = () => {
  const dnsLib = require('dns');
  dnsLib.lookup = dnsLib.uncachedLookup;
  dnsLib.promises.lookup = dnsLib.promises.uncachedLookup;
};

const setDefaults = (defaults: Partial<CacheDnsDefaults>) => {
  cacheDnsDefaults = {...cacheDnsDefaults, ...defaults};
};

export {
  lookup,
  lookupPromise,
  patchDnsLookup,
  unpatchDnsLookup,
  setDefaults,
  clearSupportedFamilies,
};
