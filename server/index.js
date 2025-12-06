// index.js (Render-ready, robust validation + debug)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.NOWPAYMENTS_API_KEY || '').trim();
const NOW_API_BASE = 'https://api.nowpayments.io/v1';

// helper: safe trim + validate URL
function safeUrlFromEnv(envVar) {
  if (!envVar) return null;
  const trimmed = String(envVar).trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch (e) {
    return null;
  }
}

// Pre-validate SUCCESS_URL / CANCEL_URL from env (they may be invalid in env)
const SUCCESS_URL = safeUrlFromEnv(process.env.SUCCESS_URL);
const CANCEL_URL = safeUrlFromEnv(process.env.CANCEL_URL);
if (process.env.SUCCESS_URL && !SUCCESS_URL) {
  console.warn('[WARN] SUCCESS_URL env is set but is NOT a valid http(s) URL:', process.env.SUCCESS_URL);
}
if (process.env.CANCEL_URL && !CANCEL_URL) {
  console.warn('[WARN] CANCEL_URL env is set but is NOT a valid http(s) URL:', process.env.CANCEL_URL);
}

// Helper: allow explicit FRONTEND_ORIGIN (prod) OR any localhost/127.0.0.1 origin (dev)
function isAllowedOrigin(origin) {
  if (!origin) return true; // allow non-browser clients (curl, server-to-server)
  const configured = (process.env.FRONTEND_ORIGIN || '').trim();
  if (configured && origin === configured) return true;
  // allow localhost or 127.0.0.1 on any port (http or https)
  const localhostRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
  return localhostRegex.test(origin);
}

const corsOptions = {
  origin: (origin, callback) => {
    try {
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(new Error(`CORS policy: origin ${origin} not allowed`));
    } catch (e) {
      return callback(new Error('CORS origin check failed'));
    }
  },
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// request logger
app.use((req, res, next) => {
  console.log('[REQ]', {
    method: req.method,
    url: req.originalUrl,
    origin: req.headers.origin,
    contentType: req.headers['content-type'],
  });
  next();
});

// parse JSON and handle malformed JSON gracefully
app.use(express.json({ limit: '200kb' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    console.warn('[ERR] Bad JSON received');
    return res.status(400).json({ success: false, error: 'invalid_json', message: 'Request body contains invalid JSON' });
  }
  next();
});

if (!API_KEY) {
  console.warn('WARNING: NOWPAYMENTS_API_KEY is not set in environment variables');
}

app.get('/health', (req, res) => res.json({ ok: true }));

async function createInvoiceHandler(req, res) {
  if (!API_KEY) {
    return res.status(500).json({ success: false, error: 'NOWPAYMENTS_API_KEY not configured on server' });
  }

  try {
    // Accept either "price_amount" or "amount" in request body for flexibility
    const { amount, price_amount, currency = 'USD', order_id, order_description, ipn_callback_url } = req.body || {};

    const numericAmount = Number(price_amount ?? amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ success: false, error: 'invalid_amount', message: 'amount must be a positive number' });
    }

    // Build payload in NowPayments expected shape
    const payload = {
      price_amount: Math.round(numericAmount * 100) / 100,
      price_currency: String(currency || 'USD'),
      order_id: order_id || `donation-${Date.now()}`,
      order_description: order_description || 'Donation',
    };

    // Only include success_url / cancel_url if they are valid absolute http(s) URLs
    if (SUCCESS_URL) payload.success_url = SUCCESS_URL;
    else if (process.env.SUCCESS_URL) console.warn('[WARN] Not including invalid SUCCESS_URL in payload');

    if (CANCEL_URL) payload.cancel_url = CANCEL_URL;
    else if (process.env.CANCEL_URL) console.warn('[WARN] Not including invalid CANCEL_URL in payload');

    if (ipn_callback_url) {
      // accept ipn_callback_url from request only if it's a valid absolute URL
      const safeIpn = safeUrlFromEnv(ipn_callback_url);
      if (safeIpn) payload.ipn_callback_url = safeIpn;
      else console.warn('[WARN] Ignoring invalid ipn_callback_url provided by client:', ipn_callback_url);
    }

    console.log('Creating NowPayments invoice — payload:', payload);

    const resp = await axios.post(`${NOW_API_BASE}/invoice`, payload, {
      headers: {
        'x-api-key': API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    // Normalize invoice url across possible response shapes
    const invoiceUrl =
      resp?.data?.invoice_url ||
      resp?.data?.url ||
      resp?.data?.payment_url ||
      resp?.data?.checkout_url ||
      resp?.data?.redirect_url ||
      null;

    if (!invoiceUrl) {
      console.error('No invoice URL in NowPayments response:', resp?.data);
      return res.status(502).json({ success: false, error: 'no_invoice_url', message: 'No invoice URL returned from NowPayments', upstream: resp?.data || null });
    }

    const normalized = {
      success: true,
      invoice_url: resp.data?.invoice_url || invoiceUrl,
      invoiceUrl: invoiceUrl,
      nowpayments: resp.data || {},
    };

    console.log('NowPayments invoice URL:', normalized.invoice_url);
    return res.json(normalized);
  } catch (err) {
    console.error('create-invoice error:', {
      message: err.message,
      status: err.response?.status || null,
      responseData: err.response?.data || null,
      stack: err.stack,
    });

    const code = err.response?.status || 502;
    return res.status(code).json({
      success: false,
      error: err.message || 'unknown_error',
      upstream: err.response?.data || null,
    });
  }
}

app.post('/create-invoice', createInvoiceHandler);
app.post('/api/create-invoice', createInvoiceHandler);

// Catch-all 404
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

app.listen(PORT, () => {
  console.log(`NowPayments helper server listening on ${PORT} (CORS FRONTEND -> ${process.env.FRONTEND_ORIGIN || 'allow localhost:*'})`);
});
