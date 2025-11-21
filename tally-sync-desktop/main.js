const { app, BrowserWindow, Tray, Menu, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let tray = null;
let mainWindow = null;
let serverProcess = null;

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
    }
  });

  serverProcess.stderr.on('data', (data) => {
    const error = data.toString();
    console.error(`[Server Error] ${error}`);
    
    // Show critical errors
    if (error.includes('EADDRINUSE')) {
      console.error('❌ Port 3000 is already in use!');
    } else if (error.includes('Failed to initialize database')) {
      console.error('❌ Database initialization failed!');
    }
  });

  serverProcess.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`❌ Backend server exited with code ${code}`);
      console.error('   This usually means the server crashed. Check errors above.');
    } else {
      console.log(`Backend server exited with code ${code}`);
    }
  });

  serverProcess.on('error', (error) => {
    console.error('❌ Failed to start backend server:', error.message);
    if (error.code === 'ENOENT') {
      console.error('   Node.js not found! Make sure Node.js is installed.');
    }
  });
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
      contextIsolation: true
    }
  };

  // Add icon only if it exists
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  if (fs.existsSync(iconPath)) {
    windowOptions.icon = iconPath;
  }

  mainWindow = new BrowserWindow(windowOptions);

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

  // Wait 5 seconds for server to start, then open UI
  setTimeout(() => {
    createWindow();
    createTray();
  }, 5000);
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