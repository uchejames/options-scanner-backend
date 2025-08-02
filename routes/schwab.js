const express = require('express');
const router = express.Router();
const axios = require('axios');
const qs = require('qs');
const { saveToken, getToken, getQuote, getOptionsChain, getAccessToken } = require('../utils/schwab'); // ✅ Correct import

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
    console.log(`📈 Fetching quote for: ${symbol}`);
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

// ✅ IMPROVED: Enhanced endpoint for better ETF symbol handling
router.get(['/options', '/options/:symbol'], async (req, res) => {
  let symbols = [];
  
  // Enhanced symbol extraction logic
  if (req.params.symbol) {
    symbols = [req.params.symbol.toUpperCase().trim()];
  } else if (req.query.symbol) {
    symbols = [req.query.symbol.toUpperCase().trim()];
  } else if (req.query.symbols) {
    symbols = req.query.symbols
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(s => s.length > 0 && /^[A-Z]{1,5}$/.test(s)); // Basic symbol validation
  }

  // ✅ ADDED: Debug logging for symbol extraction
  console.log('🔍 Symbol extraction debug:', {
    params_symbol: req.params.symbol,
    query_symbol: req.query.symbol,  
    query_symbols: req.query.symbols,
    extracted_symbols: symbols,
    request_url: req.originalUrl
  });

  if (!symbols.length) {
    console.error('❌ No valid symbols provided');
    return res.status(400).json({ 
      success: false, 
      message: 'Missing or invalid symbol(s). Provide via URL param or ?symbols=SPY,QQQ,TSLA',
      received: {
        params: req.params,
        query: req.query
      }
    });
  }

  // ✅ ADDED: Validate symbols before processing
  const validSymbols = [];
  const invalidSymbols = [];
  
  for (const symbol of symbols) {
    // Basic validation for stock/ETF symbols
    if (/^[A-Z]{1,5}$/.test(symbol)) {
      validSymbols.push(symbol);
    } else {
      invalidSymbols.push(symbol);
      console.warn(`⚠️ Invalid symbol format: ${symbol}`);
    }
  }

  if (validSymbols.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'No valid symbols provided',
      invalidSymbols
    });
  }

  let allOptions = [];
  let failedSymbols = [];
  let successfulSymbols = [];

  // ✅ IMPROVED: Enhanced error handling and debugging
  for (const symbol of validSymbols) {
    try {
      console.log(`🔍 Backend: Fetching options for symbol: ${symbol}`);
      
      // Verify token first
      const token = await getToken();
      if (!token || !token.access_token) {
        console.error(`❌ No valid Schwab token for ${symbol}`);
        failedSymbols.push({ symbol, error: 'No valid token' });
        continue;
      }
      
      const now = Math.floor(Date.now() / 1000);
      const isExpired = token.expires_at < now;
      console.log(`🔑 Token status for ${symbol}: expires_at=${token.expires_at}, current=${now}, is_expired=${isExpired}`);
      
      // ✅ ADDED: Pre-flight check for ETF symbols
      if (['SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO'].includes(symbol)) {
        console.log(`📊 Processing ETF symbol: ${symbol}`);
      }
      
      const data = await getOptionsChain(symbol);
      console.log(`🔍 Raw Schwab options chain response for ${symbol}:`, {
        isArray: Array.isArray(data),
        length: Array.isArray(data) ? data.length : 'N/A',
        firstItem: Array.isArray(data) && data.length > 0 ? data[0] : null,
        type: typeof data
      });
      
      if (Array.isArray(data) && data.length > 0) {
        allOptions.push(...data);
        successfulSymbols.push(symbol);
        console.log(`✅ Successfully fetched ${data.length} options for ${symbol}`);
      } else {
        console.warn(`⚠️ No options data returned for ${symbol}`);
        failedSymbols.push({ symbol, error: 'No options data available' });
      }
      
    } catch (err) {
      console.error(`❌ Error fetching options for ${symbol}:`, {
        message: err.message,
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data
      });
      
      failedSymbols.push({ 
        symbol, 
        error: err.message,
        status: err.response?.status,
        details: err.response?.data
      });
    }
  }

  // ✅ ENHANCED: Better response structure
  const response = {
    success: allOptions.length > 0,
    requestedSymbols: validSymbols,
    successfulSymbols,
    options: allOptions,
    totalOptions: allOptions.length,
    timestamp: new Date().toISOString()
  };

  if (failedSymbols.length > 0) {
    response.partial = true;
    response.failedSymbols = failedSymbols;
    response.message = `${failedSymbols.length}/${validSymbols.length} symbols failed`;
  }

  if (invalidSymbols.length > 0) {
    response.invalidSymbols = invalidSymbols;
  }

  console.log(`📊 Final response summary:`, {
    requested: validSymbols.length,
    successful: successfulSymbols.length,
    failed: failedSymbols.length,
    totalOptions: allOptions.length
  });

  res.json(response);
});

