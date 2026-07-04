import axios from 'axios';

// Fengyu API Configuration
const FANGYU_API_URL = 'https://api-visitor.fangyu.io/check/41271/VQ389I2chU17OfqLz2';
const FANGYU_API_KEY = 'qCqXH8n5ArLZfljJVUxTG';

function getClientIpFromReq(req) {
  const remoteAddr = req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip;

  // Similar intent to PHP core.php: only trust forwarded headers when the request is
  // coming through a known proxy/CDN (Cloudflare).
  const isLikelyCloudflare = !!(
    req.headers['cf-connecting-ip'] ||
    req.headers['cf-ray'] ||
    req.headers['cf-visitor']
  );

  if (!isLikelyCloudflare) {
    return remoteAddr;
  }

  const cfConnectingIp = req.headers['cf-connecting-ip'];
  if (cfConnectingIp) return String(cfConnectingIp);

  const trueClientIp = req.headers['true-client-ip'];
  if (trueClientIp) return String(trueClientIp);

  const xRealIp = req.headers['x-real-ip'];
  if (xRealIp) return String(xRealIp);

  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) return String(xForwardedFor).split(',')[0].trim();

  return remoteAddr;
}

function buildPhpStyleQueryString(params) {
  const keys = Object.keys(params).sort();
  const usp = new URLSearchParams();
  for (const k of keys) {
    usp.append(k, String(params[k] ?? ''));
  }
  return usp.toString();
}

/**
 * Generate SHA256 signature for Fengyu API
 */
async function generateSign(params) {
  // Match PHP core.php: sha256(http_build_query(sorted_params) . API_KEY)
  const queryString = buildPhpStyleQueryString(params);
  const stringToSign = queryString + FANGYU_API_KEY;
  
  // Generate SHA256 hash using Node.js crypto
  const crypto = await import('crypto');
  const hash = crypto.createHash('sha256').update(stringToSign).digest('hex');
  return hash;
}

/**
 * Proxy endpoint for Fengyu API to avoid CORS issues
 */
export async function fengyuProxy(req, res) {
  try {
    console.log('[Fengyu-Proxy] Received request:', {
      method: req.method,
      headers: req.headers,
      body: req.body
    });

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { userAgent, visitUrl, clientLanguage, referer, timestamp } = req.body;

    if (!userAgent || !visitUrl || !timestamp) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['userAgent', 'visitUrl', 'timestamp']
      });
    }

    // Prepare request data
    const computedIp = getClientIpFromReq(req);
    const params = {
      clientIp: String(computedIp || '0.0.0.0').slice(0, 50),
      userAgent: String(userAgent).slice(0, 500),
      visitUrl: String(visitUrl).slice(0, 500),
      clientLanguage: String(clientLanguage || '').slice(0, 100),
      referer: String(referer || '').slice(0, 500),
      timestamp: Number(timestamp)
    };

    console.log('[Fengyu-Proxy] Prepared request data:', params);

    // Generate signature
    const sign = await generateSign(params);
    const requestData = { ...params, sign };

    console.log('[Fengyu-Proxy] Making request to Fengyu API:', FANGYU_API_URL);
    console.log('[Fengyu-Proxy] Request payload:', {
      ...requestData,
      sign: requestData.sign.slice(0, 20) + '...'
    });

    // Make request to Fengyu API
    const response = await axios.post(FANGYU_API_URL, requestData, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Alluvi-Server/1.0'
      },
      timeout: 16000
    });

    console.log('[Fengyu-Proxy] ✅ Fengyu API response:', {
      status: response.status,
      data: response.data
    });

    // Return the response
    res.status(response.status).json(response.data);

  } catch (error) {
    console.error('[Fengyu-Proxy] ❌ Error:', error);
    
    if (error.response) {
      console.error('[Fengyu-Proxy] API Error Response:', {
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers
      });
      res.status(error.response.status).json(error.response.data);
    } else if (error.request) {
      console.error('[Fengyu-Proxy] No response received:', error.message);
      res.status(503).json({ 
        error: 'Service unavailable',
        message: 'Failed to connect to Fengyu API'
      });
    } else {
      console.error('[Fengyu-Proxy] Request setup error:', error.message);
      res.status(500).json({ 
        error: 'Internal server error',
        message: error.message
      });
    }
  }
}
