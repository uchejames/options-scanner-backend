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

// Helper function to get nested values
const getNestedValue = (obj, path) => {
  return path.split('.').reduce((current, key) => current?.[key], obj);
};

// ✅ NEW: Alternative extraction methods for different response formats
const tryAlternativeExtraction = (data, symbol) => {
  console.log(`🔄 [${symbol}] Trying alternative extraction methods...`);
  
  const alternatives = [];
  
  try {
    // Check for nested options in various locations
    const possiblePaths = [
      'options',
      'optionChain',
      'chains',
      'contracts',
      'data.options',
      'result.options'
    ];
    
    for (const path of possiblePaths) {
      const value = getNestedValue(data, path);
      if (Array.isArray(value) && value.length > 0) {
        console.log(`✅ [${symbol}] Found options at path: ${path} (${value.length} items)`);
        return value.map(opt => ({ 
          ...opt, 
          sourceSymbol: symbol,
          extractionMethod: `alternative:${path}`
        }));
      }
    }
    
    // Check for any arrays in the response that might contain options
    const findArraysInObject = (obj, parentKey = '') => {
      for (const [key, value] of Object.entries(obj || {})) {
        const fullKey = parentKey ? `${parentKey}.${key}` : key;
        
        if (Array.isArray(value) && value.length > 0) {
          // Check if this looks like options data
          const firstItem = value[0];
          if (firstItem && typeof firstItem === 'object' && 
              (firstItem.strikePrice || firstItem.strike || firstItem.symbol)) {
            console.log(`🎯 [${symbol}] Found potential options array at: ${fullKey}`);
            alternatives.push(...value);
          }
        } else if (value && typeof value === 'object') {
          findArraysInObject(value, fullKey);
        }
      }
    };
    
    findArraysInObject(data);
    
  } catch (error) {
    console.error(`❌ [${symbol}] Error in alternative extraction:`, error);
  }
  
  return alternatives;
};

// ✅ ENHANCED: Improved flattening function
const flattenOptionsChain = (chainData, symbol) => {
  let options = [];
  
  console.log(`🔧 [${symbol}] Starting flattening process...`);
  
  try {
    // Method 1: Check for optionPairs array (newer API format)
    if (Array.isArray(chainData.optionPairs)) {
      console.log(`📋 [${symbol}] Found optionPairs array with ${chainData.optionPairs.length} items`);
      options = chainData.optionPairs.map(pair => ({ 
        ...pair, 
        sourceSymbol: symbol,
        extractionMethod: 'optionPairs'
      }));
    }
    // Method 2: Check for callExpDateMap/putExpDateMap (traditional format)
    else if (chainData.callExpDateMap || chainData.putExpDateMap) {
      console.log(`📋 [${symbol}] Found exp date maps - calls: ${!!chainData.callExpDateMap}, puts: ${!!chainData.putExpDateMap}`);
      
      const extractFromMap = (expDateMap, type) => {
        let arr = [];
        let totalExtracted = 0;
        
        for (const expDate in expDateMap) {
          console.log(`📅 [${symbol}] Processing expiration: ${expDate} for ${type}`);
          const strikeMap = expDateMap[expDate];
          
          for (const strike in strikeMap) {
            const contracts = strikeMap[strike];
            if (Array.isArray(contracts)) {
              console.log(`💰 [${symbol}] Strike ${strike}: ${contracts.length} ${type} contracts`);
              for (const contract of contracts) {
                arr.push({ 
                  ...contract, 
                  optionType: type, 
                  sourceSymbol: symbol,
                  extractionMethod: 'expDateMap',
                  expirationDate: expDate,
                  strikePrice: parseFloat(strike)
                });
                totalExtracted++;
              }
            }
          }
        }
        
        console.log(`✅ [${symbol}] Extracted ${totalExtracted} ${type} options`);
        return arr;
      };
      
      if (chainData.callExpDateMap) {
        const calls = extractFromMap(chainData.callExpDateMap, 'CALL');
        options = options.concat(calls);
      }
      if (chainData.putExpDateMap) {
        const puts = extractFromMap(chainData.putExpDateMap, 'PUT');
        options = options.concat(puts);
      }
    }
    // Method 3: Check if the response IS the options array
    else if (Array.isArray(chainData)) {
      console.log(`📋 [${symbol}] Response is direct options array with ${chainData.length} items`);
      options = chainData.map(opt => ({ 
        ...opt, 
        sourceSymbol: symbol,
        extractionMethod: 'directArray'
      }));
    }
    
    console.log(`🎯 [${symbol}] Flattening complete: ${options.length} options extracted`);
    
    // ✅ ADDED: Log sample of extracted options for debugging
    if (options.length > 0) {
      console.log(`🔍 [${symbol}] Sample option:`, {
        symbol: options[0].symbol,
        strikePrice: options[0].strikePrice,
        optionType: options[0].optionType,
        expirationDate: options[0].expirationDate,
        bid: options[0].bid,
        ask: options[0].ask,
        volume: options[0].totalVolume || options[0].volume,
        openInterest: options[0].openInterest,
        availableFields: Object.keys(options[0])
      });
    }
    
  } catch (error) {
    console.error(`❌ [${symbol}] Error during flattening:`, error);
  }
  
  return options;
};

