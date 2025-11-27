const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const serverPath = path.join(__dirname, 'server', 'server.js');
const PORT = 3000;

console.log('🚀 Starting server for verification...');
const server = spawn('node', [serverPath], {
    cwd: __dirname,
    stdio: 'pipe'
});

server.stdout.on('data', (data) => {
    console.log(`[Server]: ${data}`);
});

server.stderr.on('data', (data) => {
    console.error(`[Server Error]: ${data}`);
});

function makeRequest() {
    console.log('📡 Making request to /api/test-compression...');
    http.get(`http://localhost:${PORT}/api/test-compression`, (res) => {
        console.log(`Response status: ${res.statusCode}`);
        console.log('Headers:', res.headers);

        const contentEncoding = res.headers['content-encoding'];
        if (contentEncoding === 'gzip') {
            console.log('✅ SUCCESS: Content-Encoding is gzip');
        } else {
            console.error('❌ FAILURE: Content-Encoding is NOT gzip');
            console.error(`Actual encoding: ${contentEncoding}`);
        }

        // Kill server
        server.kill();
        process.exit(contentEncoding === 'gzip' ? 0 : 1);
    }).on('error', (err) => {
        console.log('Waiting for server...');
        setTimeout(makeRequest, 1000);
    });
}

// Give server some time to start
setTimeout(makeRequest, 3000);