// ✅ ADD: Debug endpoint for troubleshooting
router.get('/debug/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  
  try {
    console.log(`🔧 [DEBUG] Starting debug analysis for ${symbol}`);
    
    // Check token first
    const token = await getToken();
    if (!token || !token.access_token) {
      return res.json({
        success: false,
        error: 'No valid token',
        symbol,
        timestamp: new Date().toISOString()
      });
    }
    
    const now = Math.floor(Date.now() / 1000);
    const tokenStatus = {
      exists: !!token,
      hasAccessToken: !!token.access_token,
      hasRefreshToken: !!token.refresh_token,
      expiresAt: token.expires_at,
      currentTime: now,
      isExpired: token.expires_at < now,
      timeUntilExpiry: token.expires_at - now
    };
    
    console.log(`🔑 [DEBUG] Token status for ${symbol}:`, tokenStatus);
    
    // Try to get access token (this will refresh if needed)
    let accessToken;
    try {
      accessToken = await getAccessToken();
      console.log(`✅ [DEBUG] Got access token for ${symbol}: ${accessToken ? 'YES' : 'NO'}`);
    } catch (tokenError) {
      console.error(`❌ [DEBUG] Token error for ${symbol}:`, tokenError);
      return res.json({
        success: false,
        error: 'Token refresh failed',
        tokenError: tokenError.message,
        symbol,
        tokenStatus,
        timestamp: new Date().toISOString()
      });
    }
    
    // Make the raw API call
    const baseUrl = 'https://api.schwabapi.com/marketdata/v1/chains';
    const params = {
      symbol: symbol,
      contractType: 'ALL',
      includeQuotes: true,
      strategy: 'SINGLE'
    };
    
    console.log(`📡 [DEBUG] Making API call for ${symbol}...`);
    
    let rawResponse;
    try {
      rawResponse = await axios.get(baseUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json'
        },
        params: params,
        timeout: 30000
      });
      
      console.log(`✅ [DEBUG] API call successful for ${symbol}`);
      
    } catch (apiError) {
      console.error(`❌ [DEBUG] API call failed for ${symbol}:`, apiError.message);
      
      return res.json({
        success: false,
        error: 'API call failed',
        apiError: {
          message: apiError.message,
          status: apiError.response?.status,
          statusText: apiError.response?.statusText,
          data: apiError.response?.data
        },
        symbol,
        tokenStatus,
        timestamp: new Date().toISOString()
      });
    }
    
    // Analyze the response structure
    const responseAnalysis = {
      status: rawResponse.status,
      statusText: rawResponse.statusText,
      dataType: typeof rawResponse.data,
      isArray: Array.isArray(rawResponse.data),
      dataKeys: rawResponse.data ? Object.keys(rawResponse.data) : null,
      hasCallExpDateMap: !!(rawResponse.data?.callExpDateMap),
      hasPutExpDateMap: !!(rawResponse.data?.putExpDateMap),
      hasOptionPairs: !!(rawResponse.data?.optionPairs),
      callMapKeys: rawResponse.data?.callExpDateMap ? Object.keys(rawResponse.data.callExpDateMap) : null,
      putMapKeys: rawResponse.data?.putExpDateMap ? Object.keys(rawResponse.data.putExpDateMap) : null,
      optionPairsLength: Array.isArray(rawResponse.data?.optionPairs) ? rawResponse.data.optionPairs.length : null
    };
    
    console.log(`📊 [DEBUG] Response analysis for ${symbol}:`, responseAnalysis);
    
    // Try to extract options using current method
    let extractedOptions = [];
    try {
      extractedOptions = await getOptionsChain(symbol);
      console.log(`🎯 [DEBUG] Extracted ${extractedOptions.length} options for ${symbol}`);
    } catch (extractError) {
      console.error(`❌ [DEBUG] Extraction error for ${symbol}:`, extractError);
    }
    
    // Return comprehensive debug info
    const debugResponse = {
      success: true,
      symbol,
      tokenStatus,
      responseAnalysis,
      extractedOptionsCount: extractedOptions.length,
      sampleOption: extractedOptions.length > 0 ? extractedOptions[0] : null,
      rawDataSample: JSON.stringify(rawResponse.data, null, 2).substring(0, 2000) + '...',
      timestamp: new Date().toISOString()
    };
    
    // Also include the full raw data if it's small enough
    if (JSON.stringify(rawResponse.data).length < 10000) {
      debugResponse.fullRawData = rawResponse.data;
    }
    
    console.log(`✅ [DEBUG] Debug response ready for ${symbol}`);
    res.json(debugResponse);
    
  } catch (error) {
    console.error(`❌ [DEBUG] Unexpected error for ${symbol}:`, error);
    res.status(500).json({
      success: false,
      error: 'Unexpected debug error',
      message: error.message,
      symbol,
      timestamp: new Date().toISOString()
    });
  }
});

// ✅ ALSO ADD: Simple quote test endpoint
router.get('/test-quote/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  
  try {
    console.log(`🧪 [TEST-QUOTE] Testing quote for ${symbol}`);
    const quote = await getQuote(symbol);
    
    res.json({
      success: true,
      symbol,
      quote,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`❌ [TEST-QUOTE] Error for ${symbol}:`, error);
    res.status(500).json({
      success: false,
      error: error.message,
      symbol,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;