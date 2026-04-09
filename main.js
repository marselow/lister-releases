const { app, BrowserWindow, ipcMain, session, Notification } = require('electron');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');
const fs     = require('fs');
const os     = require('os');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const GH_OWNER   = 'marselow';
const GH_REPO    = 'lister-releases';
const APP_VER    = app.getVersion(); // from package.json

// ── CUSTOM UPDATER ────────────────────────────────────────────────────────────
function compareVer(a, b) {
  const pa = a.replace(/^v/,'').split('.').map(Number);
  const pb = b.replace(/^v/,'').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i]||0) > (pb[i]||0)) return 1;
    if ((pa[i]||0) < (pb[i]||0)) return -1;
  }
  return 0;
}

function httpsGetFollow(url, extraHeaders = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects'));
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch(e) { return reject(e); }
    const opts = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': `MeowlLister/${APP_VER}`,
        'Accept': 'application/vnd.github+json',
        ...extraHeaders
      },
      timeout: 20000
    };
    const req = https.get(opts, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        req.destroy();
        resolve(httpsGetFollow(res.headers.location, extraHeaders, redirects + 1));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

async function fetchLatestYml() {
  const url = `https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest/download/latest.yml`;
  const res = await httpsGetFollow(url);
  return new Promise((resolve, reject) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode} ao buscar latest.yml`));
      const verMatch  = data.match(/^version:\s*['"]?([^\s'"]+)['"]?/m);
      const pathMatch = data.match(/^path:\s*['"]?([^\r\n'"]+)['"]?/m);
      if (!verMatch) return reject(new Error('version não encontrada em latest.yml'));
      const version     = verMatch[1].trim();
      const filename    = pathMatch ? pathMatch[1].trim() : null;
      const downloadUrl = filename
        ? `https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest/download/${encodeURIComponent(filename)}`
        : null;
      resolve({ version, downloadUrl });
    });
    res.on('error', reject);
  });
}

async function downloadToFile(url, destPath, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await httpsGetFollow(url);
      if (res.statusCode !== 200)
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const file = fs.createWriteStream(destPath);

      res.on('data', chunk => {
        received += chunk.length;
        if (total > 0 && onProgress) onProgress(Math.round(received * 100 / total));
      });
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
      res.on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
    } catch(e) { reject(e); }
  });
}

// IPC: renderer asks "any update?"
ipcMain.handle('check-update', async () => {
  try {
    const { version: latest, downloadUrl } = await fetchLatestYml();
    if (compareVer(latest, APP_VER) > 0) {
      return { available: true, version: latest, current: APP_VER, url: downloadUrl };
    }
    return { available: false, current: APP_VER };
  } catch(e) {
    return { available: false, current: APP_VER, error: e.message };
  }
});

// IPC: renderer says "download + install"
ipcMain.on('start-update-download', async (event, downloadUrl) => {
  const tmpPath = path.join(os.tmpdir(), 'MeowlListerSetup.exe');
  try {
    await downloadToFile(downloadUrl, tmpPath, (pct) => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('update-dl-progress', pct);
    });
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('update-dl-done');
    // Give renderer 1.5s to show "done", then launch installer silently and quit
    setTimeout(() => {
      spawn(tmpPath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
      app.quit();
    }, 1500);
  } catch(e) {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('update-dl-error', e.message);
  }
});
// ─────────────────────────────────────────────────────────────────────────────

let mainWindow;

// ── EXTENSION BRIDGE (local WebSocket, no server) ────────────────────────────
const EXT_PORT   = 47832;
let   _pairCode  = _genCode();
let   _extSocket = null;
let   _wss       = null;

function _genCode() {
  return crypto.randomBytes(10).toString('hex').toUpperCase();
}

function startExtBridge() {
  _wss = new WebSocketServer({ host: '127.0.0.1', port: EXT_PORT });

  _wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      setTimeout(startExtBridge, 2000);
    }
  });

  _wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { ws.close(); return; }

      if (!msg.code || msg.code !== _pairCode) { ws.close(); return; }

      if (msg.type === 'auth' || msg.type === 'cookie') {
        _extSocket = ws;
        if (msg.cookie && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ext-cookie', msg.cookie);
        }
      }
      if (msg.type === 'auto-message-status') {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auto-message-status', { orderId: msg.orderId, status: msg.status });
        }
      }
    });

    ws.on('close', () => {
      if (_extSocket === ws) {
        _extSocket = null;
        _pairCode = _genCode();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ext-code', _pairCode);
          mainWindow.webContents.send('ext-status', 'disconnected');
        }
      }
    });

    ws.on('error', () => ws.close());
  });
}

ipcMain.handle('get-ext-code', () => _pairCode);
// ─────────────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Meowl Lister',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    frame: false,
    transparent: false,
    backgroundColor: '#0a0e1a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.webContents.openDevTools();
    // Auto-check on startup (slight delay so UI is settled)
    if (app.isPackaged) {
      setTimeout(async () => {
        try {
          const { version: latest, downloadUrl } = await fetchLatestYml();
          if (compareVer(latest, APP_VER) > 0) {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('update-available-auto', { version: latest, url: downloadUrl });
            }
          }
        } catch(e) {
          console.log('[updater] startup check error:', e.message);
        }
      }, 4000);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  ipcMain.on('logout-reload', () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.on('send-to-extension', (_event, data) => {
    const status = _extSocket ? 'socket state=' + _extSocket.readyState : 'NO SOCKET';
    if (_extSocket && _extSocket.readyState === 1) {
      _extSocket.send(JSON.stringify(data));
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('debug-log', '[main] SENT to extension: ' + JSON.stringify(data).slice(0, 200));
      }
    } else {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('debug-log', '[main] FAILED - ' + status);
      }
    }
  });

  ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.close();
  });

  ipcMain.on('show-notification', (_event, { title, body }) => {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: false }).show();
    }
  });

  ipcMain.on('open-login-window', (event) => {
    const loginWin = new BrowserWindow({
      width: 1100,
      height: 700,
      title: 'Login Eldorado',
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    loginWin.loadURL('https://www.eldorado.gg/login');

    const checkLogin = setInterval(async () => {
      if (loginWin.isDestroyed()) { clearInterval(checkLogin); return; }
      try {
        const cookies = await loginWin.webContents.session.cookies.get({ domain: 'eldorado.gg' });
        const hasSession = cookies.some(c => c.name === 'pseudoId' || c.name === '__Host-XSRF-TOKEN');
        if (hasSession) {
          clearInterval(checkLogin);
          const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          event.sender.send('login-cookie', cookieStr);
          loginWin.close();
        }
      } catch (e) {}
    }, 1500);

    loginWin.on('closed', () => clearInterval(checkLogin));
  });

  // ── DIRECT IMAGE UPLOAD ──────────────────────────────────────────────────────
  ipcMain.handle('upload-image-via-page', async (event, { imageBase64, cookieStr }) => {
    return new Promise((resolve) => {
      try {
        const imageBuffer = Buffer.from(imageBase64, 'base64');
        const boundary = '----EldoBoundary' + Date.now().toString(16);

        const part1 = Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="image"; filename="listing.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`
        );
        const part2 = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([part1, imageBuffer, part2]);

        const xsrfMatch = cookieStr.match(/__Host-XSRF-TOKEN=([^;]+)/);
        const xsrf = xsrfMatch ? decodeURIComponent(xsrfMatch[1]) : '';

        const headers = {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          'Cookie': cookieStr,
          'Origin': 'https://www.eldorado.gg',
          'Referer': 'https://www.eldorado.gg/sell',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        };
        if (xsrf) headers['X-XSRF-TOKEN'] = xsrf;

        const req = https.request({
          hostname: 'www.eldorado.gg',
          path: '/api/files/me/Offer',
          method: 'POST',
          headers,
        }, (res) => {
          let raw = '';
          res.on('data', c => raw += c);
          res.on('end', () => {
            console.log('[upload] resposta:', res.statusCode, raw.slice(0, 300));
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: raw });
          });
        });
        req.on('error', e => { console.error('[upload] req error:', e.message); resolve({ ok: false, error: e.message }); });
        req.write(body);
        req.end();
      } catch(e) {
        resolve({ ok: false, error: e.message });
      }
    });
  });
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('get-talkjs-token', async (event, cookieStr) => {
    console.log('[Main] [TalkJS] ========== TOKEN FETCH START ==========');
    return new Promise((resolve) => {
      const partition = 'inmemory:talkjs-token-' + Date.now();
      const ses = session.fromPartition(partition);
      ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      let resolved = false;
      let timeoutId = null;

      const done = (token) => {
        if (resolved) return;
        resolved = true;
        if (timeoutId) clearTimeout(timeoutId);
        console.log('[Main] [TalkJS] Token result:', token ? '✓ Token acquired' : '✗ No token');
        try { hiddenWin.destroy(); } catch(e) {
          console.error('[Main] [TalkJS] Error on window destroy:', e.message);
        }
        resolve(token);
      };

      // Intercept the TalkJS WebSocket upgrade — authToken is in the URL
      console.log('[Main] [TalkJS] Setting up WebSocket interceptor...');
      ses.webRequest.onBeforeRequest({ urls: ['wss://app.talkjs.com/*', 'wss://realtime.talkjs.com/*'] }, (details, callback) => {
        try {
          console.log('[Main] [TalkJS] WebSocket request intercepted:', details.url.substring(0, 100));
          const u = new URL(details.url);
          const token = u.searchParams.get('authToken');
          if (token) {
            console.log('[Main] [TalkJS] ✓ authToken found in URL');
            done(token);
          } else {
            console.log('[Main] [TalkJS] No authToken in params:', u.searchParams.toString());
          }
        } catch(e) {
          console.error('[Main] [TalkJS] Error parsing WebSocket URL:', e.message);
        }
        callback({});
      });

      // Also intercept API responses for talkjs token
      console.log('[Main] [TalkJS] Setting up API response interceptor...');
      ses.webRequest.onCompleted({ urls: ['https://www.eldorado.gg/api/*', 'https://api.eldorado.gg/*'] }, (details) => {
        try {
          if (details.statusCode === 200 && (details.url.includes('/users/') || details.url.includes('profile'))) {
            console.log('[Main] [TalkJS] API response received:', details.url.substring(0, 80));
          }
        } catch(e) {}
      });

      // Also intercept any Eldorado API response that contains a TalkJS JWT
      console.log('[Main] [TalkJS] Creating hidden BrowserWindow to load Eldorado...');

      const hiddenWin = new BrowserWindow({
        show: false,
        webPreferences: {
          session: ses,
          nodeIntegration: false,
          contextIsolation: true,
        }
      });

      console.log('[Main] [TalkJS] Loading Eldorado dashboard messages...');
      hiddenWin.loadURL('https://www.eldorado.gg/dashboard/messages', {
        extraHeaders: `Cookie: ${cookieStr}\r\n`
      });

      hiddenWin.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        console.error('[Main] [TalkJS] Failed to load URL:', errorCode, errorDescription);
        // Timeout immediately on failure
        setTimeout(() => done(null), 1000);
      });

      hiddenWin.webContents.on('did-finish-load', () => {
        console.log('[Main] [TalkJS] Page loaded, executing token extraction script...');
        // Try to extract token from the page via JavaScript
        hiddenWin.webContents.executeJavaScript(`
          (function() {
            try {
              // Look for token in window object
              if (window.talkjsToken) {
                return { token: window.talkjsToken };
              }
              // Look for token in localStorage
              const token = localStorage.getItem('talkjs_token') || localStorage.getItem('authToken');
              if (token) {
                return { token: token };
              }
              // Look in sessionStorage
              const sesToken = sessionStorage.getItem('talkjs_token') || sessionStorage.getItem('authToken');
              if (sesToken) {
                return { token: sesToken };
              }
              return { token: null };
            } catch(e) {
              console.error('Error extracting token:', e.message);
              return { token: null };
            }
          })();
        `).then(result => {
          console.log('[Main] [TalkJS] Page script result:', result);
          if (result && result.token) {
            console.log('[Main] [TalkJS] ✓ Token extracted from page');
            done(result.token);
          }
        }).catch(err => {
          console.error('[Main] [TalkJS] Error executing page script:', err.message);
        });
      });

      // Timeout after 25s
      timeoutId = setTimeout(() => {
        console.warn('[Main] [TalkJS] ⚠ Token fetch timeout (25s)');
        done(null);
      }, 25000);
    });
  });

  ipcMain.handle('set-chat-cookies', async (event, cookieStr) => {
    const ses = session.fromPartition('inmemory:eldorado');
    ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    const pairs = cookieStr.split(';');
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const name = pair.substring(0, eqIdx).trim();
      const value = pair.substring(eqIdx + 1).trim();
      if (!name) continue;
      try {
        const cookieObj = { url: 'https://www.eldorado.gg', name, value, path: '/', secure: true };
        if (!name.startsWith('__Host-')) cookieObj.domain = '.eldorado.gg';
        await ses.cookies.set(cookieObj);
      } catch(e) {}
    }
    return true;
  });
}

app.whenReady().then(() => {
  createWindow();
  try {
    require('child_process').execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${EXT_PORT}') do taskkill /F /PID %a`, { shell: 'cmd.exe', timeout: 3000 });
  } catch {}
  startExtBridge();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
