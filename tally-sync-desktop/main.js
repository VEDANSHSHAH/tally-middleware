const { app, BrowserWindow, Tray, Menu, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

// Load environment variables (same as server)
const envPath = path.resolve(__dirname, '..', '.env');
require('dotenv').config({ path: envPath });
const PORT = process.env.PORT || 3001;

let tray = null;
let mainWindow = null;
let serverProcess = null;
let serverReady = false;

// Start the Node.js backend server
function startBackend() {
  console.log('🚀 Starting backend server...');
  console.log('📁 Server path:', path.join(__dirname, 'server', 'server.js'));
  console.log('📁 Working directory:', __dirname);

  const serverPath = path.join(__dirname, 'server', 'server.js');
  
  // Check if server file exists
  if (!fs.existsSync(serverPath)) {
    console.error('❌ Server file not found:', serverPath);
    return;
  }

  serverProcess = spawn('node', [serverPath], {
    cwd: __dirname,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'] // Capture stdout and stderr
  });

  serverProcess.stdout.on('data', (data) => {
    const output = data.toString();
    console.log(`[Server] ${output}`);
    
    // Check if server started successfully
    if (output.includes('Tally Middleware Server Started')) {
      console.log('✅ Backend server started successfully!');
      // Wait a bit more for server to fully initialize, then check if it's ready
      setTimeout(() => {
        checkServerReady();
      }, 1000);
    }
  });

  serverProcess.stderr.on('data', (data) => {
    const error = data.toString();
    console.error(`[Server Error] ${error}`);
    
    // Show critical errors
    if (error.includes('EADDRINUSE')) {
      console.error(`❌ Port ${PORT} is already in use!`);
      console.error(`   Please close the process using port ${PORT} or change the PORT in .env`);
    } else if (error.includes('Failed to initialize database') || error.includes('DATABASE_URL')) {
      console.error('❌ Database connection issue!');
      console.error('   Make sure DATABASE_URL is set in .env file');
    } else if (error.includes('Cannot find module')) {
      console.error('❌ Missing dependencies!');
      console.error('   Run: npm install in tally-sync-desktop directory');
    }
  });

  serverProcess.on('close', (code) => {
    serverReady = false;
    if (code !== 0 && code !== null) {
      console.error(`❌ Backend server exited with code ${code}`);
      console.error('   This usually means the server crashed. Check errors above.');
      console.error('   Common causes:');
      console.error('   - Missing DATABASE_URL in .env file');
      console.error(`   - Port ${PORT} already in use`);
      console.error('   - Missing Node.js dependencies (run: npm install)');
      console.error('   - Syntax errors in server.js');
    } else {
      console.log(`Backend server exited with code ${code}`);
    }
  });

  serverProcess.on('error', (error) => {
    console.error('❌ Failed to start backend server:', error.message);
    if (error.code === 'ENOENT') {
      console.error('   Node.js not found! Make sure Node.js is installed.');
    }
    serverReady = false;
  });
}

// Check if server is ready by making a test request
async function checkServerReady() {
  const maxAttempts = 10;
  let attempts = 0;

  const check = () => {
    attempts++;
    const req = http.get(`http://localhost:${PORT}/api/test`, (res) => {
      if (res.statusCode === 200) {
        serverReady = true;
        console.log('✅ Server is ready and responding!');
        if (mainWindow) {
          // Reload the page if window is already open
          mainWindow.reload();
        }
      } else {
        if (attempts < maxAttempts) {
          setTimeout(check, 500);
        } else {
          console.error('❌ Server not responding after multiple attempts');
        }
      }
    });

    req.on('error', (err) => {
      if (attempts < maxAttempts) {
        setTimeout(check, 500);
      } else {
        console.error('❌ Server not ready after', maxAttempts, 'attempts');
        console.error('   Error:', err.message);
      }
    });

    req.setTimeout(2000, () => {
      req.destroy();
      if (attempts < maxAttempts) {
        setTimeout(check, 500);
      }
    });
  };

  check();
}

// Create system tray
function createTray() {
  // Skip tray if icon doesn't exist
  try {
    const iconPath = path.join(__dirname, 'build', 'icon.png');

    if (!fs.existsSync(iconPath)) {
      console.log('⚠️ Tray icon not found, skipping system tray');
      return;
    }

    tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '🟢 Tally Cloud Sync',
        enabled: false
      },
      { type: 'separator' },
      {
        label: '📊 Open Dashboard',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
          }
        }
      },
      {
        label: '🔄 Sync Now',
        click: () => {
          console.log('Manual sync triggered');
          // We'll implement this later
        }
      },
      { type: 'separator' },
      {
        label: '⚙️ Settings',
        click: () => {
          console.log('Settings clicked');
          // We'll implement this later
        }
      },
      { type: 'separator' },
      {
        label: '🚪 Quit',
        click: () => {
          app.quit();
        }
      }
    ]);

    tray.setContextMenu(contextMenu);
    tray.setToolTip('Tally Cloud Sync - Running');

    console.log('✅ System tray created successfully');
  } catch (error) {
    console.log('⚠️ Could not create tray:', error.message);
  }
}

