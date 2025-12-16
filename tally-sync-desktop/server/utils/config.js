const fs = require('fs');
const path = require('path');

// Centralized config helpers to keep file access consistent across modules
// Keep config at the app root (../config.json from server/)
const CONFIG_FILE = path.join(__dirname, '..', '..', 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading config:', error);
  }
  return null;
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log('Config saved:', config);
  } catch (error) {
    console.error('Error saving config:', error);
  }
}

module.exports = {
  CONFIG_FILE,
  loadConfig,
  saveConfig
};
