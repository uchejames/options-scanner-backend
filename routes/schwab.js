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

// OAuth Step 1 - Start login
router.get('/connect', (req, res) => {
  const redirect = `https://api.schwabapi.com/v1/oauth/authorize?client_id=${SCHWAB_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(SCHWAB_REDIRECT_URI)}&scope=read_content read_product read_client read_account read_trade`;
  res.redirect(redirect);
});

// OAuth Step 2 - Callback
router.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code received');

  try {
    const response = await axios.post('https://api.schwabapi.com/v1/oauth/token', qs.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: SCHWAB_REDIRECT_URI,
      client_id: SCHWAB_CLIENT_ID,
      client_secret: SCHWAB_CLIENT_SECRET
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    saveToken(response.data);
    res.send('✅ Schwab token saved successfully!');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Failed to get token from Schwab');
  }
});

// Quote test
router.get('/data', async (req, res) => {
  try {
    const quote = await getQuote('AAPL');
    res.json(quote);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Error fetching quote');
  }
});

module.exports = router;
