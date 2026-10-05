// ─────────────────────────────────────────────
// STATE & CONFIG
// ─────────────────────────────────────────────
const MAX_SIZE = 350 * 1024 * 1024; // 350 MB
const CHUNK_SIZE = 16 * 1024;       // 16 KB safe WebRTC MTU chunk size
const BUFFER_HIGH = 1024 * 1024;    // 1 MB backpressure pause ceiling
const BUFFER_LOW = 256 * 1024;      // 256 KB backpressure resume threshold

let peer = null;
let conn = null;
let selectedFile = null;
let senderCode = null;
let isTransferring = false;
let currentRole = null; // 'sender' | 'receiver'

// Receive state
let recvMeta = null;
let recvChunks = [];
let recvReceived = 0;
let downloadUrl = null;

// Speed & ETA tracking
let metricsTimer = null;
let lastBytes = 0;
let lastTime = 0;

// Shared Text & Clipboard State
let latestReceivedText = '';
let latestSenderReplyText = '';
let senderHistory = [];
let receiverHistory = [];

// Server & Network Info
let serverInfo = {
  localIp: 'localhost',
  port: 9000,
  desktopUrl: window.location.origin,
  mobileUrl: window.location.origin
};

// QR Code Instances
let senderQrInstance = null;
let modalQrInstance = null;

// High-reliability public STUN & TURN servers for WebRTC NAT traversal (Direct P2P + Relay fallback)
const BASE_ICE_SERVERS = [
  // Fast Google & Cloudflare STUN servers for direct local & full-cone P2P hole-punching
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // Public TURN relay servers (Essential for 5G/4G cellular, Symmetric NAT, and cross-network transfers)
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp'
    ],
    username: 'openrelay',
    credential: 'openrelay'
  }
];

// ─────────────────────────────────────────────
// DEVICE DETECTION & HAPTICS
// ─────────────────────────────────────────────
function detectDevice() {
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
  const isAndroid = /Android/i.test(navigator.userAgent);
  
  const iconEl = document.getElementById('device-icon');
  const nameEl = document.getElementById('device-name');
  const modalDeviceEl = document.getElementById('modal-device-val');
  
  let deviceName = 'Desktop';
  let deviceIcon = '💻';
  
  if (isAndroid) {
    deviceName = 'Android';
    deviceIcon = '📱';
  } else if (isMobile) {
    deviceName = 'Mobile';
    deviceIcon = '📱';
  }
  
  if (iconEl) iconEl.textContent = deviceIcon;
  if (nameEl) nameEl.textContent = deviceName;
  if (modalDeviceEl) modalDeviceEl.textContent = `${deviceName} (${window.location.hostname || 'localhost'})`;
}

function triggerHaptic(pattern = 15) {
  try {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  } catch (e) {}
}

// ─────────────────────────────────────────────
// SERVER STATUS & LAN DISCOVERY
// ─────────────────────────────────────────────
function updateServerBadge(status, text) {
  const pill = document.getElementById('server-status-pill');
  const dot = document.getElementById('server-status-dot');
  const label = document.getElementById('server-status-text');
  const modalServerVal = document.getElementById('modal-server-val');
  
  if (!pill || !label) return;

  pill.className = 'server-status-pill ' + status;
  label.textContent = text;
  if (modalServerVal) modalServerVal.textContent = text;
}

// Proactively check signaling server availability & fetch LAN info on startup
async function checkServerStatus() {
  updateServerBadge('', 'Checking server…');
  try {
    const isHttp = window.location.protocol.startsWith('http');
    const host = window.location.hostname || 'localhost';
    const isHttps = window.location.protocol === 'https:';
    const currentPort = window.location.port ? parseInt(window.location.port, 10) : (isHttps ? 443 : 80);

    // 1. Check current origin if served over HTTP/HTTPS
    if (isHttp) {
      try {
        const resp = await fetch(`/api/info`, { signal: AbortSignal.timeout(1500) });
        if (resp.ok) {
          const info = await resp.json();
          applyServerInfo(info, host, currentPort);
          updateServerBadge('online', isHttps ? `Cloud Server (${host})` : `Local Server (${host}:${currentPort})`);
          return;
        }
      } catch (e) {}
    }

    // 2. Check localhost/LAN port 9000 (standard FileDrop backend port)
    const testHost = (host === 'localhost' || host === '127.0.0.1') ? 'localhost' : host;
    try {
      const resp = await fetch(`http://${testHost}:9000/api/info`, { signal: AbortSignal.timeout(1200) });
      if (resp.ok) {
        const info = await resp.json();
        applyServerInfo(info, testHost, 9000);
        updateServerBadge('online', `Local Server (${testHost}:9000)`);
        return;
      }
    } catch (e) {}

    // 3. Fallback to public PeerJS cloud
    updateServerBadge('cloud', 'PeerJS Cloud (Active)');
  } catch (err) {
    updateServerBadge('cloud', 'PeerJS Cloud (Active)');
  }
}

function applyServerInfo(info, host, port) {
  if (!info) return;
  serverInfo.localIp = info.localIp || host;
  serverInfo.port = info.port || port;
  serverInfo.desktopUrl = info.desktopUrl || window.location.origin;
  serverInfo.mobileUrl = info.mobileUrl || window.location.origin;
  
  const modalInput = document.getElementById('modal-mobile-url');
  if (modalInput) {
    modalInput.value = serverInfo.mobileUrl;
  }
  
  // Render QR code in network modal for phone pairing
  renderModalQr(serverInfo.mobileUrl);
}

function getConnectUrl(code) {
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const base = (isLocalhost && serverInfo.mobileUrl) ? serverInfo.mobileUrl : window.location.origin;
  return `${base}/?code=${code}`;
}