// Check if setup is complete
function isSetupComplete() {
  try {
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return !!(config.company && config.company.guid);
    }
  } catch (error) {
    console.error('Error checking setup:', error);
  }
  return false;
}

// Create main window
function createWindow() {
  const windowOptions = {
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false // Allow file:// to http:// requests in Electron
    }
  };

  // Add icon only if it exists
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  if (fs.existsSync(iconPath)) {
    windowOptions.icon = iconPath;
  }

  mainWindow = new BrowserWindow(windowOptions);

  // Disable web security for local development (allows file:// to http:// requests)
  // This is safe for Electron apps as they run locally
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders } });
  });

  // Always show setup wizard on startup (as requested)
  // User can select company and then proceed to dashboard
  console.log('⚙️ Loading setup wizard on startup...');
  mainWindow.loadFile('renderer/setup.html');
  
  // NOTE: After selecting company in setup wizard, it will redirect to index.html
  // If you want to auto-load dashboard when setup is complete, uncomment below:
  /*
  const setupComplete = isSetupComplete();
  console.log('🔍 Setup check:', setupComplete ? 'Complete' : 'Not complete');
  
  if (setupComplete) {
    console.log('📊 Loading main dashboard...');
    mainWindow.loadFile('renderer/index.html');
  } else {
    console.log('⚙️ Loading setup wizard...');
    mainWindow.loadFile('renderer/setup.html');
  }
  */

  // Open DevTools in development
  mainWindow.webContents.openDevTools();

  // Hide to tray on close (don't quit)
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });

  console.log('✅ Main window created successfully');
}

// App lifecycle
app.whenReady().then(() => {
  console.log('⚡ Electron app ready');

  // Start backend server
  startBackend();

  // Wait for server to start, then open UI
  // Check every 500ms for up to 15 seconds
  let attempts = 0;
  const maxAttempts = 30; // 15 seconds total
  
  const waitForServer = setInterval(() => {
    attempts++;
    if (serverReady || attempts >= maxAttempts) {
      clearInterval(waitForServer);
      if (!serverReady && attempts >= maxAttempts) {
        console.warn('⚠️ Server not ready after 15 seconds, opening UI anyway...');
        console.warn('   The UI will show connection errors until the server starts');
      }
      createWindow();
      createTray();
    }
  }, 500);
});

app.on('window-all-closed', () => {
  // Don't quit on window close (keep running in tray)
  // if (process.platform !== 'darwin') {
  //   app.quit();
  // }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Quit completely
app.on('before-quit', () => {
  app.isQuitting = true;

  // Stop the backend server
  if (serverProcess) {
    console.log('🛑 Stopping backend server...');
    serverProcess.kill();
  }
});

// Handle IPC messages from renderer
ipcMain.handle('get-stats', async () => {
  // We'll implement this to fetch stats from backend
  return { vendors: 0, customers: 0, transactions: 0 };
});

// Handle navigation requests
ipcMain.handle('navigate-to', async (event, page) => {
  if (mainWindow) {
    const filePath = path.join(__dirname, 'renderer', page);
    if (fs.existsSync(filePath)) {
      mainWindow.loadFile(filePath);
      return { success: true };
    } else {
      console.error(`File not found: ${filePath}`);
      return { success: false, error: 'File not found' };
    }
  }
  return { success: false, error: 'Window not available' };
});

// Handle API URL request (returns the correct port)
ipcMain.handle('get-api-url', async () => {
  return `http://localhost:${PORT}/api`;
});