const PORT = 47832;
let socket = null;
let connecting = false;

async function getPairCode() {
  try {
    const data = await chrome.storage.local.get('pairCode');
    return data.pairCode || null;
  } catch { return null; }
}

async function getCookieStr() {
  try {
    const [a, b] = await Promise.all([
      chrome.cookies.getAll({ url: 'https://www.eldorado.gg' }),
      chrome.cookies.getAll({ url: 'https://eldorado.gg' }),
    ]);
    const seen = new Set();
    return [...a, ...b]
      .filter(c => { if (seen.has(c.name)) return false; seen.add(c.name); return true; })
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
  } catch { return ''; }
}

function isOpen() {
  return socket && socket.readyState === WebSocket.OPEN;
}

function connect() {
  if (isOpen() || connecting) return;
  connecting = true;

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

    ws.addEventListener('open', async () => {
      connecting = false;
      socket = ws;
      const code = await getPairCode();
      if (!code) { ws.close(); return; }
      const cookie = await getCookieStr();
      try { ws.send(JSON.stringify({ type: 'auth', code, cookie })); } catch {}
      chrome.storage.local.set({ status: 'connected' }).catch(() => {});
    });

    // Handle requests from the app (e.g. api-request — proxied through real Chrome to bypass Cloudflare)
    ws.addEventListener('message', async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'get-cookie') {
        try {
          const code = await getPairCode();
          if (!code) return;
          const cookie = await getCookieStr();
          if (cookie) ws.send(JSON.stringify({ type: 'cookie', code, cookie }));
        } catch {}
        return;
      }

      if (msg.type === 'api-request') {
        const { id, path, method, body } = msg;
        try {
          const [a, b] = await Promise.all([
            chrome.cookies.getAll({ url: 'https://www.eldorado.gg' }),
            chrome.cookies.getAll({ url: 'https://eldorado.gg' }),
          ]);
          const cookies = [...a, ...b];
          const xsrfCookie = cookies.find(c => c.name === '__Host-XSRF-TOKEN');
          const xsrfToken = xsrfCookie ? decodeURIComponent(xsrfCookie.value) : '';

          const headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Origin': 'https://www.eldorado.gg',
            'Referer': 'https://www.eldorado.gg/',
          };
          if (xsrfToken) headers['X-XSRF-TOKEN'] = xsrfToken;

          const res = await fetch('https://www.eldorado.gg' + path, {
            method: method || 'GET',
            headers,
            credentials: 'include',
            body: body ? JSON.stringify(body) : undefined,
          });
          const text = await res.text();
          ws.send(JSON.stringify({ type: 'api-response', id, status: res.status, body: text }));
        } catch(e) {
          try { ws.send(JSON.stringify({ type: 'api-response', id, status: 0, body: '', error: e.message })); } catch {}
        }
      }
    });

    ws.addEventListener('close', () => {
      connecting = false;
      if (socket === ws) socket = null;
      chrome.storage.local.set({ status: 'disconnected' }).catch(() => {});
    });

    ws.addEventListener('error', () => {
      connecting = false;
      if (socket === ws) socket = null;
    });
  } catch {
    connecting = false;
  }
}

// Send updated cookie on change — debounced to avoid burst on page navigation
let _cookieSendTimer = null;
let _lastSentCookie = null;
chrome.cookies.onChanged.addListener((info) => {
  if (!info.cookie.domain.includes('eldorado.gg')) return;
  if (!isOpen()) return;
  clearTimeout(_cookieSendTimer);
  _cookieSendTimer = setTimeout(async () => {
    try {
      const code = await getPairCode();
      if (!code) return;
      const cookie = await getCookieStr();
      if (cookie === _lastSentCookie) return;
      _lastSentCookie = cookie;
      socket.send(JSON.stringify({ type: 'cookie', code, cookie }));
    } catch {}
  }, 2000);
});

// Reconnect every 30s if disconnected
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  try { if (alarm.name === 'reconnect') connect(); } catch {}
});

chrome.runtime.onMessage.addListener((msg) => {
  try { if (msg.type === 'reconnect') { if (socket) socket.close(); connect(); } } catch {}
});

connect();