// Dynamic PeerJS configuration
async function getPeerConfig() {
  const isHttp = window.location.protocol.startsWith('http');
  const host = window.location.hostname || 'localhost';
  const isHttps = window.location.protocol === 'https:';
  const currentPort = window.location.port ? parseInt(window.location.port, 10) : (isHttps ? 443 : 80);

  // 1. If currently served directly on this server (works on both local port 9000 & cloud HTTPS)
  if (isHttp) {
    try {
      const resp = await fetch(`/filedrop/peerjs/id`, { signal: AbortSignal.timeout(1500) });
      if (resp.ok) {
        updateServerBadge('online', isHttps ? `Cloud Server (${host})` : `Local Server (${host}:${currentPort})`);
        return {
          host: host,
          port: currentPort,
          path: '/filedrop',
          secure: isHttps,
          config: { iceServers: BASE_ICE_SERVERS },
          debug: 1
        };
      }
    } catch (e) {}
  }

  // 2. If running via Live Server or external IP, test port 9000
  const testHost = (host === 'localhost' || host === '127.0.0.1') ? 'localhost' : host;
  try {
    const resp = await fetch(`http://${testHost}:9000/filedrop/peerjs/id`, { signal: AbortSignal.timeout(1200) });
    if (resp.ok) {
      updateServerBadge('online', `Local Server (${testHost}:9000)`);
      return {
        host: testHost,
        port: 9000,
        path: '/filedrop',
        secure: false,
        config: { iceServers: BASE_ICE_SERVERS },
        debug: 1
      };
    }
  } catch (e) {}

  // 3. Fallback: Public PeerJS cloud
  console.log('[FileDrop] Using public PeerJS cloud signaling');
  updateServerBadge('cloud', 'PeerJS Cloud (Active)');
  return {
    config: { iceServers: BASE_ICE_SERVERS },
    debug: 1
  };
}

// ─────────────────────────────────────────────
// VIEW & TAB MANAGEMENT
// ─────────────────────────────────────────────
function showView(name) {
  triggerHaptic(10);
  currentRole = name;
  
  // Update views
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById('view-' + name);
  if (target) target.classList.add('active');

  // Update nav tabs in header
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const activeTabId = name === 'landing' ? 'tab-home' : (name === 'sender' ? 'tab-send' : 'tab-receive');
  const activeTab = document.getElementById(activeTabId);
  if (activeTab) activeTab.classList.add('active');

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetAll() {
  triggerHaptic(12);
  currentRole = null;
  isTransferring = false;
  if (conn) {
    try { conn.close(); } catch(e){}
    conn = null;
  }
  if (peer) {
    try { peer.destroy(); } catch(e){}
    peer = null;
  }
  selectedFile = null;
  senderCode = null;
  recvMeta = null;
  recvChunks = [];
  recvReceived = 0;

  if (downloadUrl) {
    try { URL.revokeObjectURL(downloadUrl); } catch(e){}
    downloadUrl = null;
  }

  // Reset sender UI
  const fileInput = document.getElementById('file-input');
  if (fileInput) fileInput.value = '';
  const preview = document.getElementById('sender-file-preview');
  if (preview) preview.innerHTML = '';
  const senderCodeSec = document.getElementById('sender-code-section');
  if (senderCodeSec) senderCodeSec.style.display = 'none';
  const qrPanel = document.getElementById('sender-qr-panel');
  if (qrPanel) qrPanel.style.display = 'none';
  const qrToggleText = document.getElementById('qr-toggle-text');
  if (qrToggleText) qrToggleText.textContent = 'Show QR';
  
  const sendBtnRow = document.getElementById('send-btn-row');
  if (sendBtnRow) sendBtnRow.style.display = 'block';
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) {
    sendBtn.disabled = false;
    sendBtn.innerHTML = '<span class="btn-icon">⚡</span> Generate Transfer Code & QR';
  }
  const sendProgress = document.getElementById('send-progress');
  if (sendProgress) sendProgress.classList.remove('visible');
  const sendFill = document.getElementById('send-fill');
  if (sendFill) sendFill.style.width = '0%';
  const sendPct = document.getElementById('send-pct');
  if (sendPct) sendPct.textContent = '0%';
  const sendSpeed = document.getElementById('send-speed');
  if (sendSpeed) sendSpeed.innerHTML = '';

  // Reset receiver UI
  for (let i = 0; i < 6; i++) {
    const ci = document.getElementById('ci' + i);
    if (ci) ci.value = '';
  }
  const connectBtn = document.getElementById('connect-btn');
  if (connectBtn) connectBtn.disabled = true;
  const recvStatus = document.getElementById('recv-status');
  if (recvStatus) recvStatus.innerHTML = '';
  const recvProgress = document.getElementById('recv-progress');
  if (recvProgress) recvProgress.classList.remove('visible');
  const recvFill = document.getElementById('recv-fill');
  if (recvFill) recvFill.style.width = '0%';
  const recvPct = document.getElementById('recv-pct');
  if (recvPct) recvPct.textContent = '0%';
  const recvSpeed = document.getElementById('recv-speed');
  if (recvSpeed) recvSpeed.innerHTML = '';
  const downloadCard = document.getElementById('download-card');
  if (downloadCard) downloadCard.classList.remove('visible');

  // Reset text sharing state & DOM
  latestReceivedText = '';
  latestSenderReplyText = '';
  senderHistory = [];
  receiverHistory = [];

  const senderTextSec = document.getElementById('sender-text-section');
  if (senderTextSec) senderTextSec.style.display = 'none';
  const recvTextSec = document.getElementById('receiver-text-section');
  if (recvTextSec) recvTextSec.style.display = 'none';

  const recvTextEmpty = document.getElementById('receiver-text-empty');
  if (recvTextEmpty) recvTextEmpty.style.display = 'flex';
  const recvTextDisp = document.getElementById('receiver-text-display');
  if (recvTextDisp) recvTextDisp.style.display = 'none';

  const senderReplyDisp = document.getElementById('sender-reply-display');
  if (senderReplyDisp) senderReplyDisp.style.display = 'none';

  const sInput = document.getElementById('sender-text-input');
  if (sInput) sInput.value = '';
  const rInput = document.getElementById('receiver-text-input');
  if (rInput) rInput.value = '';

  const sHistWrap = document.getElementById('sender-text-history-wrap');
  if (sHistWrap) sHistWrap.style.display = 'none';
  const sHist = document.getElementById('sender-text-history');
  if (sHist) sHist.innerHTML = '';

  const rHistWrap = document.getElementById('receiver-text-history-wrap');
  if (rHistWrap) rHistWrap.style.display = 'none';
  const rHist = document.getElementById('receiver-text-history');
  if (rHist) rHist.innerHTML = '';

  showView('landing');
}

