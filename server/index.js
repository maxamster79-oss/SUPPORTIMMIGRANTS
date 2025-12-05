// index.js (fixed for Render)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOW_API_BASE = 'https://api.nowpayments.io/v1';

// Helper: allow explicit FRONTEND_ORIGIN (prod) OR any localhost/127.0.0.1 origin (dev)
function isAllowedOrigin(origin) {
  if (!origin) return true; // allow non-browser clients (curl, server-to-server)
  const configured = process.env.FRONTEND_ORIGIN;
  if (configured && origin === configured) return true;
  // allow localhost or 127.0.0.1 on any port (http or https)
  const localhostRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
  return localhostRegex.test(origin);
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(new Error(`CORS policy: origin ${origin} not allowed`));
    },
    // optionsSuccessStatus: 200 // enable if you need older browser support
  })
);

app.use(express.json({ limit: '100kb' }));

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
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

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

    // Normalize invoice URL (support different response shapes)
    const invoiceUrl =
      resp?.data?.invoice_url ||
      resp?.data?.url ||
      resp?.data?.payment_url ||
      resp?.data?.checkout_url ||
      resp?.data?.redirect_url ||
      null;

    if (!invoiceUrl) {
      console.error('No invoice URL in NowPayments response:', resp?.data);
      return res.status(502).json({ error: 'No invoice URL returned from NowPayments', raw: resp?.data });
    }

    // Spread resp.data safely and then override / ensure invoice_url & invoiceUrl exist
    const normalized = {
      ...(resp.data || {}),
      invoice_url: resp.data?.invoice_url || invoiceUrl,
      invoiceUrl: invoiceUrl,
    };

    console.log('NowPayments invoice URL:', normalized.invoice_url);
    return res.json(normalized);
  } catch (err) {
    // Better diagnostic logs for render logs
    console.error('create-invoice error:', {
      message: err.message,
      status: err.response?.status,
      responseData: err.response?.data,
      stack: err.stack,
    });
    const code = err.response?.status || 500;
    return res.status(code).json({ error: err.response?.data || err.message || 'unknown error' });
  }
}

app.post('/create-invoice', createInvoiceHandler);
app.post('/api/create-invoice', createInvoiceHandler);

app.listen(PORT, () => {
  console.log(`NowPayments helper server listening on ${PORT} (CORS FRONTEND -> ${process.env.FRONTEND_ORIGIN || 'allow localhost:*'})`);
});
