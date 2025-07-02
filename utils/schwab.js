const axios = require('axios');
const qs = require('querystring');
const Token = require('../models/Token');

const {
  SCHWAB_CLIENT_ID,
  SCHWAB_CLIENT_SECRET,
  SCHWAB_REDIRECT_URI
} = process.env;

// ✅ Save token with expiration time
const saveToken = async (tokenData) => {
  const now = Math.floor(Date.now() / 1000); // Unix timestamp (seconds)
  const tokenWithExpiry = {
    ...tokenData,
    expires_at: now + tokenData.expires_in // expires_in is seconds
  };

  await Token.deleteMany(); // Clear any old token
  await Token.create(tokenWithExpiry);
  console.log("✅ Schwab token saved to MongoDB with expiry");
};

// ✅ Fetch token from MongoDB
const getToken = async () => {
  const token = await Token.findOne();
  return token ? token.toObject() : null;
};

// ✅ Refresh token using refresh_token
const refreshToken = async () => {
  const current = await getToken();
  if (!current?.refresh_token) throw new Error('No refresh token available');

  const response = await axios.post('https://api.schwabapi.com/v1/oauth/token', qs.stringify({
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
    client_id: SCHWAB_CLIENT_ID,
    client_secret: SCHWAB_CLIENT_SECRET
  }), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  await saveToken(response.data);
  return response.data;
};

// ✅ Get valid access_token (refresh if expired)
const getAccessToken = async () => {
  const token = await getToken();
  const now = Math.floor(Date.now() / 1000);

  if (!token || !token.access_token || (token.expires_at && token.expires_at < now)) {
    const refreshed = await refreshToken();
    return refreshed.access_token;
  }

  return token.access_token;
};

// ✅ Fetch stock quote using Schwab MarketData API
const getQuote = async (symbol = 'AAPL') => {
  const accessToken = await getAccessToken();

  const res = await axios.get(`https://api.schwabapi.com/marketdata/v1/quotes/${symbol}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  return res.data;
};

// ✅ Export functions
module.exports = {
  saveToken,
  getToken,
  refreshToken,
  getAccessToken,
  getQuote
};