// ─────────────────────────────────────────────
// FILE SELECTION & DROP ZONE
// ─────────────────────────────────────────────
function onDragOver(e) {
  e.preventDefault();
  const dz = document.getElementById('dropzone');
  if (dz) dz.classList.add('drag-over');
}

function onDragLeave(e) {
  const dz = document.getElementById('dropzone');
  if (dz) dz.classList.remove('drag-over');
}

function onDrop(e) {
  e.preventDefault();
  const dz = document.getElementById('dropzone');
  if (dz) dz.classList.remove('drag-over');
  const files = e.dataTransfer.files;
  if (files.length > 0) processFile(files[0]);
}

function onFileSelect(e) {
  if (e.target.files.length > 0) processFile(e.target.files[0]);
}

function processFile(file) {
  triggerHaptic(15);
  if (file.size > MAX_SIZE) {
    showSenderStatus('error', '✗ File too large. Maximum 350 MB allowed.');
    return;
  }
  selectedFile = file;
  const preview = document.getElementById('sender-file-preview');
  preview.innerHTML = `
    <div class="file-item">
      <span class="file-emoji">${getFileEmoji(file.name)}</span>
      <div class="file-info">
        <div class="file-name" title="${escHtml(file.name)}">${escHtml(file.name)}</div>
        <div class="file-size">${formatSize(file.size)} · Ready to Stream</div>
      </div>
      <button type="button" class="btn-ghost btn-sm" onclick="clearSelectedFile()" title="Remove file" style="padding:4px 8px;min-height:30px">✕</button>
    </div>`;

  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) {
    sendBtn.disabled = false;
    sendBtn.innerHTML = '<span class="btn-icon">⚡</span> Generate Transfer Code & QR';
  }

  // If already connected with receiver, provide instant stream button
  if (conn && conn.open && !isTransferring) {
    let sendNowBtn = document.getElementById('send-now-inline-btn');
    if (!sendNowBtn) {
      sendNowBtn = document.createElement('button');
      sendNowBtn.id = 'send-now-inline-btn';
      sendNowBtn.className = 'btn btn-green btn-large';
      sendNowBtn.style.marginTop = '12px';
      sendNowBtn.innerHTML = '<span class="btn-icon">📤</span> Stream File to Connected Peer';
      sendNowBtn.onclick = () => {
        sendNowBtn.remove();
        sendFile();
      };
      preview.appendChild(sendNowBtn);
    }
  }
}

function clearSelectedFile() {
  selectedFile = null;
  const input = document.getElementById('file-input');
  if (input) input.value = '';
  const preview = document.getElementById('sender-file-preview');
  if (preview) preview.innerHTML = '';
}

// ─────────────────────────────────────────────
// SENDER — PeerJS Lifecycle & QR Generation
// ─────────────────────────────────────────────
async function initSender() {
  triggerHaptic(20);
  currentRole = 'sender';

  if (conn) {
    try { conn.close(); } catch(e){}
    conn = null;
  }
  if (peer) {
    try { peer.destroy(); } catch(e){}
    peer = null;
  }
  isTransferring = false;

  const code = String(Math.floor(100000 + Math.random() * 900000));
  senderCode = code;

  document.getElementById('send-btn-row').style.display = 'none';

  // Display the 6-digit code with visual divider
  const box = document.getElementById('code-display');
  box.innerHTML = code.split('').map((d, i) => {
    if (i === 3) return `<span class="code-sep">·</span><span class="code-digit">${d}</span>`;
    return `<span class="code-digit">${d}</span>`;
  }).join('');
  
  document.getElementById('sender-code-section').style.display = 'block';

  // Render QR Code for camera scanning
  renderSenderQr(code);

  showSenderStatus('info', '⏳ Connecting to signaling server…');

  const config = await getPeerConfig();
  console.log('[FileDrop] Initializing sender with config:', config);
  peer = new Peer(code, config);

  peer.on('open', (id) => {
    console.log('[FileDrop] Sender peer registered on signaling server with ID:', id);
    showSenderStatus('info', '⏳ Waiting for receiver to connect (code: ' + code + ')…');
  });

  peer.on('connection', (c) => {
    console.log('[FileDrop] Incoming connection request from peer:', c.peer);

    if (conn && conn.open && isTransferring) {
      console.log('[FileDrop Sender] Busy transferring, ignoring duplicate connection');
      c.on('open', () => c.close());
      return;
    }

    if (conn && conn !== c) {
      try { conn.close(); } catch(e){}
    }
    conn = c;

    let hasStartedSending = false;
    function triggerSend() {
      onPeerConnected('sender');
      if (selectedFile) {
        if (hasStartedSending) return;
        hasStartedSending = true;
        console.log('[FileDrop Sender] Starting file stream to receiver…');
        showSenderStatus('success', '🔗 Receiver connected! Starting file transfer…');
        const waiting = document.getElementById('sender-waiting');
        if (waiting) waiting.style.display = 'none';
        setTimeout(() => sendFile(), 120);
      } else {
        console.log('[FileDrop Sender] Receiver connected (ready for text or files)');
        showSenderStatus('success', '🔗 Receiver connected! Direct P2P channel active.');
        const waiting = document.getElementById('sender-waiting');
        if (waiting) waiting.style.display = 'none';
      }
    }

    function hookSenderIce() {
      const pc = conn.peerConnection || (conn._dc && conn._dc._pc);
      if (pc && !pc._iceHooked) {
        pc._iceHooked = true;
        pc.oniceconnectionstatechange = () => {
          const state = pc.iceConnectionState;
          console.log('[FileDrop Sender] ICE state:', state);
          if (state === 'checking') {
            showSenderStatus('info', '🔗 Negotiating network route with receiver…');
          } else if (state === 'connected' || state === 'completed') {
            showSenderStatus('success', '🔗 Peer route connected! Direct P2P link ready.');
          } else if (state === 'failed') {
            showSenderStatus('info', '🔄 Direct route blocked by carrier NAT, switching to TURN relay…');
          }
        };
      }
    }
    hookSenderIce();
    setTimeout(hookSenderIce, 400);
    setTimeout(hookSenderIce, 1500);

    conn.on('open', () => {
      console.log('[FileDrop Sender] DataChannel is OPEN with receiver!');
      onPeerConnected('sender');
      setTimeout(() => {
        if (!hasStartedSending) triggerSend();
      }, 300);
    });

    conn.on('data', (data) => {
      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'ready') {
            console.log('[FileDrop Sender] Received ready signal from receiver');
            triggerSend();
          } else if (msg.type === 'text') {
            handleIncomingText(msg, 'sender');
          }
        } catch (e) {}
      }
    });

    conn.on('close', () => {
      console.log('[FileDrop Sender] Connection closed');
      onPeerDisconnected('sender');
      if (isTransferring) {
        showSenderStatus('error', '✗ Receiver disconnected mid-transfer.');
        isTransferring = false;
      }
      conn = null;
    });

    conn.on('error', (e) => {
      console.error('[FileDrop Sender] DataConnection error:', e);
      showSenderStatus('error', '✗ Connection error: ' + (e ? escHtml(e.message || String(e)) : 'Unknown'));
      isTransferring = false;
      conn = null;
      onPeerDisconnected('sender');
    });
  });

  peer.on('error', (e) => {
    console.error('[FileDrop Sender] Peer error:', e);
    let msg = e.message || e.type || 'Unknown error';
    if (e.type === 'unavailable-id') {
      msg = 'Code collision. Retrying with a new code…';
      setTimeout(() => initSender(), 1000);
      return;
    } else if (e.type === 'network' || e.type === 'server-error') {
      msg = `Cannot reach signaling server. Make sure 'npm start' is running!`;
    }
    showSenderStatus('error', '✗ ' + escHtml(msg));
    document.getElementById('send-btn-row').style.display = 'block';
    document.getElementById('send-btn').disabled = false;
    document.getElementById('sender-code-section').style.display = 'none';
  });
}

