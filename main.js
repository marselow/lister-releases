const { app, BrowserWindow, ipcMain, session, Notification, dialog, shell, net } = require('electron');

app.commandLine.appendSwitch('disable-features', 'BluetoothSerial,WebBluetooth');
app.commandLine.appendSwitch('disable-bluetooth');
const path   = require('path');
const crypto = require('crypto');
const https  = require('https');
const zlib   = require('zlib');
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

ipcMain.handle('get-app-version', () => APP_VER);

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
const _pendingExtRequests = new Map(); // id → { resolve, timer }

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
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ext-status', 'connected');
          if (msg.cookie) {
            mainWindow.webContents.send('ext-cookie', msg.cookie);
          }
        }
      }
      if (msg.type === 'auto-message-status') {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auto-message-status', { orderId: msg.orderId, status: msg.status });
        }
      }

      if (msg.type === 'api-response') {
        const pending = _pendingExtRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          _pendingExtRequests.delete(msg.id);
          pending.resolve(msg);
        }
      }
    });

    ws.on('close', () => {
      if (_extSocket === ws) {
        _extSocket = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ext-status', 'disconnected');
        }
      }
    });

    ws.on('error', () => ws.close());
  });
}

ipcMain.handle('get-ext-code', () => _pairCode);
// ─────────────────────────────────────────────────────────────────────────────

// ── Multi-Roblox singleton bypass ────────────────────────────────────────────
//
// Roblox enforces "one instance only" via a Win32 named kernel object that the
// player creates on launch. When a second player starts, it sees the object
// already exists and exits. The trick to multi-instance is to create that
// object FIRST, from a long-lived helper process — so every Roblox launch sees
// it but the helper is the "owner". Roblox then doesn't try to enforce
// singleton semantics (it assumes some other singleton-aware process is in
// charge) and the new instance launches normally.
//
// RBX Alt Manager does this via `new Mutex(true, "ROBLOX_singletonMutex")`
// (AccountManager.cs:1261). We can't call CreateMutex directly from Node
// without a native module, so we spawn a hidden PowerShell that creates the
// kernel objects and sleeps forever. The handle stays open as long as the
// powershell process is alive — which is exactly what we want. We kill it on
// app quit.
//
// Modern Roblox versions also use `ROBLOX_singletonEvent` (an Event object,
// not a Mutex), so we hold both names to be safe.
let rbxMultiMutexProc = null;

function ensureRobloxMultiMutex() {
  if (process.platform !== 'win32') return false;
  if (rbxMultiMutexProc && rbxMultiMutexProc.exitCode === null) return true;

  // PowerShell that creates both kernel objects with initiallyOwned=true and
  // sleeps forever. -EncodedCommand avoids any quoting nightmare with -Command.
  const psSrc =
    "$ErrorActionPreference='SilentlyContinue';" +
    "try{$m1=New-Object System.Threading.Mutex($true,'ROBLOX_singletonMutex')}catch{};" +
    "try{$m2=New-Object System.Threading.Mutex($true,'ROBLOX_singletonEvent')}catch{};" +
    "[System.Threading.Thread]::Sleep([System.Threading.Timeout]::Infinite)";
  const encoded = Buffer.from(psSrc, 'utf16le').toString('base64');

  try {
    rbxMultiMutexProc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-EncodedCommand', encoded
    ], { detached: false, stdio: 'ignore', windowsHide: true });

    rbxMultiMutexProc.on('exit', () => { rbxMultiMutexProc = null; });
    rbxMultiMutexProc.on('error', () => { rbxMultiMutexProc = null; });
    console.log('[multi-roblox] mutex holder spawned, pid=' + rbxMultiMutexProc.pid);
    return true;
  } catch (e) {
    console.log('[multi-roblox] failed to spawn mutex holder:', e.message);
    rbxMultiMutexProc = null;
    return false;
  }
}

