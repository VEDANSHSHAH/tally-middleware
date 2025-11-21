// Quick diagnostic script to check server startup issues
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

console.log('🔍 Server Diagnostic Tool\n');
console.log('─'.repeat(60));

// Check 1: Server file exists
const serverPath = path.join(__dirname, 'tally-sync-desktop', 'server', 'server.js');
console.log('\n1️⃣ Checking server file...');
if (fs.existsSync(serverPath)) {
  console.log('   ✅ Server file exists:', serverPath);
} else {
  console.log('   ❌ Server file NOT found:', serverPath);
  process.exit(1);
}

// Check 2: Node.js version
console.log('\n2️⃣ Checking Node.js version...');
const nodeVersion = process.version;
console.log('   ✅ Node.js version:', nodeVersion);
if (parseInt(nodeVersion.split('.')[0].substring(1)) < 14) {
  console.log('   ⚠️  Warning: Node.js 14+ recommended');
}

// Check 3: Port 3000 availability
console.log('\n3️⃣ Checking port 3000...');
const net = require('net');
const server = net.createServer();
server.listen(3000, () => {
  server.once('close', () => {
    console.log('   ✅ Port 3000 is available');
    checkEnv();
  });
  server.close();
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('   ❌ Port 3000 is already in use!');
    console.log('   💡 Solution: Close the process using port 3000 or change PORT in .env');
  } else {
    console.log('   ⚠️  Port check error:', err.message);
  }
  checkEnv();
});

// Check 4: Environment variables
function checkEnv() {
  console.log('\n4️⃣ Checking environment variables...');
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    console.log('   ✅ .env file exists');
    require('dotenv').config({ path: envPath });
    
    if (process.env.DATABASE_URL) {
      console.log('   ✅ DATABASE_URL is set');
    } else {
      console.log('   ❌ DATABASE_URL is NOT set!');
      console.log('   💡 Add DATABASE_URL to .env file');
    }
    
    if (process.env.PORT) {
      console.log('   ℹ️  Custom PORT:', process.env.PORT);
    } else {
      console.log('   ℹ️  Using default PORT: 3000');
    }
  } else {
    console.log('   ⚠️  .env file not found');
    console.log('   💡 Create .env file with DATABASE_URL');
  }
  
  checkDependencies();
}

// Check 5: Dependencies
function checkDependencies() {
  console.log('\n5️⃣ Checking dependencies...');
  const packagePath = path.join(__dirname, 'tally-sync-desktop', 'package.json');
  const nodeModulesPath = path.join(__dirname, 'tally-sync-desktop', 'node_modules');
  
  if (fs.existsSync(packagePath)) {
    console.log('   ✅ package.json exists');
  } else {
    console.log('   ❌ package.json NOT found!');
    return;
  }
  
  if (fs.existsSync(nodeModulesPath)) {
    console.log('   ✅ node_modules exists');
    
    // Check critical dependencies
    const criticalDeps = ['express', 'pg', 'axios', 'xml2js'];
    let allOk = true;
    criticalDeps.forEach(dep => {
      const depPath = path.join(nodeModulesPath, dep);
      if (fs.existsSync(depPath)) {
        console.log(`   ✅ ${dep} installed`);
      } else {
        console.log(`   ❌ ${dep} NOT installed!`);
        allOk = false;
      }
    });
    
    if (!allOk) {
      console.log('\n   💡 Run: cd tally-sync-desktop && npm install');
    }
  } else {
    console.log('   ❌ node_modules NOT found!');
    console.log('   💡 Run: cd tally-sync-desktop && npm install');
  }
  
  console.log('\n' + '─'.repeat(60));
  console.log('\n✅ Diagnostic complete!');
  console.log('\n💡 Next steps:');
  console.log('   1. Fix any issues shown above');
  console.log('   2. Try starting server manually:');
  console.log('      cd tally-sync-desktop');
  console.log('      node server/server.js');
  console.log('   3. Check the output for errors\n');
}