// ─────────────────────────────────────────────
// QR CODE GENERATION & TOGGLES
// ─────────────────────────────────────────────
function renderSenderQr(code) {
  const container = document.getElementById('qrcode-container');
  if (!container || typeof QRCode === 'undefined') return;
  container.innerHTML = '';

  const connectUrl = getConnectUrl(code);
  const directPreview = document.getElementById('qr-direct-url-preview');
  if (directPreview) {
    directPreview.innerHTML = `Connect URL: <strong style="color:#0f172a">${escHtml(connectUrl)}</strong>`;
  }

  try {
    senderQrInstance = new QRCode(container, {
      text: connectUrl,
      width: 170,
      height: 170,
      colorDark: '#070a10',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch (err) {
    console.warn('QR Code generation error:', err);
  }
}

function toggleQrDisplay() {
  triggerHaptic(10);
  const panel = document.getElementById('sender-qr-panel');
  const toggleText = document.getElementById('qr-toggle-text');
  if (!panel) return;
  const isHidden = panel.style.display === 'none' || !panel.style.display;
  panel.style.display = isHidden ? 'block' : 'none';
  if (toggleText) toggleText.textContent = isHidden ? 'Hide QR' : 'Show QR';
}

function copyDirectLink() {
  if (!senderCode) return;
  const url = getConnectUrl(senderCode);
  const btn = document.getElementById('copy-link-btn');
  copyToClipboard(url, btn, '✓ Link Copied!');
}

// ─────────────────────────────────────────────
// SENDER — Stream File with Flow Control
// ─────────────────────────────────────────────
function sendFile() {
  if (!conn || !selectedFile) return;
  const file = selectedFile;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  isTransferring = true;

  // Send metadata header first
  conn.send(JSON.stringify({
    type: 'meta',
    name: file.name,
    size: file.size,
    fileType: file.type,
    totalChunks: totalChunks
  }));

  const progress = document.getElementById('send-progress');
  const fill = document.getElementById('send-fill');
  const pct = document.getElementById('send-pct');
  const speedEl = document.getElementById('send-speed');
  progress.classList.add('visible');

  const dc = conn.dataChannel || conn._dc;
  if (dc) {
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
  }

  const reader = new FileReader();
  let chunkIndex = 0;
  let bytesSent = 0;
  lastBytes = 0;
  lastTime = Date.now();

  function updateSenderMetrics() {
    const now = Date.now();
    const elapsed = (now - lastTime) / 1000;
    if (elapsed >= 0.5 || chunkIndex >= totalChunks) {
      const currentSpeed = (bytesSent - lastBytes) / (elapsed || 0.001);
      const remainingBytes = Math.max(0, file.size - bytesSent);
      const etaSeconds = currentSpeed > 0 ? Math.ceil(remainingBytes / currentSpeed) : 0;

      if (speedEl) {
        speedEl.innerHTML = `<span>Speed: <strong>${formatSpeed(currentSpeed)}</strong></span><span>${etaSeconds > 0 ? 'ETA: ' + formatTime(etaSeconds) : 'Finishing…'}</span>`;
      }
      lastTime = now;
      lastBytes = bytesSent;
    }
  }

  function readNextChunk() {
    if (!isTransferring) return;

    if (chunkIndex >= totalChunks) {
      conn.send(JSON.stringify({ type: 'done' }));
      fill.style.width = '100%';
      pct.textContent = '100%';
      if (speedEl) {
        speedEl.innerHTML = `<span>100% Completed</span><span>${formatSize(file.size)}</span>`;
      }
      showSenderStatus('success', '✅ Transfer complete! Receiver can now save the file.');
      triggerHaptic([30, 80, 50]);
      isTransferring = false;
      return;
    }

    if (dc && dc.bufferedAmount > BUFFER_HIGH) {
      const onBufferedLow = () => {
        dc.removeEventListener('bufferedamountlow', onBufferedLow);
        readNextChunk();
      };
      dc.addEventListener('bufferedamountlow', onBufferedLow);
      return;
    }

    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const slice = file.slice(start, end);
    reader.readAsArrayBuffer(slice);
  }

  reader.onload = (e) => {
    if (!isTransferring) return;

    try {
      conn.send(e.target.result);
      bytesSent += e.target.result.byteLength;
      chunkIndex++;

      const p = Math.round((chunkIndex / totalChunks) * 100);
      fill.style.width = p + '%';
      pct.textContent = p + '%';
      updateSenderMetrics();

      if (dc && dc.bufferedAmount > BUFFER_HIGH) {
        const onBufferedLow = () => {
          dc.removeEventListener('bufferedamountlow', onBufferedLow);
          readNextChunk();
        };
        dc.addEventListener('bufferedamountlow', onBufferedLow);
      } else {
        setTimeout(readNextChunk, 0);
      }
    } catch (err) {
      console.error('DataChannel send error:', err);
      showSenderStatus('error', '✗ Transfer failed: ' + escHtml(err.message || 'DataChannel error'));
      isTransferring = false;
    }
  };

  reader.onerror = (err) => {
    console.error('FileReader error:', err);
    showSenderStatus('error', '✗ Error reading local file');
    isTransferring = false;
  };

  readNextChunk();
}

// ─────────────────────────────────────────────
// RECEIVER — Code Input & Paste Handlers
// ─────────────────────────────────────────────
function codeInput(el, idx) {
  el.value = el.value.replace(/\D/g, '').slice(-1);
  triggerHaptic(8);
  if (el.value && idx < 5) {
    const nextInput = document.getElementById('ci' + (idx + 1));
    if (nextInput) nextInput.focus();
  }
  checkCodeComplete();
}

function codeBack(e, idx) {
  if (e.key === 'Backspace' && !e.target.value && idx > 0) {
    const prevInput = document.getElementById('ci' + (idx - 1));
    if (prevInput) prevInput.focus();
  }
}

function handleCodePaste(e) {
  e.preventDefault();
  const clipboard = e.clipboardData || window.clipboardData;
  if (!clipboard) return;
  const pasted = clipboard.getData('text') || '';
  applyCodeString(pasted);
}

async function pasteCodeToInputs() {
  triggerHaptic(12);
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text) {
        applyCodeString(text);
        return;
      }
    }
  } catch (e) {
    console.warn('Clipboard read error:', e);
  }
  const promptVal = window.prompt('Paste 6-digit code:');
  if (promptVal) applyCodeString(promptVal);
}