function releaseRobloxMultiMutex() {
  if (rbxMultiMutexProc && rbxMultiMutexProc.exitCode === null) {
    try { rbxMultiMutexProc.kill(); } catch {}
    rbxMultiMutexProc = null;
  }
}
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

  // ── Roblox launch feature — mirrors RBX Alt Manager (Account.JoinServer) 1:1 ──
  //
  // This is a direct port of RBX_Alt_Manager/Classes/Account.cs JoinServer().
  // RBX AM uses RestSharp 110.2.0 with its default User-Agent (`RestSharp/110.2.0.0`)
  // — NOT a browser UA. That is critical: Roblox's /games/{id}?privateServerLinkCode=
  // endpoint only emits the legacy inline `Roblox.GameLauncher.joinPrivateGame(id,'UUID')`
  // HTML when requested by a non-browser UA. With a browser UA you get the React SPA
  // shell that has no access code in the markup.
  //
  // Reference (RBX AM source):
  //   Account.cs GetCSRFToken  (line 134)
  //   Account.cs GetAuthTicket (line 112)
  //   Account.cs ParseAccessCode (line 489)
  //   Account.cs JoinServer    (line 505)

  const RBX_REFERER  = 'https://www.roblox.com/games/4924922222/Brookhaven-RP';
  const RBX_UA       = 'RestSharp/110.2.0.0';
  // RestSharp's default Accept includes JSON + XML media types. HTML pages still
  // render for these Accepts, but Roblox selectively ships the legacy inline
  // bootstrap script that contains joinPrivateGame(...) for non-browser clients.
  const RBX_ACCEPT   = 'application/json, text/json, text/x-json, text/javascript, application/xml, text/xml, */*';

  // Raw HTTPS request via Node's https module (gives us direct control over headers
  // and no Chromium / fetch overhead). Automatically handles gzip/deflate and
  // returns { statusCode, headers, body }.
  function rbxHttp({ hostname, path: reqPath, method, headers = {}, followRedirects = true, depth = 0 }) {
    return new Promise((resolve) => {
      if (depth > 8) return resolve({ statusCode: 0, headers: {}, body: '' });
      const req = https.request({
        hostname,
        path: reqPath,
        method,
        headers: {
          'User-Agent':      RBX_UA,
          'Accept':          RBX_ACCEPT,
          'Accept-Encoding': 'gzip, deflate',
          ...headers
        }
      }, (res) => {
        // Follow redirects exactly like RestSharp does by default
        if (followRedirects && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          let loc = res.headers.location;
          let nextHost = hostname, nextPath = loc;
          if (loc.startsWith('http')) {
            try { const u = new URL(loc); nextHost = u.hostname; nextPath = u.pathname + u.search; } catch {}
          }
          return rbxHttp({ hostname: nextHost, path: nextPath, method: 'GET', headers, followRedirects, depth: depth + 1 }).then(resolve);
        }

        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        const chunks = [];
        const stream = enc === 'gzip'    ? res.pipe(zlib.createGunzip())
                     : enc === 'deflate' ? res.pipe(zlib.createInflate())
                     : res;
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers:    res.headers,
            body:       Buffer.concat(chunks).toString('utf8')
          });
        });
        stream.on('error', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: '' }));
      });
      req.on('error',   () => resolve({ statusCode: 0, headers: {}, body: '' }));
      req.setTimeout(20000, () => { req.destroy(); resolve({ statusCode: 0, headers: {}, body: '' }); });
      req.end();
    });
  }

  // Cookie jar — mirrors RestSharp's CookieContainer behavior. RBX AM relies
  // on RestSharp automatically capturing Set-Cookie headers from the first
  // POST (CSRF) and replaying them on the second POST (ticket). Without this
  // the `/v1/authentication-ticket/` endpoint returns the CSRF token fine but
  // then silently drops the ticket on the second call. Raw Node https does
  // not manage cookies at all so we do it ourselves.
  class RbxCookieJar {
    constructor(initial = {}) { this.jar = { ...initial }; }
    // Parse Set-Cookie header (or array) and merge the name=value pairs.
    ingest(setCookieHeader) {
      if (!setCookieHeader) return;
      const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      for (const raw of arr) {
        const first = raw.split(';')[0];
        const eq = first.indexOf('=');
        if (eq > 0) {
          const name = first.slice(0, eq).trim();
          const value = first.slice(eq + 1).trim();
          if (name) this.jar[name] = value;
        }
      }
    }
    // Build a Cookie header value from the jar.
    header() {
      return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    }
  }

  // Port of Account.GetCSRFToken (Account.cs:134) + Account.GetAuthTicket
  // (Account.cs:112) as a SINGLE method because they share a cookie container
  // in the original C# code (AuthClient is a single RestClient with a shared
  // CookieContainer, so Set-Cookies from the first POST automatically flow to
  // the second). We replicate that here.
  async function rbxGetAuthTicketAndCsrf(securityToken) {
    const jar = new RbxCookieJar({ '.ROBLOSECURITY': securityToken });

    const baseHeaders = {
      'Content-Type':   'application/json',
      'Content-Length': '0',
      'Referer':         RBX_REFERER,
      'Origin':          'https://www.roblox.com',
      'User-Agent':      'Roblox/WinInet',
      'rbxauthenticationnegotiation': '1'
    };

    // 1. POST without X-CSRF-TOKEN → 403 + x-csrf-token header (+ possibly Set-Cookie)
    const r1 = await rbxHttp({
      hostname: 'auth.roblox.com',
      path:    '/v1/authentication-ticket/',
      method:  'POST',
      headers: { ...baseHeaders, 'Cookie': jar.header() }
    });
    jar.ingest(r1.headers['set-cookie']);
    const csrf = r1.headers['x-csrf-token'];
    if (!csrf) return { csrf: null, ticket: null, status1: r1.statusCode };

    // 2. POST with X-CSRF-TOKEN → 200 + rbx-authentication-ticket header.
    //    Critical: this request MUST carry the cookies set by step 1 (that's
    //    what RestSharp's CookieContainer does for free in C#).
    const r2 = await rbxHttp({
      hostname: 'auth.roblox.com',
      path:    '/v1/authentication-ticket/',
      method:  'POST',
      headers: { ...baseHeaders, 'Cookie': jar.header(), 'X-CSRF-TOKEN': csrf }
    });
    jar.ingest(r2.headers['set-cookie']);
    const ticket = r2.headers['rbx-authentication-ticket'];
    return { csrf, ticket, status1: r1.statusCode, status2: r2.statusCode, jar };
  }

  // Port of Account.JoinServer section that resolves the private server access
  // code (Account.cs:549-581) and Account.ParseAccessCode (Account.cs:489).
  //
  // GET https://www.roblox.com/games/{placeId}?privateServerLinkCode={linkCode}
  // with the RestSharp default UA, parse the body for:
  //   Roblox.GameLauncher.joinPrivateGame(\d+,\s*'(UUID)'
  //
  // Falls back to web.roblox.com on any non-200 (C# also handles the 302 edge case
  // with Web13Client, which points at web.roblox.com).
  // Resolves a "share code" (from the /share?code=X&type=Server share URL) into
  // the real privateServerLinkCode.
  //
  // A share URL looks like:
  //   https://www.roblox.com/share?code=499487c9b6fe834baede9f33b5279dbb&type=Server
  // which Roblox maps to:
  //   https://www.roblox.com/games/109983668079237/Steal-a-Brainrot?privateServerLinkCode=02041609787314097439909077453964
  //
  // The two codes are NOT interchangeable — using the share code as a
  // privateServerLinkCode returns the normal (non-private-server) game page,
  // which is why the access-code extraction was failing.
  //
  // We try two strategies in order:
  //   1. POST https://apis.roblox.com/sharelinks/v1/resolve-link with JSON body
  //      {"linkId":"<share>","linkType":"Server"}. Returns JSON with
  //      privateServerInviteData.{linkCode, placeId}. This is the cleanest path.
  //   2. If the API fails (404, endpoint change, etc.), fall back to chasing the
  //      HTTP redirect chain of GET /share?code=X&type=Server.
  //
  // Returns { placeId, linkCode } on success, or null on total failure.
  async function rbxResolveShareCode(shareCode, jar, csrf, debugSink) {
    // ── Strategy 1: sharelinks API ─────────────────────────────────────────
    try {
      const bodyJson = JSON.stringify({ linkId: shareCode, linkType: 'Server' });
      const apiRes = await rbxHttpWithBody({
        hostname: 'apis.roblox.com',
        path:    '/sharelinks/v1/resolve-link',
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length':  Buffer.byteLength(bodyJson).toString(),
          'Accept':          'application/json',
          'User-Agent':      'Roblox/WinInet',
          'Referer':         'https://www.roblox.com/',
          'Origin':          'https://www.roblox.com',
          'Cookie':           jar.header(),
          'X-CSRF-TOKEN':     csrf
        },
        body: bodyJson
      });
      if (debugSink) debugSink(`  → sharelinks API HTTP ${apiRes.statusCode} len=${apiRes.body ? apiRes.body.length : 0}`);
      jar.ingest(apiRes.headers['set-cookie']);

      if (apiRes.statusCode === 200 && apiRes.body) {
        try {
          const j = JSON.parse(apiRes.body);
          const invite = j.privateServerInviteData || j.PrivateServerInviteData;
          if (invite && invite.linkCode && invite.placeId) {
            return { placeId: String(invite.placeId), linkCode: String(invite.linkCode) };
          }
          // Sometimes the shape is different — be defensive
          if (j.linkCode && j.placeId) {
            return { placeId: String(j.placeId), linkCode: String(j.linkCode) };
          }
          if (debugSink) debugSink(`  → sharelinks API body: ${apiRes.body.slice(0, 200)}`);
        } catch (e) {
          if (debugSink) debugSink(`  → sharelinks API JSON parse: ${e.message}`);
        }
      }
    } catch (e) {
      if (debugSink) debugSink(`  → sharelinks API exception: ${e.message}`);
    }

    // ── Strategy 2: follow redirects from /share?code=X&type=Server ───────
    const doOne = (hostname, reqPath) => new Promise((resolve) => {
      const req = https.request({
        hostname,
        path: reqPath,
        method: 'GET',
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate',
          'Cookie':           jar.header(),
          'Referer':          'https://www.roblox.com/'
        }
      }, (res) => {
        jar.ingest(res.headers['set-cookie']);
        // Read body in case it's a 200 with meta-refresh
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        const chunks = [];
        const stream = enc === 'gzip'    ? res.pipe(zlib.createGunzip())
                     : enc === 'deflate' ? res.pipe(zlib.createInflate())
                     : res;
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => resolve({
          statusCode: res.statusCode,
          location:   res.headers.location,
          body:       Buffer.concat(chunks).toString('utf8')
        }));
        stream.on('error', () => resolve({ statusCode: res.statusCode, location: res.headers.location, body: '' }));
      });
      req.on('error',   () => resolve({ statusCode: 0, location: null, body: '' }));
      req.setTimeout(15000, () => { req.destroy(); resolve({ statusCode: 0, location: null, body: '' }); });
      req.end();
    });

    let host = 'www.roblox.com';
    let reqPath = `/share?code=${encodeURIComponent(shareCode)}&type=Server`;
    for (let i = 0; i < 6; i++) {
      const { statusCode, location, body } = await doOne(host, reqPath);
      if (debugSink) debugSink(`  → /share hop${i} HTTP ${statusCode} location=${location || '(none)'}`);

      // Check if this URL itself already contains the privateServerLinkCode
      {
        const placeM = reqPath.match(/\/games\/(\d+)/);
        const codeM  = reqPath.match(/privateServerLinkCode=([^&]+)/);
        if (placeM && codeM) {
          return { placeId: placeM[1], linkCode: decodeURIComponent(codeM[1]) };
        }
      }

      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        let next = location;
        if (!next.startsWith('http')) {
          next = `https://${host}${next.startsWith('/') ? '' : '/'}${next}`;
        }
        try {
          const u = new URL(next);
          host    = u.hostname;
          reqPath = u.pathname + u.search;
        } catch { return null; }
        continue;
      }

      // Not a redirect — check the body for client-side navigation hints
      if (body) {
        // meta-refresh tag: <meta http-equiv="refresh" content="0;url=...">
        const meta = body.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^;]*;\s*url=([^"']+)["']/i);
        if (meta) {
          if (debugSink) debugSink(`  → meta-refresh to ${meta[1].slice(0, 80)}`);
          const placeM = meta[1].match(/\/games\/(\d+)/);
          const codeM  = meta[1].match(/privateServerLinkCode=([^&]+)/);
          if (placeM && codeM) {
            return { placeId: placeM[1], linkCode: decodeURIComponent(codeM[1]) };
          }
        }
        // JavaScript navigation: window.location = "..." or similar
        const jsNav = body.match(/window\.location(?:\.href)?\s*=\s*["']([^"']*privateServerLinkCode=[^"']+)["']/);
        if (jsNav) {
          const placeM = jsNav[1].match(/\/games\/(\d+)/);
          const codeM  = jsNav[1].match(/privateServerLinkCode=([^&]+)/);
          if (placeM && codeM) {
            return { placeId: placeM[1], linkCode: decodeURIComponent(codeM[1]) };
          }
        }
        // Raw URL embedded anywhere in the body
        const raw = body.match(/\/games\/(\d+)[^"'\s]*privateServerLinkCode=([^"'&\s]+)/);
        if (raw) {
          return { placeId: raw[1], linkCode: decodeURIComponent(raw[2]) };
        }
      }
      return null;
    }
    return null;
  }

  // Variant of rbxHttp that accepts a request body. Reuses the same
  // decompression + timeout machinery.
  function rbxHttpWithBody({ hostname, path: reqPath, method, headers = {}, body = '' }) {
    return new Promise((resolve) => {
      const req = https.request({ hostname, path: reqPath, method, headers }, (res) => {
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        const chunks = [];
        const stream = enc === 'gzip'    ? res.pipe(zlib.createGunzip())
                     : enc === 'deflate' ? res.pipe(zlib.createInflate())
                     : res;
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve({
          statusCode: res.statusCode,
          headers:    res.headers,
          body:       Buffer.concat(chunks).toString('utf8')
        }));
        stream.on('error', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: '' }));
      });
      req.on('error',   () => resolve({ statusCode: 0, headers: {}, body: '' }));
      req.setTimeout(20000, () => { req.destroy(); resolve({ statusCode: 0, headers: {}, body: '' }); });
      if (body) req.write(body);
      req.end();
    });
  }

  async function rbxGetPrivateAccessCode(jar, csrf, placeId, linkCode, debugSink) {
    // Several patterns to try — Roblox has iterated on how the access code is
    // exposed in the private-server game page markup:
    const patterns = [
      // Legacy RBX AM regex
      { name: 'joinPrivateGame-sq',  re: /Roblox\.GameLauncher\.joinPrivateGame\(\d+,\s*'([\w-]+-[\w-]+-[\w-]+-[\w-]+-[\w-]+)'/ },
      // Same call with double quotes
      { name: 'joinPrivateGame-dq',  re: /Roblox\.GameLauncher\.joinPrivateGame\(\d+,\s*"([\w-]+-[\w-]+-[\w-]+-[\w-]+-[\w-]+)"/ },
      // Loose fallback
      { name: 'joinPrivateGame-any', re: /joinPrivateGame\s*\(\s*\d+\s*,\s*['"]([\w-]{30,})['"]/ },
      // Inline JSON field "accessCode":"..."
      { name: 'json-accessCode',     re: /"accessCode"\s*:\s*"([\w-]{30,})"/ },
      // data attributes
      { name: 'data-access-code',    re: /data-private-server-access-code=['"]([\w-]{30,})['"]/ },
      { name: 'data-access-alt',     re: /data-access-code=['"]([\w-]{30,})['"]/ },
      // Raw UUID near the word "accessCode"
      { name: 'accesscode-nearby',   re: /accessCode["'\s:]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i },
    ];

    const tryHost = async (hostname) => {
      const res = await rbxHttp({
        hostname,
        path: `/games/${placeId}?privateServerLinkCode=${linkCode}`,
        method: 'GET',
        headers: {
          'Cookie':        jar.header(),
          'X-CSRF-TOKEN':   csrf,
          'Referer':        RBX_REFERER,
          'Origin':         'https://www.roblox.com',
          'Accept-Language':'en-US,en;q=0.9'
        }
      });

      // Absorb any Set-Cookies the games page sets
      jar.ingest(res.headers['set-cookie']);

      const body = res.body || '';
      const bodyLen = body.length;

      if (debugSink) {
        const hasJoinCall  = /joinPrivateGame/i.test(body);
        const hasAccessCode= /accessCode/i.test(body);
        const hasPrivSrv   = /privateServer/i.test(body);
        const hasVipId     = /vipServerId/i.test(body);
        const titleMatch   = body.match(/<title>([^<]+)<\/title>/i);
        debugSink(`  → ${hostname} HTTP ${res.statusCode} len=${bodyLen} join=${hasJoinCall} accessCode=${hasAccessCode} privateServer=${hasPrivSrv} vipServerId=${hasVipId} title=${titleMatch ? titleMatch[1].slice(0,60) : '?'}`);

        // Dump the full body to a temp file so we (and the user) can inspect it directly.
        try {
          const dumpPath = path.join(os.tmpdir(), `rbx-page-${hostname.replace(/\W/g, '')}-${Date.now()}.html`);
          fs.writeFileSync(dumpPath, body, 'utf8');
          debugSink(`  → dumped body to ${dumpPath}`);
        } catch (e) {
          debugSink(`  → dump failed: ${e.message}`);
        }
      }

      if (res.statusCode === 200 && body) {
        for (const { name, re } of patterns) {
          const m = body.match(re);
          if (m) {
            if (debugSink) debugSink(`  → matched via ${name}`);
            return m[1];
          }
        }
      }
      return null;
    };

    return (await tryHost('www.roblox.com')) || (await tryHost('web.roblox.com'));
  }

  // Unified launch handler — single entry point the renderer calls.
  // Port of Account.JoinServer (Account.cs:505).
  //
  // Input:  { cookie (raw .ROBLOSECURITY value), placeId, linkCode, exePath }
  // Output: { ok, error?, stage? }
  ipcMain.handle('rbx-launch-account', async (_event, { cookie, placeId, linkCode, exePath }) => {
    const log = (...a) => {
      console.log('[rbx-launch]', ...a);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('debug-log', '[rbx-launch] ' + a.join(' '));
      }
    };
    try {
      log('start', { placeId: placeId || '(auto)', linkCode: linkCode ? linkCode.slice(0,12)+'...' : '(none)', exePath: exePath || '(shell)' });
      if (!cookie)   return { ok: false, error: 'Cookie vazio',           stage: 'input' };
      if (!linkCode) return { ok: false, error: 'Link de servidor vazio', stage: 'input' };

      // 0. Ensure the multi-Roblox singleton bypass mutex is held BEFORE we
      //    spawn the player. Idempotent — no-op if the holder is already
      //    running. Must happen before any Roblox process starts, otherwise
      //    that first Roblox grabs the mutex itself and blocks all subsequent
      //    instances until it exits.
      const muOk = ensureRobloxMultiMutex();
      log('multi-roblox mutex', muOk ? 'OK' : 'unavailable (single-instance only)');

      // Normalize: if caller passed the full "name=value" form, strip the name.
      const m = /\.ROBLOSECURITY=([^;]+)/.exec(cookie);
      if (m) cookie = m[1];

      // 1 + 2. CSRF token + auth ticket in a single cookie-jar session (mirrors
      //         RestSharp's CookieContainer behavior in the C# version).
      const auth = await rbxGetAuthTicketAndCsrf(cookie);
      log('csrf',   auth.csrf   ? 'OK (' + auth.csrf.slice(0, 10)   + '...) http=' + auth.status1 : 'FAIL http=' + auth.status1);
      if (!auth.csrf) {
        return { ok: false, error: 'Sessão da conta expirada. Relogue a conta.', stage: 'csrf' };
      }
      log('ticket', auth.ticket ? 'OK (' + auth.ticket.slice(0, 12) + '...) http=' + auth.status2 : 'FAIL http=' + auth.status2);
      if (!auth.ticket) {
        return { ok: false, error: 'Falha ao obter authentication ticket. Roblox provavelmente deslogou a conta.', stage: 'ticket' };
      }
      const csrf   = auth.csrf;
      const ticket = auth.ticket;

      // 3. Private-server access code. linkCode is required at this point —
      //    we already validated above. If it looks like a /share?code=... share
      //    token (hex, ~32 chars) rather than a real privateServerLinkCode
      //    (long numeric), resolve it via the Roblox share API first. Share
      //    codes are NOT valid as privateServerLinkCode query params.
      if (/^[0-9a-f]{24,40}$/i.test(linkCode)) {
        log('share-code detected, resolving...', linkCode.slice(0, 12) + '...');
        const resolved = await rbxResolveShareCode(linkCode, auth.jar, csrf, log);
        if (resolved && resolved.linkCode) {
          log('share-code resolved', `placeId=${resolved.placeId} linkCode=${resolved.linkCode.slice(0, 20)}...`);
          linkCode = resolved.linkCode;
          // The share resolver always returns the canonical placeId — use it
          // unconditionally so the user never has to enter one manually.
          if (resolved.placeId) placeId = resolved.placeId;
        } else {
          log('share-code resolve FAILED — will still try the original code as-is');
        }
      }

      if (!placeId) {
        return { ok: false, error: 'Não foi possível determinar o Place ID do link. Use um link no formato /share?code=... ou /games/PLACEID/...', stage: 'resolve' };
      }

      // Reuse the cookie jar from the auth flow — the CSRF POST cycle may
      // have set viewing-session cookies that the games page needs.
      const accessCode = await rbxGetPrivateAccessCode(auth.jar, csrf, placeId, linkCode, log);
      log('access-code', accessCode ? 'OK (' + accessCode + ')' : 'FAIL');
      if (!accessCode) {
        return { ok: false, error: 'Falha ao obter access code do servidor privado. Verifique se a conta tem acesso a esse servidor.', stage: 'access-code' };
      }
      const joinVip = true;

      // 4. Build browsertrackerid the exact way RBX AM does (Account.cs:509):
      //    Random.Next(100000, 175000).ToString() + Random.Next(100000, 900000).ToString()
      const rint = (min, max) => Math.floor(Math.random() * (max - min) + min);
      const browserTrackerId = String(rint(100000, 175000)) + String(rint(100000, 900000));

      // 5. Build launchtime — C# uses: Math.Floor((UtcNow - epoch).TotalSeconds * 1000)
      const launchTime = Math.floor((Date.now() / 1000) * 1000);

      // 6. Build PlaceLauncher URL (Account.cs:652 for JoinVIP / :656 for normal)
      let placeLauncherInner;
      if (joinVip) {
        placeLauncherInner = `https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestPrivateGame&placeId=${placeId}&accessCode=${accessCode}&linkCode=${linkCode}`;
      } else {
        placeLauncherInner = `https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestGame&browserTrackerId=${browserTrackerId}&placeId=${placeId}&isPlayTogetherGame=false`;
      }

      // 7. Build roblox-player: URI in EXACTLY the format the RBX AM launcher uses.
      //    Account.cs:652 — note: channel has NO value, LaunchExp:InApp at the end.
      const uri =
        `roblox-player:1+launchmode:play` +
        `+gameinfo:${ticket}` +
        `+launchtime:${launchTime}` +
        `+placelauncherurl:${encodeURIComponent(placeLauncherInner)}` +
        `+browsertrackerid:${browserTrackerId}` +
        `+robloxLocale:en_us+gameLocale:en_us` +
        `+channel:` +
        `+LaunchExp:InApp`;

      // 8. Launch. If the user provided an explicit RobloxPlayerBeta.exe path, spawn
      //    it directly with the URI as argv[1] (same as RBX AM's "UseOldJoin"-style
      //    direct-launch path). Otherwise hand off to the OS via the roblox-player:
      //    protocol handler.
      try {
        if (exePath && fs.existsSync(exePath)) {
          log('spawning exe', exePath);
          spawn(exePath, [uri], { detached: true, stdio: 'ignore' }).unref();
        } else {
          log('shell.openExternal (no exePath or missing)');
          shell.openExternal(uri);
        }
      } catch (e) {
        log('spawn error', e.message);
        // Fallback to shell if spawn blows up for any reason
        try { shell.openExternal(uri); } catch {}
        return { ok: false, error: 'Falha ao iniciar Roblox: ' + e.message, stage: 'spawn' };
      }

      log('success');
      return { ok: true };
    } catch (e) {
      log('exception', e.message);
      return { ok: false, error: e.message || String(e), stage: 'exception' };
    }
  });

  // Opens a native file-picker and returns the selected file path (or null).
  ipcMain.handle('browse-file', async (_event, { title, filters } = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Selecionar arquivo',
      filters: filters || [],
      properties: ['openFile']
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  // Launches the Roblox exe directly with the roblox-player: URI as argument.
  ipcMain.handle('launch-roblox-exe', async (_event, { exePath, uri }) => {
    try {
      spawn(exePath, [uri], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    } catch(e) {
      // Fallback to shell.openExternal if spawn fails
      shell.openExternal(uri);
      return { ok: false, error: e.message };
    }
  });

  // Resolves Roblox share links (https://www.roblox.com/share?code=...&type=Server).
  // Accepts an optional cookieStr to make the request authenticated (needed for Roblox SPA).
  // Strategy: follow redirects → if still on share page, fetch with cookie & parse body for
  // placeId + privateServerLinkCode patterns.
  ipcMain.handle('resolve-roblox-share', async (_event, shareUrl, cookieStr) => {
    const extract = (url, body) => {
      // From URL directly
      const uPlace = url.match(/\/games\/(\d+)/);
      const uCode  = url.match(/privateServerLinkCode=([^&\s"']+)/);
      if (uPlace && uCode) return { placeId: uPlace[1], linkCode: uCode[1] };
      // joinPrivateGame(placeId, 'linkCode')
      const joinM = body.match(/joinPrivateGame\s*\(\s*(\d+)\s*,\s*['"]([^'"]+)['"]/);
      if (joinM) return { placeId: joinM[1], linkCode: joinM[2] };
      // JSON: "privateServerLinkCode":"..." + "placeId":ID
      const codeM  = body.match(/"privateServerLinkCode"\s*:\s*"([^"]+)"/);
      const placeM = body.match(/"placeId"\s*:\s*(\d+)/);
      if (codeM && placeM) return { placeId: placeM[1], linkCode: codeM[1] };
      // accessCode in JSON
      const accM  = body.match(/"accessCode"\s*:\s*"([^"]+)"/);
      const plcM2 = body.match(/\/games\/(\d+)/);
      if (accM && plcM2) return { placeId: plcM2[1], linkCode: accM[1] };
      return null;
    };

    const fetchUrl = (url, cookie, depth) => new Promise((resolve) => {
      if (depth > 8) return resolve({ url, placeId: '', linkCode: '' });
      try {
        const parsed = new URL(url);
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        };
        if (cookie) headers['Cookie'] = cookie;
        const req = https.request({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET', headers }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            let loc = res.headers.location;
            if (!loc.startsWith('http')) loc = `https://${parsed.hostname}${loc.startsWith('/') ? '' : '/'}${loc}`;
            res.resume();
            fetchUrl(loc, cookie, depth + 1).then(resolve);
          } else {
            let body = '';
            res.on('data', c => { if (body.length < 800000) body += c; });
            res.on('end', () => {
              const found = extract(url, body);
              resolve(found ? { url, ...found } : { url, placeId: '', linkCode: '' });
            });
          }
        });
        req.on('error', () => resolve({ url, placeId: '', linkCode: '' }));
        req.setTimeout(12000, () => { req.destroy(); resolve({ url, placeId: '', linkCode: '' }); });
        req.end();
      } catch { resolve({ url: shareUrl, placeId: '', linkCode: '' }); }
    });

    // First try without cookie, then with cookie if first attempt fails
    const r1 = await fetchUrl(shareUrl, null, 0);
    if (r1.placeId && r1.linkCode) return r1;
    if (cookieStr) {
      const r2 = await fetchUrl(shareUrl, cookieStr, 0);
      if (r2.placeId && r2.linkCode) return r2;
    }
    return { url: shareUrl, placeId: '', linkCode: '' };
  });

  ipcMain.on('open-roblox-login', (event) => {
    // Each login window gets its own isolated partition so previous sessions
    // never carry over and don't auto-detect a previously logged-in account.
    const partition = 'roblox-login-' + Date.now();
    const loginWin = new BrowserWindow({
      width: 1000,
      height: 700,
      title: 'Login Roblox',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition
      }
    });
    loginWin.loadURL('https://www.roblox.com/login');

    const checkLogin = setInterval(async () => {
      if (loginWin.isDestroyed()) { clearInterval(checkLogin); return; }
      try {
        const cookies = await loginWin.webContents.session.cookies.get({ domain: '.roblox.com' });
        const secCookie = cookies.find(c => c.name === '.ROBLOSECURITY');
        if (secCookie) {
          clearInterval(checkLogin);
          // Also grab UserID from page if possible
          let userId = null;
          try {
            userId = await loginWin.webContents.executeJavaScript(
              'Roblox && Roblox.CurrentUser && Roblox.CurrentUser.userId || null'
            );
          } catch {}
          event.sender.send('roblox-login-cookie', { cookie: secCookie.value, userId });
          loginWin.close();
        }
      } catch {}
    }, 1500);

    loginWin.on('closed', () => clearInterval(checkLogin));
  });

  ipcMain.on('open-login-window', (event) => {
    const loginWin = new BrowserWindow({
      width: 1100,
      height: 700,
      title: 'Login Eldorado',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:eldorado-login-' + Date.now() // sessão isolada sem cookies prévios
      }
    });

    // Gera parâmetros PKCE para o OAuth flow do Eldorado
    const crypto = require('crypto');
    const codeVerifier  = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state         = crypto.randomBytes(24).toString('base64url');

    const loginURL = `https://login.eldorado.gg/login?` +
      `redirect_uri=https%3A%2F%2Fwww.eldorado.gg%2Faccount%2Fauth-callback` +
      `&response_type=code` +
      `&client_id=3a4hal6jgl8gf5hnnjo06k05s5` +
      `&identity_provider=COGNITO` +
      `&scope=email%20openid%20profile%20aws.cognito.signin.user.admin` +
      `&state=${state}` +
      `&code_challenge=${codeChallenge}` +
      `&code_challenge_method=S256` +
      `&lang=en`;

    loginWin.loadURL(loginURL);

    let captured = false;

    // Captura cookies após o OAuth callback redirecionar de volta para o site
    const tryCapture = async (url) => {
      if (captured) return;
      if (!url.includes('eldorado.gg/account')) return;
      try {
        const cookies = await loginWin.webContents.session.cookies.get({ domain: 'eldorado.gg' });
        const hasPseudo = cookies.some(c => c.name === 'pseudoId');
        const hasXsrf   = cookies.some(c => c.name === '__Host-XSRF-TOKEN');
        if (hasPseudo && hasXsrf) {
          captured = true;
          const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          event.sender.send('login-cookie', cookieStr);
          setTimeout(() => { if (!loginWin.isDestroyed()) loginWin.close(); }, 800);
        }
      } catch (e) {}
    };

    loginWin.webContents.on('did-navigate', (e, url) => tryCapture(url));
    loginWin.webContents.on('did-navigate-in-page', (e, url) => tryCapture(url));

    loginWin.on('closed', () => { if (!captured) event.sender.send('login-cookie', null); });
  });

  // ── DIRECT IMAGE UPLOAD ──────────────────────────────────────────────────────
  ipcMain.handle('upload-image-via-page', async (_event, { imageBase64, cookieStr, filename, mime }) => {
    try {
      await _ensureEldoApiWin(cookieStr);
      if (!_eldoApiWin || _eldoApiWin.isDestroyed()) return { ok: false, error: 'API window not available' };

      const xsrfMatch = cookieStr ? cookieStr.match(/__Host-XSRF-TOKEN=([^;]+)/) : null;
      const xsrf = xsrfMatch ? decodeURIComponent(xsrfMatch[1]) : '';
      const fname = filename || 'listing.png';
      const mimeType = mime || 'image/png';

      const script = `(async () => {
        try {
          const byteChars = atob(${JSON.stringify(imageBase64)});
          const byteArr = new Uint8Array(byteChars.length);
          for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
          const blob = new Blob([byteArr], { type: ${JSON.stringify(mimeType)} });
          const form = new FormData();
          form.append('image', blob, ${JSON.stringify(fname)});
          const res = await fetch('https://www.eldorado.gg/api/files/me/Offer', {
            method: 'POST',
            headers: {
              'Origin': 'https://www.eldorado.gg',
              'Referer': 'https://www.eldorado.gg/sell',
              ${xsrf ? `'X-XSRF-TOKEN': ${JSON.stringify(xsrf)},` : ''}
            },
            credentials: 'include',
            body: form,
          });
          const text = await res.text();
          return { status: res.status, body: text };
        } catch(e) { return { error: e.message }; }
      })()`;

      const result = await _eldoApiWin.webContents.executeJavaScript(script, true);
      if (!result || result.error) return { ok: false, error: result?.error || 'fetch failed' };
      return { ok: result.status >= 200 && result.status < 300, status: result.status, body: result.body };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  });
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('get-talkjs-token', async (_event, cookieStr) => {
    try {
      // Use the hidden eldorado window (same approach as eldorado-api) to bypass Cloudflare
      await _ensureEldoApiWin(cookieStr);
      if (!_eldoApiWin || _eldoApiWin.isDestroyed()) return null;

      const xsrfMatch = cookieStr ? cookieStr.match(/__Host-XSRF-TOKEN=([^;]+)/) : null;
      const xsrf = xsrfMatch ? decodeURIComponent(xsrfMatch[1]) : '';

      const script = `(async () => {
        try {
          const res = await fetch('https://www.eldorado.gg/api/conversations/me/authorize', {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'Origin': 'https://www.eldorado.gg',
              ${xsrf ? `'X-XSRF-TOKEN': ${JSON.stringify(xsrf)},` : ''}
            },
            credentials: 'include',
          });
          const json = await res.json();
          return json?.token || null;
        } catch(e) { return null; }
      })()`;

      return await _eldoApiWin.webContents.executeJavaScript(script, true);
    } catch(e) {
      return null;
    }
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

  // ── Discord Key Registration ──────────────────────────────────────────────────
  const LUARMOR_PROJECT = '045945e1b5e5afe2127fb68f82b490c9';
  const LUARMOR_API_KEY = 'd0b0feea1a4638d853c6190b64c05eb84d52ca70e8c526122fde';

  function luarmorRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      const http = require('http');
      // Strip /v3/ prefix — proxy adds it back
      const proxyPath = path.replace(/^\/v3/, '');
      const postData = body ? JSON.stringify(body) : null;
      const headers = { 'Content-Type': 'application/json' };
      if (postData) headers['Content-Length'] = Buffer.byteLength(postData);

      const req = http.request({
        hostname: '16.59.85.103',
        port: 3001,
        path: `/luarmor${proxyPath}`,
        method,
        headers,
        timeout: 10000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve({ statusCode: res.statusCode, data: JSON.parse(data) }); }
          catch(e) { resolve({ statusCode: res.statusCode, data: null }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', function() { this.destroy(); reject(new Error('Request timeout')); });
      if (postData) req.write(postData);
      req.end();
    });
  }

  ipcMain.handle('register-discord-key', async (event, discordId) => {
    try {
      if (!discordId || !/^\d+$/.test(discordId)) {
        return { error: 'Discord ID inválido' };
      }

      // Verifica se o Discord ID já foi whitelisted pelo admin no Luarmor
      const res = await luarmorRequest('GET', `/v3/projects/${LUARMOR_PROJECT}/users?discord_id=${discordId}`, null);

      if (res.statusCode !== 200 || !res.data?.users?.length) {
        return { error: 'Você não tem permissão para usar este script.' };
      }

      const user_key = res.data.users[0].user_key;
      if (!user_key) {
        return { error: 'Você não tem permissão para usar este script.' };
      }

      return { ok: true, luarmor_key: user_key };
    } catch(e) {
      console.error('[Discord] Erro:', e.message);
      return { error: e.message };
    }
  });
}

// ── Eldorado API via hidden BrowserWindow ────────────────────────────────────
// net.fetch / ses.fetch are blocked by Cloudflare (TLS fingerprint mismatch).
// The only approach that works: keep a hidden BrowserWindow loaded on
// www.eldorado.gg so Cloudflare's JS challenge runs in a real Chromium context,
// then proxy all API calls through executeJavaScript from within that page.
// Same-origin fetch inside the page bypasses Cloudflare completely.

async function _setSessionCookies(ses, cookieStr) {
  if (!cookieStr) return;
  for (const pair of cookieStr.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const name  = pair.substring(0, eqIdx).trim();
    const value = pair.substring(eqIdx + 1).trim();
    if (!name) continue;
    try {
      const obj = { url: 'https://www.eldorado.gg', name, value, path: '/', secure: true };
      if (!name.startsWith('__Host-')) obj.domain = '.eldorado.gg';
      await ses.cookies.set(obj);
    } catch(e) {}
  }
}

let _eldoApiWin = null;
let _eldoApiWinReady = false;
let _eldoApiWinLoading = null;

function _getEldoApiSession() {
  return session.fromPartition('persist:eldorado-cf');
}

async function _ensureEldoApiWin(cookieStr) {
  const ses = _getEldoApiSession();
  if (cookieStr) await _setSessionCookies(ses, cookieStr);

  if (_eldoApiWin && !_eldoApiWin.isDestroyed() && _eldoApiWinReady) return;

  // If already navigating, wait for it
  if (_eldoApiWinLoading) { await _eldoApiWinLoading; return; }

  if (!_eldoApiWin || _eldoApiWin.isDestroyed()) {
    _eldoApiWinReady = false;
    _eldoApiWin = new BrowserWindow({
      width: 1200, height: 800,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: ses,
      }
    });
    _eldoApiWin.on('closed', () => { _eldoApiWin = null; _eldoApiWinReady = false; });
  }

  _eldoApiWinLoading = new Promise((resolve) => {
    const wc = _eldoApiWin.webContents;
    wc.setMaxListeners(50);
    const onFinish = () => { clearTimeout(timeout); setTimeout(() => { _eldoApiWinReady = true; resolve(); }, 2000); };
    const onFail   = () => { clearTimeout(timeout); _eldoApiWinReady = true; resolve(); };
    // Remove any stale listeners from a previous load attempt before adding new ones
    wc.removeAllListeners('did-finish-load');
    wc.removeAllListeners('did-fail-load');
    wc.once('did-finish-load', onFinish);
    wc.once('did-fail-load', onFail);
    const timeout = setTimeout(() => { wc.removeListener('did-finish-load', onFinish); wc.removeListener('did-fail-load', onFail); _eldoApiWinReady = true; resolve(); }, 20000);
    _eldoApiWin.loadURL('https://www.eldorado.gg');
  });

  await _eldoApiWinLoading;
  _eldoApiWinLoading = null;
}

let _cfSolving = null;
async function _solveCfChallenge() {
  // Evita múltiplas solicitações simultâneas
  if (_cfSolving) return _cfSolving;
  _cfSolving = (async () => {
    if (!_eldoApiWin || _eldoApiWin.isDestroyed()) return;

    // Avisa o renderer pra mostrar overlay informando o usuário
    _adlvSend('cf-challenge-start', null);

    // Mostra a janela escondida pra usuário interagir com o captcha
    try {
      _eldoApiWin.setSkipTaskbar(false);
      _eldoApiWin.show();
      _eldoApiWin.focus();
    } catch(e) {}

    // Recarrega a página principal e aguarda Cloudflare ser resolvido
    try { _eldoApiWin.loadURL('https://www.eldorado.gg/account'); } catch(e) {}

    // Aguarda até 5 minutos pelo usuário resolver o captcha
    // Detecção: a URL não contém challenge-platform e o body tem JS normal da Eldorado
    const start = Date.now();
    const TIMEOUT = 5 * 60 * 1000;
    while (Date.now() - start < TIMEOUT) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const checkScript = `(async () => {
          try {
            const r = await fetch('https://www.eldorado.gg/api/users/me', { credentials: 'include' });
            return { status: r.status };
          } catch(e) { return { error: e.message }; }
        })()`;
        const check = await _eldoApiWin.webContents.executeJavaScript(checkScript, true);
        if (check && (check.status === 200 || check.status === 401)) {
          // Resolvido (ou cookie expirou — outro problema)
          break;
        }
      } catch(e) {}
    }

    // Esconde a janela de novo
    try {
      _eldoApiWin.hide();
      _eldoApiWin.setSkipTaskbar(true);
    } catch(e) {}
    _eldoApiWinReady = true;
    _adlvSend('cf-challenge-end', null);
  })();
  try { await _cfSolving; } finally { _cfSolving = null; }
}

ipcMain.handle('eldorado-api', async (_e, { path, method, cookie, body }) => {
  try {
    await _ensureEldoApiWin(cookie);

    if (!_eldoApiWin || _eldoApiWin.isDestroyed()) {
      return { ok: false, error: 'API window not available' };
    }

    const xsrfMatch = cookie ? cookie.match(/__Host-XSRF-TOKEN=([^;]+)/) : null;
    const xsrfToken = xsrfMatch ? decodeURIComponent(xsrfMatch[1]) : '';

    const reqHeaders = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': 'https://www.eldorado.gg',
      'Referer': 'https://www.eldorado.gg/',
    };
    if (xsrfToken) reqHeaders['X-XSRF-TOKEN'] = xsrfToken;

    const bodyStr = body ? JSON.stringify(body) : null;

    const script = `(async () => {
      try {
        const res = await fetch(${JSON.stringify('https://www.eldorado.gg' + path)}, {
          method: ${JSON.stringify(method || 'GET')},
          headers: ${JSON.stringify(reqHeaders)},
          credentials: 'include',
          ${bodyStr ? `body: ${JSON.stringify(bodyStr)},` : ''}
        });
        const text = await res.text();
        return { status: res.status, body: text };
      } catch(e) {
        return { error: e.message };
      }
    })()`;

    const result = await _eldoApiWin.webContents.executeJavaScript(script, true);

    if (!result || result.error) return { ok: false, error: result?.error || 'fetch failed' };

    // Detecta challenge do Cloudflare (HTML com sinais típicos)
    const isCfChallenge = (result.status === 403 || result.status === 503) &&
      typeof result.body === 'string' &&
      (result.body.includes('cf-mitigated') ||
       result.body.includes('cf_chl_opt') ||
       result.body.includes('Just a moment') ||
       result.body.includes('challenge-platform') ||
       result.body.includes('cf-browser-verification'));

    if (isCfChallenge) {
      console.warn('[eldorado-api] Cloudflare challenge detectado — abrindo janela para o usuário resolver');
      _eldoApiWinReady = false;
      try { await _solveCfChallenge(); } catch(e) { console.error('[CF solve]', e.message); }
      return { ok: false, statusCode: result.status, error: 'cloudflare_challenge', cfChallenge: true };
    }

    if (result.status === 401 || result.status === 403) {
      _eldoApiWinReady = false;
      return { ok: false, statusCode: result.status, error: 'HTTP' + result.status };
    }
    try { return { ok: true, statusCode: result.status, json: JSON.parse(result.body) }; }
    catch { return { ok: result.status >= 200 && result.status < 300, statusCode: result.status, json: null }; }
  } catch(e) {
    console.error('[eldorado-api] EXCEPTION:', e.message);
    return { ok: false, error: e.message };
  }
});

// ─── Auto Delivery HTTP server ───────────────────────────────────────────────
const http = require('http');
const ADLV_PORT = 7821;
let _adlvPendingTrade = null;
let _adlvServer = null;
let _adlvInventory = null;  // { lastUpdate, players: [{ animals: [{ slot, uuid, ... }] }] }

function _adlvSend(event, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, data);
}

function startAdlvServer() {
  _adlvServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/pending-trade') {
      res.writeHead(200);
      res.end(JSON.stringify(_adlvPendingTrade || null));
      return;
    }

    if (req.method === 'GET' && req.url === '/inventory') {
      res.writeHead(200);
      res.end(JSON.stringify(_adlvInventory || null));
      return;
    }

    // GET /pet-slot?uuid=xxx → { slot: "21", absolutePosition: 10 }
    if (req.method === 'GET' && req.url.startsWith('/pet-slot')) {
      const u = new URL(req.url, 'http://x');
      const uuid = u.searchParams.get('uuid');
      let result = { slot: null, absolutePosition: null };
      if (uuid && _adlvInventory && Array.isArray(_adlvInventory.players)) {
        outer: for (const p of _adlvInventory.players) {
          if (!Array.isArray(p.animals)) continue;
          // Ordena por slot numérico (mesma lógica que a UI da trade)
          const sorted = [...p.animals].sort((a, b) =>
            parseInt(a.slot, 10) - parseInt(b.slot, 10));
          for (let i = 0; i < sorted.length; i++) {
            if (String(sorted[i].uuid) === String(uuid)) {
              result = { slot: sorted[i].slot, absolutePosition: i + 1, total: sorted.length };
              break outer;
            }
          }
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);

          if (req.url === '/trade-result') {
            if (_adlvPendingTrade && _adlvPendingTrade.offerId === data.offerId) {
              _adlvPendingTrade = null;
            }
            _adlvSend('adlv-result', data);
          }

          else if (req.url === '/vendor-notify') {
            // Encaminha para o renderer enviar via TalkJS
            _adlvSend('adlv-vendor-notify', data);
          }

          else if (req.url === '/kill-roblox') {
            try {
              require('child_process').execSync('taskkill /F /IM RobloxPlayerBeta.exe /T', { shell: true, timeout: 5000 });
              console.log('[AutoDelivery] RobloxPlayerBeta.exe encerrado via /kill-roblox');
            } catch(e) {}
          }

          else if (req.url === '/inventory') {
            // Scanner Lua envia inventário completo
            _adlvInventory = data;
            console.log('[AutoDelivery] Inventory updated:', data?.players?.[0]?.animals?.length, 'pets');
          }

        } catch(e) {}
        res.writeHead(200);
        res.end('{"ok":true}');
      });
      return;
    }

    res.writeHead(404);
    res.end('{"error":"not found"}');
  });

  _adlvServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[AutoDelivery] Porta ${ADLV_PORT} em uso — tentando novamente em 3s`);
      setTimeout(startAdlvServer, 3000);
    }
  });

  _adlvServer.listen(ADLV_PORT, '127.0.0.1', () => {
    console.log(`[AutoDelivery] HTTP server on port ${ADLV_PORT}`);
    _adlvSend('adlv-server-ready', ADLV_PORT);
  });
}

ipcMain.on('adlv-set-pending', (_e, trade) => {
  _adlvPendingTrade = trade;
  console.log('[AutoDelivery] Pending trade set:', trade?.offerId);
});

// Renderer pede próximo item ready da fila
ipcMain.handle('adlv-get-pending', () => _adlvPendingTrade);

// Fecha todas as instâncias do RobloxPlayerBeta.exe em execução
ipcMain.handle('rbx-close-all', async () => {
  try {
    require('child_process').execSync('taskkill /F /IM RobloxPlayerBeta.exe /T', { shell: true, timeout: 5000 });
    console.log('[AutoDelivery] RobloxPlayerBeta.exe encerrado');
    return { ok: true };
  } catch(e) {
    // Processo pode não estar rodando — não é erro crítico
    return { ok: false, error: e.message };
  }
});

app.on('quit', () => { if (_adlvServer) _adlvServer.close(); });

app.whenReady().then(() => {
  createWindow();
  try {
    require('child_process').execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${EXT_PORT}') do taskkill /F /PID %a`, { shell: 'cmd.exe', timeout: 3000 });
  } catch {}
  startExtBridge();
  startAdlvServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Don't leak the multi-roblox mutex holder powershell.
  releaseRobloxMultiMutex();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
