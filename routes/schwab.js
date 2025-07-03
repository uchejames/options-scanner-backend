// server/routes/schwab.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const qs = require('querystring');
const { saveToken, getQuote } = require('../utils/schwab');

const {
  SCHWAB_CLIENT_ID,
  SCHWAB_CLIENT_SECRET,
  SCHWAB_REDIRECT_URI
} = process.env;

// Step 1 - Redirect user to Schwab for login
router.get('/connect', (req, res) => {
  const authUrl = `https://api.schwabapi.com/v1/oauth/authorize?client_id=${SCHWAB_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(SCHWAB_REDIRECT_URI)}&scope=read_content read_product read_client read_account read_trade`;
  return res.redirect(authUrl);
});

// Step 2 - Callback after login
router.get('/callback', async (req, res) => {
  const code = req.query.code;

  if (!code) return res.status(400).send('No code received from Schwab.');

  try {
    const tokenRes = await axios.post(
      'https://api.schwabapi.com/v1/oauth/token',
      qs.stringify({
        grant_type: 'authorization_code',
        code: code,
        client_id: SCHWAB_CLIENT_ID,
        client_secret: SCHWAB_CLIENT_SECRET,
        redirect_uri: SCHWAB_REDIRECT_URI
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    await saveToken(tokenRes.data);
    res.send('✅ Schwab token saved successfully!');
  } catch (err) {
    console.error('Token error:', err.response?.data || err.message);
    res.status(500).send(err.response?.data || 'Failed to get token from Schwab');
  }
});

// Step 3 - Fetch stock data
router.get('/data', async (req, res) => {
  try {
    const quote = await getQuote('AAPL');
    res.json(quote);
  } catch (err) {
    console.error('Quote error:', err.response?.data || err.message);
    res.status(500).send('Error fetching quote from Schwab');
  }
});

module.exports = router;