function applyCodeString(rawText) {
  const digits = rawText.replace(/\D/g, '').slice(0, 6);
  if (!digits) return;

  for (let i = 0; i < 6; i++) {
    const input = document.getElementById('ci' + i);
    if (input) input.value = i < digits.length ? digits[i] : '';
  }

  const focusIndex = Math.min(digits.length, 5);
  const targetInput = document.getElementById('ci' + focusIndex);
  if (targetInput) targetInput.focus();
  checkCodeComplete();
}

function checkCodeComplete() {
  const code = getCode();
  const btn = document.getElementById('connect-btn');
  if (btn) {
    btn.disabled = code.length !== 6;
    if (code.length === 6) {
      btn.focus();
      triggerHaptic(15);
    }
  }
}

function getCode() {
  return Array.from({ length: 6 }, (_, i) => {
    const el = document.getElementById('ci' + i);
    return el ? el.value : '';
  }).join('');
}

// ─────────────────────────────────────────────
// RECEIVER — Connect & Receive Pipeline
// ─────────────────────────────────────────────
async function initReceiver(prefilledCode = null) {
  triggerHaptic(20);
  currentRole = 'receiver';
  const code = prefilledCode || getCode();
  if (code.length !== 6) return;

  if (conn) {
    try { conn.close(); } catch(e){}
    conn = null;
  }
  if (peer) {
    try { peer.destroy(); } catch(e){}
    peer = null;
  }
  recvMeta = null;
  recvChunks = [];
  recvReceived = 0;

  const connectBtn = document.getElementById('connect-btn');
  if (connectBtn) connectBtn.disabled = true;
  
  showRecvStatus('info', '🔗 Connecting to signaling server…', true);

  const config = await getPeerConfig();
  console.log('[FileDrop] Initializing receiver with config:', config);
  peer = new Peer(config);

  let connectTimer = null;
  let overallTimeoutTimer = null;

  peer.on('open', (id) => {
    console.log('[FileDrop] Receiver peer registered on signaling server with ID:', id);
    showRecvStatus('info', '🔗 Reaching sender code ' + code + '…', true);
    
    conn = peer.connect(code, { reliable: true });

    connectTimer = setTimeout(() => {
      if (!conn || !conn.open) {
        showRecvStatus('info', '⏳ Exchanging network routes & NAT candidates with sender…', true);
      }
    }, 4000);

    overallTimeoutTimer = setTimeout(() => {
      if (!conn || !conn.open) {
        showRecvStatus('error', '✗ Connection timed out. Make sure sender is on the "Share Code" screen.');
        if (connectBtn) connectBtn.disabled = false;
      }
    }, 28000);

    function hookReceiverIce() {
      const pc = conn.peerConnection || (conn._dc && conn._dc._pc);
      if (pc && !pc._iceHooked) {
        pc._iceHooked = true;
        pc.oniceconnectionstatechange = () => {
          const state = pc.iceConnectionState;
          console.log('[FileDrop Receiver] ICE state:', state);
          if (state === 'checking') {
            showRecvStatus('info', '🔍 Negotiating network route (STUN/TURN)…', true);
          } else if (state === 'connected' || state === 'completed') {
            showRecvStatus('success', '✅ Route established! Direct P2P link active.', true);
          } else if (state === 'failed') {
            showRecvStatus('info', '🔄 Direct route blocked by carrier NAT, switching to TURN relay…', true);
          }
        };
      }
    }
    hookReceiverIce();
    setTimeout(hookReceiverIce, 400);
    setTimeout(hookReceiverIce, 1500);

    conn.on('open', () => {
      clearTimeout(connectTimer);
      clearTimeout(overallTimeoutTimer);
      console.log('[FileDrop Receiver] DataChannel is OPEN with sender!');
      showRecvStatus('success', '✅ Connected to sender! Direct P2P channel active.', true);
      triggerHaptic([20, 50]);
      onPeerConnected('receiver');

      try {
        conn.send(JSON.stringify({ type: 'ready' }));
      } catch (e) {}
    });

    conn.on('data', (data) => {
      // 1. JSON String (metadata, done signal, text message)
      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'text') {
            handleIncomingText(msg, 'receiver');
            return;
          } else if (msg.type === 'meta') {
            recvMeta = msg;
            recvChunks = [];
            recvReceived = 0;
            lastBytes = 0;
            lastTime = Date.now();
            document.getElementById('recv-progress').classList.add('visible');
            showRecvStatus('info', `📦 Receiving: ${escHtml(msg.name)} (${formatSize(msg.size)})`, true);
            return;
          } else if (msg.type === 'done') {
            onReceiveComplete();
            return;
          }
        } catch (parseErr) {
          console.error('[FileDrop Receiver] Failed to parse message:', parseErr);
        }
        return;
      }

      // 2. Binary file data chunks (ArrayBuffer, Uint8Array, or Blob)
      let chunkBuffer = null;
      let chunkSize = 0;

      if (data instanceof ArrayBuffer) {
        chunkBuffer = data;
        chunkSize = data.byteLength;
      } else if (ArrayBuffer.isView(data)) {
        chunkBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        chunkSize = data.byteLength;
      } else if (data instanceof Blob) {
        chunkBuffer = data;
        chunkSize = data.size;
      }

      if (chunkBuffer && chunkSize > 0) {
        recvChunks.push(chunkBuffer);
        recvReceived += chunkSize;

        if (recvMeta) {
          const p = Math.min(100, Math.round((recvReceived / recvMeta.size) * 100));
          document.getElementById('recv-fill').style.width = p + '%';
          document.getElementById('recv-pct').textContent = p + '%';

          const now = Date.now();
          const elapsed = (now - lastTime) / 1000;
          if (elapsed >= 0.5 || recvReceived >= recvMeta.size) {
            const currentSpeed = (recvReceived - lastBytes) / (elapsed || 0.001);
            const remainingBytes = Math.max(0, recvMeta.size - recvReceived);
            const etaSeconds = currentSpeed > 0 ? Math.ceil(remainingBytes / currentSpeed) : 0;
            const recvSpeedEl = document.getElementById('recv-speed');
            if (recvSpeedEl) {
              recvSpeedEl.innerHTML = `<span>Speed: <strong>${formatSpeed(currentSpeed)}</strong></span><span>${etaSeconds > 0 ? 'ETA: ' + formatTime(etaSeconds) : 'Finalizing…'}</span>`;
            }
            lastTime = now;
            lastBytes = recvReceived;
          }
        }
      }
    });

    conn.on('close', () => {
      clearTimeout(connectTimer);
      clearTimeout(overallTimeoutTimer);
      if (connectBtn) connectBtn.disabled = false;
      onPeerDisconnected('receiver');
      if (recvMeta && recvReceived < recvMeta.size) {
        showRecvStatus('error', '✗ Sender disconnected before transfer finished.');
      }
    });

    conn.on('error', (e) => {
      clearTimeout(connectTimer);
      clearTimeout(overallTimeoutTimer);
      if (connectBtn) connectBtn.disabled = false;
      onPeerDisconnected('receiver');
      showRecvStatus('error', '✗ ' + escHtml(e ? (e.message || String(e)) : 'Connection failed'));
    });
  });

  peer.on('error', (e) => {
    clearTimeout(connectTimer);
    clearTimeout(overallTimeoutTimer);
    let msg = e.message || e.type || 'Error';
    if (e.type === 'peer-unavailable') {
      msg = `Code "${code}" not found. Verify the code and ensure the sender generated it.`;
    } else if (e.type === 'network' || e.type === 'server-error') {
      msg = `Cannot reach signaling server. Make sure 'npm start' is running!`;
    }
    showRecvStatus('error', '✗ ' + escHtml(msg));
    if (connectBtn) connectBtn.disabled = false;
  });
}

