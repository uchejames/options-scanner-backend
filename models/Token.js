const mongoose = require('mongoose');

const TokenSchema = new mongoose.Schema({
  access_token: { type: String, required: true },
  refresh_token: { type: String, required: true },
  expires_in: { type: Number, required: true },        // duration in seconds
  expires_at: { type: Number, required: true },         // Unix timestamp in seconds
  token_type: { type: String },                         // e.g., Bearer
  scope: { type: String },                              // scopes returned
  timestamp: { type: Date, default: Date.now }          // saved time (for logging/debug)
});

module.exports = mongoose.model('Token', TokenSchema);
