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
  
  serverProcess = spawn('node', [path.join(__dirname, 'server', 'server.js')], {
    cwd: __dirname,
    env: { ...process.env }
  });

  serverProcess.stdout.on('data', (data) => {
    console.log(`[Server] ${data.toString()}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`[Server Error] ${data.toString()}`);
  });

  serverProcess.on('close', (code) => {
    console.log(`Backend server exited with code ${code}`);
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

  mainWindow.loadFile('renderer/index.html');
  
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
  
  // Wait 3 seconds for server to start, then open UI
  setTimeout(() => {
    createWindow();
    createTray();
  }, 3000);
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