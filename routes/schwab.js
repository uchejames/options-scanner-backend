// Enhanced callback route with full debugging
router.get('/callback', async (req, res) => {
  const code = req.query.code;
  const error = req.query.error;
  
  console.log('📨 CALLBACK RECEIVED:');
  console.log('  - Code present:', !!code);
  console.log('  - Error:', error);
  console.log('  - Full query:', req.query);
  
  if (error) {
    console.error('❌ OAuth error:', error);
    return res.status(400).send(`❌ OAuth Error: ${error}`);
  }
  
  if (!code) {
    console.error('❌ No authorization code received');
    return res.status(400).send('❌ No authorization code received');
  }

  try {
    console.log('🔄 STARTING TOKEN EXCHANGE...');
    
    const tokenRequest = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: SCHWAB_REDIRECT_URI
    };
    
    console.log('📤 TOKEN REQUEST:');
    console.log('  - Grant type:', tokenRequest.grant_type);
    console.log('  - Redirect URI:', tokenRequest.redirect_uri);
    console.log('  - Code length:', code.length);
    console.log('  - Auth header present:', !!getBasicAuthHeader());
    
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

    console.log('✅ TOKEN RESPONSE RECEIVED:');
    console.log('  - Status:', response.status);
    console.log('  - Has access_token:', !!response.data.access_token);
    console.log('  - Has refresh_token:', !!response.data.refresh_token);
    console.log('  - Expires in:', response.data.expires_in);
    console.log('  - Token type:', response.data.token_type);
    console.log('  - Scope:', response.data.scope);
    console.log('  - Full response keys:', Object.keys(response.data));

    // Check if we actually got a token
    if (!response.data.access_token) {
      console.error('❌ NO ACCESS TOKEN IN RESPONSE');
      return res.status(500).send('❌ No access token received from Schwab');
    }

    console.log('💾 SAVING TOKEN TO DATABASE...');
    await saveToken(response.data);
    console.log('✅ TOKEN SAVED SUCCESSFULLY');

    // Verify token was saved
    const savedToken = await getToken();
    console.log('🔍 VERIFICATION:');
    console.log('  - Token saved:', !!savedToken);
    console.log('  - Access token present:', !!savedToken?.access_token);
    console.log('  - Refresh token present:', !!savedToken?.refresh_token);
    
    res.json({
      success: true,
      message: 'Schwab token saved successfully!',
      token_info: {
        has_access_token: !!savedToken?.access_token,
        has_refresh_token: !!savedToken?.refresh_token,
        expires_in: response.data.expires_in,
        token_type: response.data.token_type
      }
    });
    
  } catch (err) {
    console.error('❌ TOKEN EXCHANGE FAILED:');
    console.error('  - Status:', err.response?.status);
    console.error('  - Status text:', err.response?.statusText);
    console.error('  - Response data:', JSON.stringify(err.response?.data, null, 2));
    console.error('  - Request config:', {
      url: err.config?.url,
      method: err.config?.method,
      headers: err.config?.headers
    });
    console.error('  - Error message:', err.message);
    console.error('  - Full error:', err);
    
    // More specific error messages
    if (err.response?.status === 401) {
      res.status(500).json({
        error: 'Unauthorized',
        message: 'Check your client credentials and app status',
        details: err.response?.data
      });
    } else if (err.response?.status === 400) {
      res.status(500).json({
        error: 'Bad Request',
        message: 'Invalid request parameters',
        details: err.response?.data
      });
    } else {
      res.status(500).json({
        error: 'Token Exchange Failed',
        message: err.message,
        details: err.response?.data
      });
    }
  }
});

// Add token verification endpoint
router.get('/verify-token', async (req, res) => {
  try {
    const token = await getToken();
    const now = Math.floor(Date.now() / 1000);
    
    if (!token) {
      return res.json({
        has_token: false,
        message: 'No token found in database'
      });
    }
    
    res.json({
      has_token: true,
      has_access_token: !!token.access_token,
      has_refresh_token: !!token.refresh_token,
      expires_at: token.expires_at,
      expires_in_seconds: token.expires_at - now,
      is_expired: token.expires_at < now,
      token_type: token.token_type,
      scope: token.scope
    });
    
  } catch (err) {
    console.error('❌ Token verification failed:', err);
    res.status(500).json({
      error: 'Token verification failed',
      message: err.message
    });
  }
});