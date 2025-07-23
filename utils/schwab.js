const axios = require('axios');
const qs = require('querystring');
const Token = require('../models/Token');

const {
  SCHWAB_CLIENT_ID,
  SCHWAB_CLIENT_SECRET,
  SCHWAB_REDIRECT_URI
} = process.env;

// Encode client credentials for Basic Auth
const getBasicAuthHeader = () => {
  const base64 = Buffer.from(`${SCHWAB_CLIENT_ID}:${SCHWAB_CLIENT_SECRET}`).toString('base64');
  return `Basic ${base64}`;
};

// Save token with expiration time
const saveToken = async (tokenData) => {
  const now = Math.floor(Date.now() / 1000);
  const tokenWithExpiry = {
    ...tokenData,
    expires_at: now + tokenData.expires_in
  };

  await Token.deleteMany(); // Clear previous tokens
  await Token.create(tokenWithExpiry);
  console.log("✅ Schwab token saved to MongoDB with expiry");
};

// Get the most recent token
const getToken = async () => {
  const token = await Token.findOne();
  return token ? token.toObject() : null;
};

// Refresh access token with refresh_token
const refreshToken = async () => {
  const current = await getToken();
  if (!current?.refresh_token) throw new Error('No refresh token available');

  const response = await axios.post(
    'https://api.schwabapi.com/v1/oauth/token',
    qs.stringify({
      grant_type: 'refresh_token',
      refresh_token: current.refresh_token,
      redirect_uri: SCHWAB_REDIRECT_URI
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': getBasicAuthHeader()
      }
    }
  );

  await saveToken(response.data);
  return response.data;
};

// Get valid token (refresh if expired)
const getAccessToken = async () => {
  const token = await getToken();
  const now = Math.floor(Date.now() / 1000);

  if (!token || !token.access_token || (token.expires_at && token.expires_at < now)) {
    const refreshed = await refreshToken();
    return refreshed.access_token;
  }

  return token.access_token;
};

// Get stock quote using Schwab API
const getQuote = async (symbol = 'AAPL') => {
  const accessToken = await getAccessToken();

  const res = await axios.get(`https://api.schwabapi.com/marketdata/v1/quotes?symbols=${symbol}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  return res.data;
};

// Fetch Full Options Chain - CORRECTED VERSION
// Helper to flatten Schwab options chain response
const flattenOptionsChain = (chainData, symbol) => {
  let options = [];
  // Schwab returns optionPairs (array) for most symbols
  if (Array.isArray(chainData.optionPairs)) {
    options = chainData.optionPairs.map(pair => ({ ...pair, sourceSymbol: symbol }));
  }
  // Some responses use callExpDateMap/putExpDateMap (object)
  else if (chainData.callExpDateMap || chainData.putExpDateMap) {
    const extractFromMap = (expDateMap, type) => {
      let arr = [];
      for (const exp in expDateMap) {
        for (const strike in expDateMap[exp]) {
          for (const opt of expDateMap[exp][strike]) {
            arr.push({ ...opt, optionType: type, sourceSymbol: symbol });
          }
        }
      }
      return arr;
    };
    if (chainData.callExpDateMap) {
      options = options.concat(extractFromMap(chainData.callExpDateMap, 'CALL'));
    }
    if (chainData.putExpDateMap) {
      options = options.concat(extractFromMap(chainData.putExpDateMap, 'PUT'));
    }
  }
  // Fallback: return empty array if no options found
  return options;
};

const getOptionsChain = async (symbol) => {
  const accessToken = await getAccessToken();
  try {
    const res = await axios.get(`https://api.schwabapi.com/marketdata/v1/chains`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      },
      params: {
        symbol: symbol.toUpperCase(),
        contractType: 'ALL',
        includeQuotes: true,
        strategy: 'SINGLE'
      }
    });
    // Normalize and flatten options for frontend
    return flattenOptionsChain(res.data, symbol);
  } catch (err) {
    console.error('🛑 Options Chain Error Details:', {
      status: err.response?.status,
      statusText: err.response?.statusText,
      data: err.response?.data,
      url: err.config?.url,
      params: err.config?.params
    });
    throw err;
  }
};




module.exports = {
  saveToken,
  getToken,
  refreshToken,
  getAccessToken,
  getQuote,
  getOptionsChain
};