// Spökrösten – lampproxy för Tuya/Smart Life-lampor (t.ex. Cleverio från Kjell).
// Körs som Cloudflare Worker. Inga beroenden: klistra in hela filen i Workers-redigeraren.
//
// Miljövariabler (Settings → Variables and Secrets):
//   TUYA_CLIENT_ID  Access ID / Client ID från Tuya-projektet
//   TUYA_SECRET     Access Secret från Tuya-projektet            (typ: Secret)
//   TUYA_BASE       API-adress för datacentret, t.ex. https://openapi.tuyaeu.com
//   DEVICE_IDS      Lampornas Device ID, kommaseparerade
//   APP_TOKEN       Valfri lång slumpsträng; samma sträng skrivs in i Spökrösten  (typ: Secret)
//   ALLOWED_ORIGINS (valfri) kommaseparerade sidor som får anropa proxyn
//
// Spökrösten skickar enkla åtgärder ({type:'color', h, s, v} osv.) och proxyn översätter
// dem till de Tuya-koder varje lampa faktiskt har (v2-koder eller äldre v1-koder).

const DEFAULT_ORIGINS = ['https://martinthoren.github.io', 'http://localhost:8765'];

let token = null;            // { value, expires } – återanvänds så länge workern lever
const codeCache = new Map(); // deviceId → Set med funktionskoder

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmacUpper(key, s) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(s))).toUpperCase();
}

// Tuya vill ha frågeparametrarna i bokstavsordning i signaturen
function canonicalUrl(path) {
  const [p, q] = path.split('?');
  if (!q) return p;
  const params = [...new URLSearchParams(q)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return p + '?' + params.map(([k, v]) => `${k}=${v}`).join('&');
}

// Signerat anrop enligt Tuyas "new signature algorithm":
// sign = HMAC-SHA256(client_id + access_token + t + nonce + stringToSign, secret), versaler
// stringToSign = METHOD \n SHA256(body) \n (inga signerade headers) \n URL
async function tuya(env, method, path, body, { auth = true, retried = false } = {}) {
  const base = (env.TUYA_BASE || 'https://openapi.tuyaeu.com').replace(/\/$/, '');
  const url = canonicalUrl(path);
  const bodyStr = body ? JSON.stringify(body) : '';
  const t = String(Date.now());
  const accessToken = auth ? await getToken(env) : '';
  const stringToSign = [method, await sha256(bodyStr), '', url].join('\n');
  const sign = await hmacUpper(env.TUYA_SECRET, env.TUYA_CLIENT_ID + accessToken + t + stringToSign);

  const headers = { client_id: env.TUYA_CLIENT_ID, sign, t, sign_method: 'HMAC-SHA256' };
  if (accessToken) headers.access_token = accessToken;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(base + url, { method, headers, body: body ? bodyStr : undefined });
  const json = await res.json();
  if (!json.success) {
    if (auth && !retried && (json.code === 1010 || json.code === 1011)) { // token ogiltig/utgången
      token = null;
      return tuya(env, method, path, body, { auth, retried: true });
    }
    throw new Error(`Tuya ${json.code}: ${json.msg}`);
  }
  return json.result;
}

let tokenPending = null; // flera samtidiga anrop delar på samma tokenhämtning
async function getToken(env) {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  if (!tokenPending) {
    tokenPending = tuya(env, 'GET', '/v1.0/token?grant_type=1', null, { auth: false })
      .then(r => { token = { value: r.access_token, expires: Date.now() + r.expire_time * 1000 }; return token.value; })
      .finally(() => { tokenPending = null; });
  }
  return tokenPending;
}

async function codesFor(env, id) {
  if (!codeCache.has(id)) {
    const r = await tuya(env, 'GET', `/v1.0/devices/${id}/functions`);
    codeCache.set(id, new Set((r.functions || []).map(f => f.code)));
  }
  return codeCache.get(id);
}

// ---------- Åtgärd → Tuya-kommandon ----------
const clamp = (x, a, b) => Math.max(a, Math.min(b, Number.isFinite(x) ? x : a));

function commandsFor(action, codes) {
  const v2 = codes.has('colour_data_v2') || !codes.has('colour_data');
  const S = v2 ? 1000 : 255;
  const hsv = u => ({
    h: Math.round(clamp(u.h ?? 0, 0, 360)),
    s: Math.round(clamp(u.s ?? 1, 0, 1) * S),
    v: Math.round(clamp(u.v ?? 1, 0.01, 1) * S),
  });
  const on = { code: 'switch_led', value: true };

  switch (action.type) {
    case 'off':
      return [{ code: 'switch_led', value: false }];
    case 'on':
      return [on];
    case 'color':
      return [on, { code: 'work_mode', value: 'colour' }, { code: v2 ? 'colour_data_v2' : 'colour_data', value: hsv(action) }];
    case 'white': {
      const out = [on, { code: 'work_mode', value: 'white' }];
      const v = clamp(action.v ?? 1, 0, 1), temp = clamp(action.temp ?? 0, 0, 1);
      if (v2) {
        out.push({ code: 'bright_value_v2', value: Math.round(10 + v * 990) });
        if (codes.has('temp_value_v2')) out.push({ code: 'temp_value_v2', value: Math.round(temp * 1000) });
      } else {
        out.push({ code: 'bright_value', value: Math.round(25 + v * 230) });
        if (codes.has('temp_value')) out.push({ code: 'temp_value', value: Math.round(temp * 255) });
      }
      return out;
    }
    case 'scene': {
      const units = (action.units || []).slice(0, 8);
      if (!units.length) throw new Error('Scenen saknar steg');
      if (!codes.has('scene_data_v2')) return commandsFor({ type: 'color', ...units[0] }, codes); // reserv: fast färg
      const speed = Math.round(clamp(action.speed ?? 50, 0, 100));
      return [on, { code: 'work_mode', value: 'scene' }, {
        code: 'scene_data_v2',
        value: {
          scene_num: Math.round(clamp(action.num ?? 1, 1, 8)),
          scene_units: units.map(u => ({
            unit_change_mode: action.mode === 'gradient' ? 'gradient' : action.mode === 'static' ? 'static' : 'jump',
            unit_switch_duration: speed, unit_gradient_duration: speed,
            bright: 0, temperature: 0, ...hsv(u),
          })),
        },
      }];
    }
    default:
      throw new Error('Okänd åtgärd: ' + action.type);
  }
}

// ---------- HTTP ----------
function cors(req, env) {
  const allowed = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : DEFAULT_ORIGINS;
  const origin = req.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Spok-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });

export default {
  async fetch(req, env) {
    const h = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

    const missing = ['TUYA_CLIENT_ID', 'TUYA_SECRET', 'DEVICE_IDS', 'APP_TOKEN'].filter(k => !env[k]);
    if (missing.length) return json({ error: 'Proxyn saknar inställningar: ' + missing.join(', ') }, 500, h);
    if (req.headers.get('X-Spok-Token') !== env.APP_TOKEN) return json({ error: 'Fel nyckel' }, 401, h);

    const ids = env.DEVICE_IDS.split(',').map(s => s.trim()).filter(Boolean);
    const path = new URL(req.url).pathname.replace(/\/$/, '');

    try {
      if (req.method === 'GET' && path === '/devices') {
        const devices = await Promise.all(ids.map(async (id, index) => {
          try {
            const [info, codes] = await Promise.all([tuya(env, 'GET', `/v1.0/devices/${id}`), codesFor(env, id)]);
            return { index, id, name: info.name, online: !!info.online, codes: [...codes] };
          } catch (e) {
            return { index, id, error: e.message };
          }
        }));
        return json({ devices }, 200, h);
      }

      if (req.method === 'POST' && path === '/light') {
        const { action, targets } = await req.json();
        if (!action || typeof action.type !== 'string') return json({ error: 'Saknar åtgärd' }, 400, h);
        const chosen = Array.isArray(targets) && targets.length ? targets.map(i => ids[i]).filter(Boolean) : ids;
        // Alla lampor samtidigt, så de byter nästan i takt
        const results = await Promise.all(chosen.map(async id => {
          try {
            const commands = commandsFor(action, await codesFor(env, id));
            await tuya(env, 'POST', `/v1.0/devices/${id}/commands`, { commands });
            return { id, ok: true };
          } catch (e) {
            return { id, ok: false, error: e.message };
          }
        }));
        return json({ results }, results.some(r => r.ok) ? 200 : 502, h);
      }

      return json({ error: 'Okänd väg' }, 404, h);
    } catch (e) {
      return json({ error: e.message }, 502, h);
    }
  },
};
