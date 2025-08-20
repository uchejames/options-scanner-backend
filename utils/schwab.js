const axios = require('axios');
const qs = require('querystring');
const Token = require('../models/Token');

const {
  SCHWAB_CLIENT_ID,
  SCHWAB_CLIENT_SECRET,
  SCHWAB_REDIRECT_URI
} = process.env;

// In-memory lock to prevent concurrent refresh
let refreshPromise = null;

const getBasicAuthHeader = () => {
  const base64 = Buffer.from(`${SCHWAB_CLIENT_ID}:${SCHWAB_CLIENT_SECRET}`).toString('base64');
  return `Basic ${base64}`;
};

// Save/update token efficiently with error handling
const saveToken = async (tokenData) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const tokenWithExpiry = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      expires_at: now + tokenData.expires_in,
      updated_at: now,
      scope: tokenData.scope,
      token_type: tokenData.token_type || 'Bearer'
    };

    // Use upsert instead of delete+create
    const savedToken = await Token.findOneAndUpdate(
      {}, 
      tokenWithExpiry, 
      { upsert: true, new: true }
    );
    
    console.log("✅ Schwab token saved/updated");
    return savedToken.toObject();
    
  } catch (error) {
    console.error("❌ Failed to save token to database:", error);
    throw new Error(`Token save failed: ${error.message}`);
  }
};

const getToken = async () => {
  const token = await Token.findOne().lean(); // .lean() for better performance
  return token;
};

// Thread-safe refresh with locking
const refreshToken = async () => {
  // Return existing refresh promise if one is running
  if (refreshPromise) {
    console.log("⏳ Waiting for existing refresh to complete...");
    return refreshPromise;
  }

  try {
    refreshPromise = performRefresh();
    const result = await refreshPromise;
    return result;
  } finally {
    refreshPromise = null;
  }
};

const performRefresh = async () => {
  const current = await getToken();
  if (!current?.refresh_token) {
    throw new Error('No refresh token available');
  }

  console.log("♻️ Refreshing Schwab access token...");

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
      },
      timeout: 10000
    }
  );

  const data = response.data;

  // ✅ Keep old refresh_token if Schwab didn't send one
  if (!data.refresh_token) {
    data.refresh_token = current.refresh_token;
    console.log("⚠️ No new refresh_token returned — keeping existing one.");
  }

  const savedToken = await saveToken(data);
  return savedToken; // Return DB version for consistency
};

// Thread-safe token getter
const getAccessToken = async () => {
  const token = await getToken();
  const now = Math.floor(Date.now() / 1000);

  if (!token?.access_token || (token.expires_at && token.expires_at < now + 120)) {
    const refreshed = await refreshToken();
    return refreshed.access_token;
  }

  return token.access_token;
};

// Enhanced error handling for API calls
const makeAuthorizedRequest = async (url, options = {}) => {
  let retries = 0;
  const maxRetries = 2;

  while (retries <= maxRetries) {
    try {
      const accessToken = await getAccessToken();
      
      const response = await axios({
        ...options,
        url,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${accessToken}`
        }
      });

      return response;
    } catch (error) {
      if (error.response?.status === 401 && retries < maxRetries) {
        console.log("🔄 Token expired, forcing refresh and retrying...");
        // Force refresh instead of wiping DB
        await refreshToken();
        retries++;
        continue;
      }
      throw error;
    }
  }
};

const getQuote = async (symbol = 'AAPL') => {
  const response = await makeAuthorizedRequest(
    `https://api.schwabapi.com/marketdata/v1/quotes?symbols=${symbol}`
  );
  return response.data;
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
  console.log(`🔍 [${symbol}] Starting options chain request`);
  
  const params = {
    symbol: symbol.toUpperCase(),
    contractType: 'ALL',
    includeQuotes: true,
    strategy: 'SINGLE'
  };

  // ETF-specific parameters
  if (['SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO', 'EFA', 'EEM'].includes(symbol.toUpperCase())) {
    console.log(`📊 [${symbol}] Using ETF-optimized parameters`);
    params.range = 'ALL';
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 60);
    params.toDate = futureDate.toISOString().split('T')[0];
  }

  console.log(`📋 [${symbol}] Request parameters:`, params);

  try {
    const response = await makeAuthorizedRequest(
      'https://api.schwabapi.com/marketdata/v1/chains',
      {
        method: 'GET',
        params,
        timeout: 30000,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'OptionsScanner/1.0'
        }
      }
    );

    console.log(`✅ [${symbol}] API Response Status: ${response.status}`);
    console.log(`📦 [${symbol}] Raw response data structure:`, {
      keys: Object.keys(response.data || {}),
      hasCallExpDateMap: !!(response.data?.callExpDateMap),
      hasPutExpDateMap: !!(response.data?.putExpDateMap),
      hasOptionPairs: !!(response.data?.optionPairs),
      dataType: typeof response.data,
      dataLength: Array.isArray(response.data) ? response.data.length : 'N/A'
    });

    // Log detailed response info
    if (response.data) {
      if (response.data.symbol) console.log(`📍 [${symbol}] Response symbol: ${response.data.symbol}`);
      if (response.data.numberOfContracts) console.log(`📈 [${symbol}] Number of contracts: ${response.data.numberOfContracts}`);
      if (response.data.underlying) {
        console.log(`🏢 [${symbol}] Underlying info:`, {
          symbol: response.data.underlying.symbol,
          description: response.data.underlying.description,
          change: response.data.underlying.change,
          percentChange: response.data.underlying.percentChange,
          close: response.data.underlying.close
        });
      }
    }

    // Enhanced flattening with better error handling
    const flattened = flattenOptionsChain(response.data, symbol);
    console.log(`🎯 [${symbol}] Flattened options count: ${flattened.length}`);

    if (flattened.length === 0) {
      console.warn(`⚠️ [${symbol}] No options found after flattening. Trying alternative extraction...`);
      
      const alternatives = tryAlternativeExtraction(response.data, symbol);
      if (alternatives.length > 0) {
        console.log(`✅ [${symbol}] Alternative extraction found ${alternatives.length} options`);
        return alternatives;
      }
    }

    return flattened;

  } catch (error) {
    console.error(`🛑 [${symbol}] Options Chain Error:`, {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText
    });

    if (error.response?.status === 404) {
      console.error(`🔍 [${symbol}] Symbol not found or no options available`);
      return []; // Return empty array instead of throwing
    } else if (error.response?.status === 429) {
      console.error(`⏳ [${symbol}] Rate limit exceeded`);
      throw new Error(`Rate limit exceeded for ${symbol}`);
    }

    throw error;
  }
};

module.exports = {
  saveToken,
  getToken,
  refreshToken,
  getAccessToken,
  getQuote,
  getOptionsChain,
  makeAuthorizedRequest // Export for other modules
};