function onReceiveComplete() {
  if (downloadUrl) {
    try { URL.revokeObjectURL(downloadUrl); } catch(e){}
    downloadUrl = null;
  }

  const mimeType = (recvMeta && recvMeta.fileType) ? recvMeta.fileType : 'application/octet-stream';
  const blob = new Blob(recvChunks, { type: mimeType });
  downloadUrl = URL.createObjectURL(blob);
  recvChunks = []; // Release chunk buffers immediately

  const card = document.getElementById('download-card');
  document.getElementById('dl-name').textContent = recvMeta.name;
  document.getElementById('dl-size').textContent = formatSize(blob.size || recvMeta.size);

  const dlBtn = document.getElementById('dl-btn');
  dlBtn.onclick = () => {
    triggerHaptic(20);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = recvMeta.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  card.classList.add('visible');
  showRecvStatus('success', '✅ File received and ready to download!');
  document.getElementById('recv-progress').classList.remove('visible');

  const recvSpeedEl = document.getElementById('recv-speed');
  if (recvSpeedEl) recvSpeedEl.innerHTML = '';
  const connectBtn = document.getElementById('connect-btn');
  if (connectBtn) connectBtn.disabled = false;

  triggerHaptic([40, 100, 40]);
}

// ─────────────────────────────────────────────
// TEXT & CLIPBOARD SHARING MANAGEMENT
// ─────────────────────────────────────────────
function onPeerConnected(role) {
  console.log(`[FileDrop] onPeerConnected called for role: ${role}`);
  const textSecId = role === 'sender' ? 'sender-text-section' : 'receiver-text-section';
  const textSec = document.getElementById(textSecId);
  if (textSec) textSec.style.display = 'block';

  const pillId = role === 'sender' ? 'sender-peer-pill' : 'receiver-peer-pill';
  const pill = document.getElementById(pillId);
  if (pill) {
    pill.className = 'peer-status-pill online';
    pill.innerHTML = '🟢 Connected';
  }
}

function onPeerDisconnected(role) {
  console.log(`[FileDrop] onPeerDisconnected called for role: ${role}`);
  const pillId = role === 'sender' ? 'sender-peer-pill' : 'receiver-peer-pill';
  const pill = document.getElementById(pillId);
  if (pill) {
    pill.className = 'peer-status-pill disconnected';
    pill.innerHTML = '🔴 Disconnected';
  }
}

function sendSharedText(fromRole) {
  triggerHaptic(12);
  const inputId = fromRole === 'sender' ? 'sender-text-input' : 'receiver-text-input';
  const input = document.getElementById(inputId);
  if (!input) return;
  const rawText = input.value.trim();
  if (!rawText) {
    input.focus();
    return;
  }

  if (!conn || !conn.open) {
    alert('Cannot send text: WebRTC connection is not active.');
    return;
  }

  const payload = {
    type: 'text',
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    text: rawText,
    senderRole: fromRole,
    timestamp: Date.now()
  };

  try {
    conn.send(JSON.stringify(payload));
    input.value = '';
    addMessageToHistory(fromRole, payload, true);
  } catch (err) {
    console.error('Failed to send shared text:', err);
    alert('Failed to send text: ' + (err.message || 'Connection error'));
  }
}

function playChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.19);
  } catch (e) {}
}

