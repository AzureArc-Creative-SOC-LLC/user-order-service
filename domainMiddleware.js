// Resolves which storefront (public.domains row) an incoming request belongs
// to, and attaches req.domain / req.domainId for every downstream handler.
//
// Reads Origin, then Referer, then Host - in that priority order, matching
// the one other place this codebase already does domain detection
// (resolveBrandTheme in order-emails.js). Host is checked last only for
// completeness: this API sits behind a single shared nginx hostname
// (micoservices.tech) for every storefront, so Host will not actually carry
// the real brand domain in this deployment - Origin/Referer are what matter.
//
// Never rejects a request. Anything that can't be resolved (no header, an
// unknown host, an inactive domain) falls back to the default domain so
// server-to-server calls, webhooks, and health checks keep working.

function bareHost(value) {
  if (!value) return null;
  try {
    const url = value.includes('://') ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

const DEFAULT_DOMAIN_NAME = 'alluvi.store';
const CACHE_TTL_MS = 60_000;

function createDomainMiddleware({ lookupDomain, defaultDomainName = DEFAULT_DOMAIN_NAME }) {
  const cache = new Map(); // domain_name -> { id, status, cachedAt }
  let defaultId = null;

  async function resolve(name) {
    const hit = cache.get(name);
    if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) return hit;
    const row = await lookupDomain(name);
    if (row) cache.set(name, { ...row, cachedAt: Date.now() });
    return row || null;
  }

  return async function domainMiddleware(req, res, next) {
    try {
      const headers = req.headers || {};
      const candidate =
        bareHost(headers['origin']) ||
        bareHost(headers['referer'] || headers['referrer']) ||
        bareHost(headers['host']);

      const record = candidate ? await resolve(candidate) : null;

      if (record && record.status === 'active') {
        req.domain = candidate;
        req.domainId = record.id;
      } else {
        if (defaultId == null) {
          const def = await resolve(defaultDomainName);
          defaultId = def ? def.id : null;
        }
        req.domain = defaultDomainName;
        req.domainId = defaultId;
      }
    } catch (err) {
      console.error('[domainMiddleware] resolution failed, falling back to default:', err.message);
      req.domain = defaultDomainName;
      req.domainId = req.domainId ?? null;
    }
    next();
  };
}

export { createDomainMiddleware };
