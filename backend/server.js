const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { ExpressPeerServer } = require('peer');

const app = express();
app.enable('trust proxy');
const server = http.createServer(app);
const port = process.env.PORT || 9000;

// Enable CORS for all local development origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Mount ExpressPeerServer
const peerServer = ExpressPeerServer(server, {
  debug: false,
  path: '/',
  allow_discovery: true,
  corsOptions: {
    origin: true
  }
});

peerServer.on('connection', (client) => {
  console.log(`[PeerServer] ✅ Client connected: ID = ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`[PeerServer] ❌ Client disconnected: ID = ${client.getId()}`);
});

peerServer.on('error', (err) => {
  // Gracefully handle peer server errors so it doesn't crash on port conflict or socket drop
  if (err.code !== 'EADDRINUSE') {
    console.error(`[PeerServer] Error:`, err.message || err);
  }
});

app.use('/filedrop', peerServer);

// Helper to find local IPv4 network address
function getLocalNetworkIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

// Health & LAN discovery endpoint for frontend auto-configuration & QR generation
app.get(['/health', '/api/info'], (req, res) => {
  const localIp = getLocalNetworkIp();
  const host = req.get('host') || `localhost:${port}`;
  const isHttps = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https';
  const baseUrl = `${isHttps ? 'https' : 'http'}://${host}`;
  const isCloud = !host.includes('localhost') && !host.includes('127.0.0.1') && !host.startsWith('192.168.') && !host.startsWith('10.') && !host.startsWith('172.');

  res.json({
    status: 'ok',
    service: 'filedrop',
    port,
    localIp,
    desktopUrl: isCloud ? baseUrl : `http://localhost:${port}`,
    mobileUrl: isCloud ? baseUrl : `http://${localIp}:${port}`,
    isCloud
  });
});

// Serve static frontend files
const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

// Fallback to frontend index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${port} is already in use by another process.`);
    console.error(`   If another FileDrop server is already running, you can open http://localhost:${port}`);
  } else {
    console.error(`\n❌ Server error:`, err);
  }
});

// Bind explicitly to 0.0.0.0 to accept both localhost and external LAN connections (mobile phones)
server.listen(port, '0.0.0.0', () => {
  const localIp = getLocalNetworkIp();
  console.log(`\n======================================================`);
  console.log(`  🚀 FileDrop Server is LIVE!`);
  console.log(`  ----------------------------------------------------`);
  console.log(`  > On this PC (Desktop):  http://localhost:${port}`);
  console.log(`  > On Android / Mobile:   http://${localIp}:${port}`);
  console.log(`  > Signaling endpoint:    /filedrop`);
  console.log(`======================================================\n`);
  console.log(`Waiting for sender and receiver to connect...\n`);
});