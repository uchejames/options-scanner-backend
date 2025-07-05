const express = require('express');
const router = express.Router();
const axios = require('axios');
const qs = require('qs');
const { saveToken, getToken, getQuote, getOptionsChain } = require('../utils/schwab'); // ✅ Correct import

const {
  SCHWAB_CLIENT_ID,
  SCHWAB_CLIENT_SECRET,
  SCHWAB_REDIRECT_URI
} = process.env;

// ✅ Define Basic Auth header function FIRST
const getBasicAuthHeader = () => {
  const base64 = Buffer.from(`${SCHWAB_CLIENT_ID}:${SCHWAB_CLIENT_SECRET}`).toString('base64');
  return `Basic ${base64}`;
};

// 🔐 Step 1: Start Schwab OAuth Login
router.get('/connect', (req, res) => {
  if (!SCHWAB_CLIENT_ID || !SCHWAB_CLIENT_SECRET || !SCHWAB_REDIRECT_URI) {
    return res.status(500).send('❌ Missing Schwab environment configuration.');
  }

  const scopes = 'read_content read_product read_client read_account read_trade';
  const authUrl = new URL('https://api.schwabapi.com/v1/oauth/authorize');

  authUrl.searchParams.append('client_id', SCHWAB_CLIENT_ID);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('redirect_uri', SCHWAB_REDIRECT_URI);
  authUrl.searchParams.append('scope', scopes);

  console.log('🚀 Redirecting to Schwab OAuth:', authUrl.toString());
  res.redirect(authUrl.toString());
});

// ✅ Step 2: OAuth Callback - Exchange Code for Token
router.get('/callback', async (req, res) => {
  const code = req.query.code;
  const error = req.query.error;

  console.log('📨 Callback Received:', { code: code ? 'present' : 'missing', error });

  if (error) {
    return res.status(400).send(`❌ OAuth Error: ${error}`);
  }

  if (!code) {
    return res.status(400).send('❌ No authorization code received.');
  }

  try {
    const tokenRequest = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: SCHWAB_REDIRECT_URI
    };

    const response = await axios.post(
      'https://api.schwabapi.com/v1/oauth/token',
      qs.stringify(tokenRequest),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': getBasicAuthHeader(),
          'Accept': 'application/json'
        }
      }
    );

    if (!response.data.access_token) {
      return res.status(500).send('❌ No access token received from Schwab.');
    }

    await saveToken(response.data);
    const savedToken = await getToken();

    res.json({
      success: true,
      message: '✅ Schwab token saved successfully!',
      token_info: {
        has_access_token: !!savedToken?.access_token,
        has_refresh_token: !!savedToken?.refresh_token,
        expires_in: response.data.expires_in,
        scope: response.data.scope
      }
    });
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;

    console.error('❌ Token exchange failed:', {
      status,
      data,
      message: err.message
    });

    if (status === 401) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid client credentials or inactive app'
      });
    }

    if (status === 400) {
      return res.status(400).json({
        error: 'Bad Request',
        message: data?.error_description || 'Invalid request',
        details: data
      });
    }

    res.status(500).json({
      error: 'Token Exchange Failed',
      message: err.message,
      details: data
    });
  }
});

// ✅ Token Verification Endpoint
router.get('/verify-token', async (req, res) => {
  try {
    const token = await getToken();
    const now = Math.floor(Date.now() / 1000);

    if (!token) {
      return res.json({
        has_token: false,
        message: 'No token found'
      });
    }

    res.json({
      has_token: true,
      expires_at: token.expires_at,
      is_expired: token.expires_at < now,
      access_token_present: !!token.access_token,
      refresh_token_present: !!token.refresh_token,
      expires_in_seconds: token.expires_at - now,
      scope: token.scope
    });
  } catch (err) {
    console.error('❌ Token verification failed:', err.message);
    res.status(500).json({
      error: 'Token verification failed',
      message: err.message
    });
  }
});

// ✅ GET /api/schwab/data?symbol=TSLA
router.get('/data', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'AAPL';
    console.log('📈 Fetching quote for: ${symbol}');
    const quote = await getQuote(symbol);
    res.json({
      success: true,
      symbol,
      quote
    });
  } catch (err) {
    console.error('❌ Error fetching quote:', err.message);
    res.status(500).json({
      success: false,
      message: 'Error fetching quote',
      error: err.message
    });
  }
});


// ✅ Endpoint: GET /api/schwab/options/:symbol
router.get(['/options', '/options/:symbol'], async (req, res) => {
  const symbol = (req.params.symbol || req.query.symbol || '').toUpperCase();

  if (!symbol) {
    return res.status(400).json({ success: false, message: 'Missing symbol query param' });
  }

  try {
    const data = await getOptionsChain(symbol.toUpperCase());

    res.json({
      success: true,
      symbol,
      options: data
    });

  } catch (error) {
    console.error('❌ Error fetching options chain:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error fetching options chain',
      error: error.message
    });
  }
});

module.exports = router;
