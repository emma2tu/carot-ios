// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Ensure .html files are treated as assets (not JS)
config.resolver.assetExts = [...config.resolver.assetExts, 'html'];

module.exports = config;