function handleIncomingText(msg, forRole) {
  console.log(`[FileDrop] Incoming text message for ${forRole}:`, msg);
  playChime();
  triggerHaptic([30, 60]);

  if (forRole === 'receiver') {
    latestReceivedText = msg.text;

    const emptyState = document.getElementById('receiver-text-empty');
    if (emptyState) emptyState.style.display = 'none';

    const displayBox = document.getElementById('receiver-text-display');
    const contentEl = document.getElementById('receiver-text-content');
    const timeEl = document.getElementById('receiver-text-time');

    if (contentEl) contentEl.textContent = msg.text;
    if (timeEl) timeEl.textContent = formatTimestamp(msg.timestamp);

    if (displayBox) {
      displayBox.style.display = 'block';
      displayBox.classList.remove('highlight-pulse');
      void displayBox.offsetWidth;
      displayBox.classList.add('highlight-pulse');
    }

    addMessageToHistory('receiver', msg, false);
  } else if (forRole === 'sender') {
    latestSenderReplyText = msg.text;

    const replyBox = document.getElementById('sender-reply-display');
    const contentEl = document.getElementById('sender-reply-content');
    const timeEl = document.getElementById('sender-reply-time');

    if (contentEl) contentEl.textContent = msg.text;
    if (timeEl) timeEl.textContent = formatTimestamp(msg.timestamp);

    if (replyBox) {
      replyBox.style.display = 'block';
      replyBox.classList.remove('highlight-pulse');
      void replyBox.offsetWidth;
      replyBox.classList.add('highlight-pulse');
    }

    addMessageToHistory('sender', msg, false);
  }
}

function copyLatestReceivedText() {
  if (!latestReceivedText) return;
  const btn = document.getElementById('receiver-copy-btn');
  copyToClipboard(latestReceivedText, btn, '✓ Copied Text!');
}

function copySenderReplyText() {
  if (!latestSenderReplyText) return;
  const btn = document.getElementById('sender-copy-reply-btn');
  copyToClipboard(latestSenderReplyText, btn, '✓ Copied Text!');
}

function copyToClipboard(text, buttonEl, successLabel = '✓ Copied!') {
  if (!text) return;
  triggerHaptic(15);

  function showSuccess() {
    if (!buttonEl) return;
    const origHtml = buttonEl.innerHTML;
    buttonEl.innerHTML = `<span class="copy-icon">✓</span> <span class="copy-label">${successLabel}</span>`;
    buttonEl.classList.add('copied');
    setTimeout(() => {
      buttonEl.innerHTML = origHtml;
      buttonEl.classList.remove('copied');
    }, 2000);
  }

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text)
      .then(showSuccess)
      .catch(() => fallbackCopy(text, showSuccess));
  } else {
    fallbackCopy(text, showSuccess);
  }
}

function fallbackCopy(text, callback) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  ta.setAttribute('readonly', '');
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let success = false;
  try {
    success = document.execCommand('copy');
  } catch (err) {
    console.warn('execCommand copy failed:', err);
  }
  document.body.removeChild(ta);

  if (success && callback) {
    callback();
  } else if (!success) {
    window.prompt('Copy text (Ctrl+C, then Enter):', text);
  }
}

async function pasteToSenderInput() {
  triggerHaptic(12);
  const input = document.getElementById('sender-text-input');
  if (!input) return;
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text) {
        input.value = (input.value ? input.value + '\n' : '') + text;
        input.focus();
        return;
      }
    }
  } catch (e) {
    console.warn('Clipboard read error or not permitted:', e);
  }
  input.focus();
}

function toggleReceiverReply() {
  triggerHaptic(10);
  const box = document.getElementById('receiver-reply-box');
  const icon = document.getElementById('reply-toggle-icon');
  if (!box) return;
  const isHidden = box.style.display === 'none' || !box.style.display;
  box.style.display = isHidden ? 'block' : 'none';
  if (icon) icon.textContent = isHidden ? '▾' : '▸';
  if (isHidden) {
    const input = document.getElementById('receiver-text-input');
    if (input) input.focus();
  }
}

