// index.js (Render-ready)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.NOWPAYMENTS_API_KEY || '';
const NOW_API_BASE = 'https://api.nowpayments.io/v1';

// Helper: allow explicit FRONTEND_ORIGIN (prod) OR any localhost/127.0.0.1 origin (dev)
function isAllowedOrigin(origin) {
  // origin === undefined || null for non-browser clients (curl, server-to-server)
  if (!origin) return true;
  const configured = process.env.FRONTEND_ORIGIN;
  if (configured && origin === configured) return true;
  // allow localhost or 127.0.0.1 on any port (http or https)
  const localhostRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
  return localhostRegex.test(origin);
}

const corsOptions = {
  origin: (origin, callback) => {
    try {
      if (isAllowedOrigin(origin)) return callback(null, true);
      // if origin is not allowed, pass an error (browser will block the call)
      return callback(new Error(`CORS policy: origin ${origin} not allowed`));
    } catch (e) {
      return callback(new Error('CORS origin check failed'));
    }
  },
  optionsSuccessStatus: 200, // for legacy browsers
};

// Apply CORS globally (including preflight)
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Small request logger for Render logs (very helpful)
app.use((req, res, next) => {
  console.log('[REQ]', {
    method: req.method,
    url: req.originalUrl,
    origin: req.headers.origin,
    contentType: req.headers['content-type'],
  });
  next();
});

// JSON parser + handle bad JSON
app.use(express.json({ limit: '100kb' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    console.warn('[ERR] Bad JSON received');
    return res.status(400).json({ error: 'invalid_json', message: 'Request body contains invalid JSON' });
  }
  next();
});

if (!API_KEY) {
  console.warn('WARNING: NOWPAYMENTS_API_KEY is not set in environment variables');
}

app.get('/health', (req, res) => res.json({ ok: true }));

async function createInvoiceHandler(req, res) {
  if (!API_KEY) {
    return res.status(500).json({ error: 'NOWPAYMENTS_API_KEY is not configured on the server' });
  }

  try {
    const { amount, currency = 'USD', order_id, order_description, ipn_callback_url } = req.body || {};

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: 'invalid_amount', message: 'amount must be a positive number' });
    }

    // Build payload in NowPayments expected shape
    const payload = {
      price_amount: Math.round(numericAmount * 100) / 100,
      price_currency: String(currency || 'USD'),
      order_id: order_id || `donation-${Date.now()}`,
      order_description: order_description || 'Donation',
    };

    if (process.env.SUCCESS_URL) payload.success_url = process.env.SUCCESS_URL;
    if (process.env.CANCEL_URL) payload.cancel_url = process.env.CANCEL_URL;
    if (ipn_callback_url) payload.ipn_callback_url = ipn_callback_url;

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
      return res.status(502).json({ error: 'no_invoice_url', message: 'No invoice URL returned from NowPayments', raw: resp?.data || null });
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
    // Log rich diagnostics to Render logs
    console.error('create-invoice error:', {
      message: err.message,
      status: err.response?.status || null,
      responseData: err.response?.data || null,
      stack: err.stack,
    });

    const code = err.response?.status || 502;
    // Return a safe, predictable error shape for the frontend and include upstream body under "upstream"
    return res.status(code).json({
      success: false,
      error: err.message || 'unknown_error',
      upstream: err.response?.data || null,
    });
  }
}

// Two routes (some clients call /create-invoice, others /api/create-invoice)
app.post('/create-invoice', createInvoiceHandler);
app.post('/api/create-invoice', createInvoiceHandler);

// Catch-all 404
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

app.listen(PORT, () => {
  console.log(`NowPayments helper server listening on ${PORT} (CORS FRONTEND -> ${process.env.FRONTEND_ORIGIN || 'allow localhost:*'})`);
});