// Enhanced getOptionsChain function with comprehensive debugging
const getOptionsChain = async (symbol) => {
  const accessToken = await getAccessToken();
  
  console.log(`🔍 [${symbol}] Starting options chain request`);
  console.log(`🔑 [${symbol}] Using access token: ${accessToken ? accessToken.substring(0, 20) + '...' : 'NULL'}`);
  
  try {
    const baseUrl = 'https://api.schwabapi.com/marketdata/v1/chains';
    const params = {
      symbol: symbol.toUpperCase(),
      contractType: 'ALL',
      includeQuotes: true,
      strategy: 'SINGLE'
    };
    
    // ✅ ADDED: Try different parameter combinations for ETFs
    if (['SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO', 'EFA', 'EEM'].includes(symbol.toUpperCase())) {
      console.log(`📊 [${symbol}] Detected ETF - using ETF-optimized parameters`);
      // Some ETFs might need different parameters
      params.range = 'ALL'; // Include all strikes
      params.fromDate = new Date().toISOString().split('T')[0]; // Today
      
      // Add expiration range (next 60 days for ETFs)
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 60);
      params.toDate = futureDate.toISOString().split('T')[0];
    }
    
    const requestUrl = `${baseUrl}?${new URLSearchParams(params).toString()}`;
    console.log(`📡 [${symbol}] Full request URL: ${requestUrl}`);
    console.log(`📋 [${symbol}] Request parameters:`, params);
    
    const res = await axios.get(baseUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'OptionsScanner/1.0'
      },
      params: params,
      timeout: 30000 // 30 second timeout
    });
    
    console.log(`✅ [${symbol}] API Response Status: ${res.status}`);
    console.log(`📊 [${symbol}] Response Headers:`, res.headers);
    console.log(`📦 [${symbol}] Raw response data structure:`, {
      keys: Object.keys(res.data || {}),
      hasCallExpDateMap: !!(res.data?.callExpDateMap),
      hasPutExpDateMap: !!(res.data?.putExpDateMap),
      hasOptionPairs: !!(res.data?.optionPairs),
      dataType: typeof res.data,
      dataLength: Array.isArray(res.data) ? res.data.length : 'N/A'
    });
    
    // ✅ ENHANCED: More detailed logging of the actual response
    if (res.data) {
      console.log(`🔍 [${symbol}] Full response data sample:`, JSON.stringify(res.data, null, 2).substring(0, 1000) + '...');
      
      // Check for common Schwab response patterns
      if (res.data.symbol) console.log(`📍 [${symbol}] Response symbol: ${res.data.symbol}`);
      if (res.data.status) console.log(`📊 [${symbol}] Response status: ${res.data.status}`);
      if (res.data.numberOfContracts) console.log(`📈 [${symbol}] Number of contracts: ${res.data.numberOfContracts}`);
      if (res.data.strategy) console.log(`🎯 [${symbol}] Strategy: ${res.data.strategy}`);
      if (res.data.isDelayed !== undefined) console.log(`⏰ [${symbol}] Is delayed: ${res.data.isDelayed}`);
      if (res.data.isIndex !== undefined) console.log(`📊 [${symbol}] Is index: ${res.data.isIndex}`);
      if (res.data.underlying) {
        console.log(`🏢 [${symbol}] Underlying info:`, {
          symbol: res.data.underlying.symbol,
          description: res.data.underlying.description,
          change: res.data.underlying.change,
          percentChange: res.data.underlying.percentChange,
          close: res.data.underlying.close
        });
      }
    }
    
    // ✅ IMPROVED: Enhanced flattening with better error handling
    const flattened = flattenOptionsChain(res.data, symbol);
    console.log(`🎯 [${symbol}] Flattened options count: ${flattened.length}`);
    
    if (flattened.length === 0) {
      console.warn(`⚠️ [${symbol}] No options found after flattening. Trying alternative extraction...`);
      
      // ✅ ADDED: Alternative extraction methods for different response formats
      const alternatives = tryAlternativeExtraction(res.data, symbol);
      if (alternatives.length > 0) {
        console.log(`✅ [${symbol}] Alternative extraction found ${alternatives.length} options`);
        return alternatives;
      }
    }
    
    return flattened;
    
  } catch (err) {
    console.error(`🛑 [${symbol}] Options Chain Error Details:`, {
      message: err.message,
      status: err.response?.status,
      statusText: err.response?.statusText,
      data: err.response?.data,
      url: err.config?.url,
      params: err.config?.params,
      headers: err.config?.headers
    });
    
    // ✅ ADDED: Specific error handling for common issues
    if (err.response?.status === 401) {
      console.error(`🔐 [${symbol}] Authentication error - token may be expired`);
      throw new Error(`Authentication failed for ${symbol} - token may be expired`);
    } else if (err.response?.status === 404) {
      console.error(`🔍 [${symbol}] Symbol not found or no options available`);
      return []; // Return empty array instead of throwing
    } else if (err.response?.status === 429) {
      console.error(`⏳ [${symbol}] Rate limit exceeded`);
      throw new Error(`Rate limit exceeded for ${symbol}`);
    }
    
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