function formatTimestamp(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function addMessageToHistory(role, msg, isOutgoing) {
  const historyList = (role === 'sender') ? senderHistory : receiverHistory;
  historyList.unshift({ ...msg, isOutgoing });

  const containerId = role === 'sender' ? 'sender-text-history' : 'receiver-text-history';
  const wrapId = role === 'sender' ? 'sender-text-history-wrap' : 'receiver-text-history-wrap';
  const countId = role === 'sender' ? 'sender-history-count' : 'receiver-history-count';

  const container = document.getElementById(containerId);
  const wrap = document.getElementById(wrapId);
  const count = document.getElementById(countId);

  if (count) count.textContent = historyList.length;
  if (wrap) wrap.style.display = 'block';
  if (container) {
    container.innerHTML = historyList.map((item, idx) => {
      const prefix = item.isOutgoing ? '↗ You: ' : '↙ Peer: ';
      const snippet = escHtml(item.text.length > 60 ? item.text.slice(0, 60) + '…' : item.text);
      return `
        <div class="history-item">
          <div class="history-item-preview">${prefix}${snippet}</div>
          <div class="history-item-meta">
            <span class="history-item-time">${formatTimestamp(item.timestamp)}</span>
            <button type="button" class="btn-mini-copy" onclick="copyHistoryItemDirect(${idx}, '${role}')" title="Copy message">⧉ Copy</button>
          </div>
        </div>
      `;
    }).join('');
  }
}

function copyHistoryItemDirect(idx, role) {
  const historyList = (role === 'sender') ? senderHistory : receiverHistory;
  const item = historyList[idx];
  if (!item || !item.text) return;
  const containerId = role === 'sender' ? 'sender-text-history' : 'receiver-text-history';
  const container = document.getElementById(containerId);
  let btn = null;
  if (container) {
    const items = container.querySelectorAll('.btn-mini-copy');
    if (items[idx]) btn = items[idx];
  }
  copyToClipboard(item.text, btn, '✓ Copied');
}

function setupTextKeyListeners() {
  ['sender-text-input', 'receiver-text-input'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        const role = id.startsWith('sender') ? 'sender' : 'receiver';
        sendSharedText(role);
      }
    });
  });
}

// ─────────────────────────────────────────────
// NETWORK MODAL MANAGEMENT
// ─────────────────────────────────────────────
function toggleNetworkModal() {
  triggerHaptic(12);
  const modal = document.getElementById('network-modal');
  if (!modal) return;
  modal.classList.toggle('open');
}

function closeNetworkModal(e) {
  const modal = document.getElementById('network-modal');
  if (modal && e.target === modal) {
    modal.classList.remove('open');
  }
}

function copyMobileUrl() {
  const input = document.getElementById('modal-mobile-url');
  if (!input) return;
  const btn = document.getElementById('modal-copy-url-btn');
  copyToClipboard(input.value, btn, '✓ Copied');
}

function renderModalQr(url) {
  const container = document.getElementById('modal-qrcode-container');
  if (!container || typeof QRCode === 'undefined') return;
  container.innerHTML = '';
  try {
    modalQrInstance = new QRCode(container, {
      text: url,
      width: 150,
      height: 150,
      colorDark: '#070a10',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch (e) {
    console.warn('Modal QR Code error:', e);
  }
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
function showSenderStatus(type, msg) {
  const el = document.getElementById('sender-status');
  if (!el) return;
  el.className = 'status-bar ' + type;
  el.innerHTML = `<div class="status-dot${type === 'info' ? ' pulse' : ''}"></div><span>${msg}</span>`;
}

function showRecvStatus(type, msg, pulse = false) {
  const el = document.getElementById('recv-status');
  if (!el) return;
  el.className = 'status-bar ' + type;
  el.innerHTML = `<div class="status-dot${pulse ? ' pulse' : ''}"></div><span>${msg}</span>`;
}

function copyCode() {
  if (!senderCode) return;
  const btn = document.getElementById('copy-code-btn') || document.querySelector('.copy-btn');
  copyToClipboard(senderCode, btn, '✓ Copied Code');
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s';
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
  return (bytesPerSec / (1024 * 1024)).toFixed(2) + ' MB/s';
}

function formatTime(totalSeconds) {
  if (totalSeconds < 60) return totalSeconds + 's';
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}m ${secs}s`;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getFileEmoji(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  const map = {
    pdf: '📄', doc: '📝', docx: '📝', xls: '📊', xlsx: '📊', ppt: '📑', pptx: '📑',
    zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
    mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵',
    js: '💻', ts: '💻', py: '💻', html: '💻', css: '💻', json: '💻',
    exe: '⚙️', dmg: '⚙️', apk: '⚙️',
    txt: '📃',
  };
  return map[ext] || '📁';
}

// ─────────────────────────────────────────────
// URL PARAMETER AUTO-CONNECT
// e.g. http://192.168.1.5:9000/?code=123456
// ─────────────────────────────────────────────
function checkUrlParameters() {
  const params = new URLSearchParams(window.location.search);
  const codeParam = params.get('code') || params.get('c') || params.get('receive');
  if (codeParam && codeParam.length === 6 && /^\d{6}$/.test(codeParam)) {
    console.log('[FileDrop] Detected auto-connect code in URL:', codeParam);
    showView('receiver');
    applyCodeString(codeParam);
    setTimeout(() => {
      initReceiver(codeParam);
    }, 500);
  }
}

// Keyboard shortcuts (Escape to go back)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('network-modal');
    if (modal && modal.classList.contains('open')) {
      modal.classList.remove('open');
      return;
    }
    if (currentRole) {
      resetAll();
    }
  }
});

// Window resize listener to keep device tag accurate
window.addEventListener('resize', () => {
  detectDevice();
});

// Initialization on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  detectDevice();
  checkServerStatus();
  setupTextKeyListeners();
  checkUrlParameters();
});
