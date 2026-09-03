/* ══════════════════════════════════════════════════════════════════════════════
   GWM CALENDAR AUTOMATION  ·  v1.0
   ------------------------------------------------------------------------------
   A drop-in module for the existing gwm-clio-api Cloudflare Worker.

   What it does, on a five-minute cron, with nobody's browser open:
     1. reads your Google Calendars
     2. finds every event that has already ended and has no note yet
     3. creates a Clio Task  — "Complete a note for <event> — <date> at <time>"
        linked to the matching Clio matter when it can find one
     4. drops the same item into a pending queue the app polls, so the browser
        raises a real notification the moment you have a window open

   Nothing here talks to Clio directly if your Worker already knows how.
   Pass your own authenticated helper in as `hooks.clioFetch` and this module
   uses it.  If you do not, it falls back to reading the stored Clio token out
   of KV itself.  See INTEGRATION at the bottom of this file.
   ══════════════════════════════════════════════════════════════════════════════ */

/* ── 1 · DEFAULTS ─────────────────────────────────────────────────────────── */

export const DEFAULT_SETTINGS = {
  enabled:            true,

  /* Google */
  calendarIds:        [],                    /* [] means "primary" only        */
  timeZone:           'America/Chicago',

  /* When a note becomes due */
  fireOffsetMinutes:  0,                     /* 0 = the moment the event ends  */
  lookbackHours:      36,                    /* how far back a sweep reaches   */

  /* What counts as note-worthy */
  skipAllDay:         true,
  skipDeclined:       true,
  skipCancelled:      true,
  minDurationMinutes: 0,
  skipKeywords:       ['lunch', 'ooo', 'out of office', 'block', 'blocked',
                       'hold', 'personal', 'pto', 'vacation', 'travel',
                       'do not schedule', 'busy'],
  onlyKeywords:       [],                    /* [] = no allow-list filtering   */

  /* The Clio task */
  taskNamePattern:    'Complete a note for {EVENT} — {DATE} at {START}',
  taskPriority:       'Normal',              /* High | Normal | Low            */
  taskPermission:     'public',              /* public | private               */
  notifyAssignee:     true,
  dueMode:            'end_of_day',          /* event_end | end_of_day | next_day */
  assigneeId:         null,                  /* null = whoever authorised Clio */
  autoLinkMatter:     true,

  /* The browser side */
  browserNotifications: true,
  quietStart:         21,                    /* 21:00 — no pop-ups after this  */
  quietEnd:           7                      /* 07:00 — none before this       */
};

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'openid', 'email'
].join(' ');

const K = {
  google:   'gwm:google:tokens',
  settings: 'gwm:settings',
  pending:  'gwm:pending',
  runlog:   'gwm:lastrun',
  state:    'gwm:oauthstate',
  evt:      (uid) => 'gwm:evt:' + uid,
  matter:   (key) => 'gwm:mm:'  + key
};

const PENDING_MAX = 250;
const EVT_TTL     = 60 * 60 * 24 * 120;      /* remember an event for 120 days */

/* ── 2 · SMALL HELPERS ────────────────────────────────────────────────────── */

const ALLOWED_ORIGINS = [
  'https://gmannion5149.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'null'
];

function cors(origin) {
  const ok = origin && (ALLOWED_ORIGINS.includes(origin) || /^https?:\/\/localhost(:\d+)?$/.test(origin));
  return {
    'Access-Control-Allow-Origin':  ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Accept',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin'
  };
}

function J(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin) }
  });
}

function HTML(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

/* Finds the KV namespace without needing to know what you called the binding. */
function kvOf(env) {
  if (env.GWM_KV)      return env.GWM_KV;
  if (env.CLIO_TOKENS) return env.CLIO_TOKENS;
  if (env.CLIO_KV)     return env.CLIO_KV;
  if (env.KV)       return env.KV;
  if (env.TOKENS)   return env.TOKENS;
  for (const v of Object.values(env)) {
    if (v && typeof v.get === 'function' && typeof v.put === 'function' && typeof v.list === 'function') return v;
  }
  throw new Error('No KV namespace is bound to this Worker. Bind one as GWM_KV.');
}

async function kvJSON(env, key, fallback) {
  try {
    const raw = await kvOf(env).get(key);
    return raw ? JSON.parse(raw) : (fallback === undefined ? null : fallback);
  } catch (e) { return fallback === undefined ? null : fallback; }
}

async function kvPut(env, key, value, opts) {
  return kvOf(env).put(key, JSON.stringify(value), opts || {});
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function clamp(n, lo, hi) { n = Number(n); return isNaN(n) ? lo : Math.min(hi, Math.max(lo, n)); }

/* Formats an instant in a named zone. Workers ship full ICU, so this is safe. */
function fmt(iso, tz, opts) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Chicago', ...opts }).format(new Date(iso));
  } catch (e) { return String(iso || ''); }
}
const fmtDate  = (iso, tz) => fmt(iso, tz, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmtDay   = (iso, tz) => fmt(iso, tz, { month: 'numeric', day: 'numeric', year: 'numeric' });
const fmtTime  = (iso, tz) => fmt(iso, tz, { hour: 'numeric', minute: '2-digit' });
const fmtISODay = (iso, tz) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  return p;   /* en-CA gives YYYY-MM-DD */
};

/* The offset a zone is at on a given instant, as "-05:00". */
function zoneOffset(iso, tz) {
  try {
    const d = new Date(iso);
    const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).format(d);
    const m = s.match(/GMT([+-]\d{2}:\d{2})/);
    return m ? m[1] : '+00:00';
  } catch (e) { return '+00:00'; }
}

/* ── 3 · GOOGLE OAUTH ─────────────────────────────────────────────────────── */

function googleRedirectURI(env, url) {
  return env.GOOGLE_REDIRECT_URI || (new URL(url).origin + '/google/callback');
}

function googleAuthURL(env, url, state) {
  const p = new URLSearchParams({
    client_id:             env.GOOGLE_CLIENT_ID,
    redirect_uri:          googleRedirectURI(env, url),
    response_type:         'code',
    scope:                 GOOGLE_SCOPES,
    access_type:           'offline',
    prompt:                'consent',
    include_granted_scopes:'true',
    state:                 state
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

async function googleTokenCall(env, form) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams(form).toString()
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error_description || data.error || ('Google token call failed (' + r.status + ')'));
    e.status = r.status; e.google = data;
    throw e;
  }
  return data;
}

async function googleExchange(env, url, code) {
  const tok = await googleTokenCall(env, {
    code,
    client_id:     env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri:  googleRedirectURI(env, url),
    grant_type:    'authorization_code'
  });

  let email = '';
  try {
    const who = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + tok.access_token }
    }).then(r => r.json());
    email = who.email || '';
  } catch (e) {}

  const rec = {
    refresh_token: tok.refresh_token || null,
    access_token:  tok.access_token,
    expires_at:    Date.now() + (Number(tok.expires_in || 3500) - 90) * 1000,
    email,
    scope:         tok.scope || GOOGLE_SCOPES,
    connected_at:  new Date().toISOString()
  };

  if (!rec.refresh_token) {
    /* Google only hands out a refresh token on first consent. Keep the old one. */
    const prev = await kvJSON(env, K.google);
    if (prev && prev.refresh_token) rec.refresh_token = prev.refresh_token;
  }
  if (!rec.refresh_token) {
    throw new Error('Google did not return a refresh token. Revoke the app at ' +
                    'myaccount.google.com/permissions and connect again.');
  }

  await kvPut(env, K.google, rec);
  return rec;
}

async function googleToken(env) {
  const rec = await kvJSON(env, K.google);
  if (!rec || !rec.refresh_token) {
    const e = new Error('Google Calendar is not connected.');
    e.reauthorize = 'google'; e.status = 401;
    throw e;
  }
  if (rec.access_token && rec.expires_at && Date.now() < rec.expires_at) return rec.access_token;

  const tok = await googleTokenCall(env, {
    refresh_token: rec.refresh_token,
    client_id:     env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    grant_type:    'refresh_token'
  }).catch(async (err) => {
    if (err.status === 400 || err.status === 401) {
      await kvOf(env).delete(K.google);
      const e = new Error('Google authorization was revoked — reconnect Google Calendar.');
      e.reauthorize = 'google'; e.status = 401;
      throw e;
    }
    throw err;
  });

  rec.access_token = tok.access_token;
  rec.expires_at   = Date.now() + (Number(tok.expires_in || 3500) - 90) * 1000;
  await kvPut(env, K.google, rec);
  return rec.access_token;
}

async function gcal(env, path, params) {
  const token = await googleToken(env);
  const url = new URL('https://www.googleapis.com/calendar/v3' + path);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });
  const r = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + token } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((data.error && data.error.message) || ('Google Calendar request failed (' + r.status + ')'));
    e.status = r.status;
    if (r.status === 401) e.reauthorize = 'google';
    throw e;
  }
  return data;
}

async function listCalendars(env) {
  const out = [];
  let pageToken;
  do {
    const d = await gcal(env, '/users/me/calendarList', { maxResults: 250, pageToken, showHidden: false });
    (d.items || []).forEach(c => out.push({
      id:        c.id,
      name:      c.summaryOverride || c.summary || c.id,
      primary:   !!c.primary,
      selected:  !!c.selected,
      color:     c.backgroundColor || '#B8873B',
      timeZone:  c.timeZone || '',
      accessRole:c.accessRole || ''
    }));
    pageToken = d.nextPageToken;
  } while (pageToken);
  out.sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name));
  return out;
}

async function listEvents(env, calendarId, timeMin, timeMax) {
  const out = [];
  let pageToken;
  do {
    const d = await gcal(env, '/calendars/' + encodeURIComponent(calendarId) + '/events', {
      timeMin, timeMax,
      singleEvents: 'true',
      orderBy:      'startTime',
      maxResults:   250,
      showDeleted:  'false',
      pageToken
    });
    (d.items || []).forEach(e => out.push(e));
    pageToken = d.nextPageToken;
  } while (pageToken);
  return out;
}

/* ── 4 · CLIO LAYER ───────────────────────────────────────────────────────── */
/*  Preferred path: your Worker already has an authenticated helper. Pass it in
    as hooks.clioFetch(path, init) -> Response.  The fallback below only runs if
    you do not, and it reads whatever token record your Worker already stored.  */

const CLIO_BASE = 'https://app.clio.com/api/v4';

async function fallbackClioToken(env) {
  const keys = ['clio_tokens', 'clio:tokens', 'clio_token', 'tokens', 'token', 'CLIO_TOKENS'];
  const kv = kvOf(env);
  let rec = null;
  for (const k of keys) {
    const raw = await kv.get(k);
    if (!raw) continue;
    try { rec = JSON.parse(raw); } catch (e) { rec = { access_token: raw }; }
    if (rec && (rec.access_token || rec.refresh_token)) { rec.__key = k; break; }
    rec = null;
  }
  if (!rec) {
    /* Last resort: let the Worker look through its own namespace for the
       record that carries a refresh token. Nothing leaves the Worker. */
    try {
      const listing = await kv.list({ limit: 100 });
      for (const k of listing.keys || []) {
        if (String(k.name).startsWith('gwm:')) continue;
        const raw = await kv.get(k.name);
        if (!raw) continue;
        try {
          const cand = JSON.parse(raw);
          if (cand && cand.refresh_token) { rec = cand; rec.__key = k.name; break; }
        } catch (e) {}
      }
    } catch (e) {}
  }
  if (!rec) {
    const e = new Error('Could not find the stored Clio token in KV. Pass your own clioFetch into gwmRoute/gwmScan.');
    e.status = 500;
    throw e;
  }

  const expired = rec.expires_at && Date.now() > (Number(rec.expires_at) < 1e12 ? Number(rec.expires_at) * 1000 : Number(rec.expires_at)) - 60000;
  if (!expired && rec.access_token) return rec.access_token;

  if (!rec.refresh_token || !env.CLIO_CLIENT_ID || !env.CLIO_CLIENT_SECRET) {
    if (rec.access_token) return rec.access_token;
    const e = new Error('Clio token is expired and cannot be refreshed here.');
    e.status = 401; e.reauthorize = 'clio';
    throw e;
  }

  const r = await fetch('https://app.clio.com/oauth/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     env.CLIO_CLIENT_ID,
      client_secret: env.CLIO_CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: rec.refresh_token
    }).toString()
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(d.error_description || d.error || 'Clio token refresh failed');
    e.status = 401; e.reauthorize = 'clio';
    throw e;
  }
  const next = { ...rec, access_token: d.access_token, expires_at: Date.now() + (Number(d.expires_in || 3600) - 60) * 1000 };
  if (d.refresh_token) next.refresh_token = d.refresh_token;
  delete next.__key;
  await kv.put(rec.__key, JSON.stringify(next));
  return next.access_token;
}

function makeClio(env, hooks) {
  if (hooks && typeof hooks.clioFetch === 'function') {
    return async (path, init) => {
      /* Clio answers both /tasks and /tasks.json — hand the host helper the
         bare form so it can apply its own convention without doubling up. */
      const bare = path.replace(/\.json(?=\?|$)/, '');
      const r = await hooks.clioFetch(bare, init);
      if (r && typeof r.text === 'function' && 'status' in r) return unwrapClio(r, path);
      /* a helper that already parsed the JSON for us */
      if (r && r.data !== undefined) return r.data;
      return r;
    };
  }
  return async (path, init) => {
    const token = await fallbackClioToken(env);
    const r = await fetch(CLIO_BASE + path, {
      ...(init || {}),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        ...((init && init.headers) || {})
      }
    });
    return unwrapClio(r, path);
  };
}

async function unwrapClio(r, path) {
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { raw: txt }; }
  if (!r.ok) {
    const msg = (data && (data.error?.message || data.error || data.message)) ||
                ('Clio request failed (' + r.status + ') on ' + path);
    const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    e.status = r.status;
    if (r.status === 401) e.reauthorize = 'clio';
    throw e;
  }
  return data && data.data !== undefined ? data.data : data;
}

async function clioWhoAmI(clio) {
  return clio('/users/who_am_i.json?fields=id,name,email');
}

/* Best-effort matter match.  Returns { id, label, confidence } or null.
   Confidence is 'explicit' when the event itself names the matter,
   'high' when exactly one open matter answers the search, 'low' otherwise. */
async function matchMatter(env, clio, event, settings) {
  if (!settings.autoLinkMatter) return null;

  const hay = [event.summary || '', event.description || '', event.location || ''].join(' \n ');

  /* 1 — an explicit marker beats every guess: [matter:12345] or [clio:12345]  */
  const explicit = hay.match(/\[(?:matter|clio)\s*[:=]\s*(\d{3,})\]/i);
  if (explicit) {
    return { id: Number(explicit[1]), label: 'tagged in the event', confidence: 'explicit' };
  }

  /* 2 — a Clio display number such as 02587-Kroll                             */
  const dispNum = hay.match(/\b(\d{4,6}-[A-Za-z][\w'’-]{1,30})\b/);
  const title   = String(event.summary || '').trim();

  /* 3 — the app's own calendar-title shape:  GWM: Kroll | PT | Hennepin       */
  let query = '';
  if (dispNum) {
    query = dispNum[1];
  } else {
    let t = title.replace(/^\s*(GWM|GMPA)\s*[:\-–]\s*/i, '');
    t = t.split('|')[0];
    t = t.replace(/\b(hearing|pretrial|omnibus|trial|plea|sentencing|review|meeting|consult|consultation|call|zoom|teams|court|conference|appearance|arraignment|status)\b/gi, '');
    t = t.replace(/[^\p{L}\p{N}'’ -]/gu, ' ').replace(/\s+/g, ' ').trim();
    query = t;
  }
  if (!query || query.length < 3) return null;

  const cacheKey = K.matter(query.toLowerCase().slice(0, 80));
  const cached = await kvJSON(env, cacheKey);
  if (cached) return cached;

  let found = null;
  try {
    const res = await clio('/matters.json?fields=id,display_number,description,status,' +
      'client{id,name}&limit=10&query=' + encodeURIComponent(query));
    const rows = Array.isArray(res) ? res : [];
    const open = rows.filter(m => String(m.status || '').toLowerCase() === 'open');
    const pool = open.length ? open : rows;
    if (pool.length === 1) {
      found = { id: pool[0].id, label: pool[0].display_number || (pool[0].client && pool[0].client.name) || '',
                confidence: dispNum ? 'explicit' : 'high' };
    } else if (pool.length > 1) {
      found = { id: pool[0].id, label: pool[0].display_number || '', confidence: 'low', alternatives: pool.length };
    }
  } catch (e) { found = null; }

  if (found) await kvPut(env, cacheKey, found, { expirationTtl: 60 * 60 * 24 * 14 });
  return found;
}

/* ── 5 · THE SCAN ─────────────────────────────────────────────────────────── */

function eventUID(calendarId, ev) {
  return (calendarId + '|' + (ev.id || '') + '|' + (ev.recurringEventId || '')).slice(0, 400);
}

function eventTimes(ev) {
  const allDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
  const start  = ev.start && (ev.start.dateTime || ev.start.date);
  const end    = ev.end   && (ev.end.dateTime   || ev.end.date);
  return { allDay, start, end };
}

function selfDeclined(ev) {
  const me = (ev.attendees || []).find(a => a.self);
  return !!(me && me.responseStatus === 'declined');
}

/* Returns a reason string when the event should be skipped, else ''. */
function skipReason(ev, settings, nowMs) {
  const { allDay, start, end } = eventTimes(ev);
  if (!start || !end)                                   return 'no times';
  if (ev.status === 'cancelled' && settings.skipCancelled) return 'cancelled';
  if (allDay && settings.skipAllDay)                    return 'all-day';
  if (settings.skipDeclined && selfDeclined(ev))        return 'declined';
  if (ev.eventType && ['outOfOffice', 'focusTime', 'workingLocation'].includes(ev.eventType)) return ev.eventType;
  if (ev.transparency === 'transparent')                return 'free';

  const endMs = new Date(end).getTime();
  const startMs = new Date(start).getTime();
  const mins = Math.round((endMs - startMs) / 60000);
  if (settings.minDurationMinutes && mins < settings.minDurationMinutes) return 'too short';

  const fireAt = endMs + (settings.fireOffsetMinutes || 0) * 60000;
  if (fireAt > nowMs)                                    return 'not ended yet';

  const title = String(ev.summary || '').toLowerCase();
  if (!title.trim())                                     return 'untitled';
  if ((settings.onlyKeywords || []).length &&
      !settings.onlyKeywords.some(k => title.includes(String(k).toLowerCase()))) return 'not on allow-list';
  if ((settings.skipKeywords || []).some(k => k && title.includes(String(k).toLowerCase()))) return 'skip word';

  return '';
}

function fillPattern(pattern, ev, tz) {
  const { start, end } = eventTimes(ev);
  const map = {
    '{EVENT}':    String(ev.summary || 'Untitled event').trim(),
    '{DATE}':     fmtDate(start, tz),
    '{SHORTDATE}':fmtDay(start, tz),
    '{START}':    fmtTime(start, tz),
    '{END}':      fmtTime(end, tz),
    '{LOCATION}': String(ev.location || '').trim(),
    '{CALENDAR}': String(ev.__calendarName || '').trim()
  };
  let out = String(pattern || '');
  Object.entries(map).forEach(([k, v]) => { out = out.split(k).join(v); });
  return out.replace(/\s*[—–|·-]\s*(?=\s*[—–|·-]|$)/g, '').replace(/\s{2,}/g, ' ').trim();
}

function taskDescription(ev, tz, match, appUrl) {
  const { start, end, allDay } = eventTimes(ev);
  const when = allDay
    ? fmtDate(start, tz) + ' (all day)'
    : fmtDate(start, tz) + ' · ' + fmtTime(start, tz) + ' – ' + fmtTime(end, tz) + ' ' +
      fmt(start, tz, { timeZoneName: 'short' }).split(' ').pop();

  const rows = [
    ['Calendar event', String(ev.summary || 'Untitled event').trim()],
    ['Date',           fmtDate(start, tz)],
    ['Time',           allDay ? 'All day' : (fmtTime(start, tz) + ' – ' + fmtTime(end, tz))],
    ['When',           when],
    ['Calendar',       ev.__calendarName || ''],
    ['Location',       ev.location || ''],
    ['Matter',         match ? (match.label + (match.confidence === 'low' ? ' (best guess — please confirm)' : '')) : 'not matched automatically']
  ].filter(r => r[1]);

  const list = rows.map(r => '<li><b>' + esc(r[0]) + ':</b> ' + esc(r[1]) + '</li>').join('');
  const link = appUrl
    ? '<p><a href="' + esc(appUrl) + '" target="_blank" rel="noopener">Open the Clio Note Generator</a> and write this note.</p>'
    : '';
  const notes = ev.description
    ? '<p><b>Event notes:</b><br>' + esc(String(ev.description).slice(0, 1200)).replace(/\n/g, '<br>') + '</p>'
    : '';

  return '<p>A calendar event has finished and no note has been written for it yet.</p>' +
         '<ul>' + list + '</ul>' + notes + link +
         '<p><i>Raised automatically by the Clio Note Generator.</i></p>';
}

function dueAtFor(ev, settings, tz) {
  const { end } = eventTimes(ev);
  const endMs = new Date(end).getTime();
  if (settings.dueMode === 'event_end') return new Date(endMs).toISOString();

  const anchor = settings.dueMode === 'next_day' ? new Date(endMs + 86400000).toISOString() : end;
  const dayISO = fmtISODay(anchor, tz);
  const off    = zoneOffset(anchor, tz);
  const fivePM = new Date(dayISO + 'T17:00:00' + off).getTime();
  /* an evening hearing should never be due before it finished */
  if (fivePM <= endMs) return new Date(endMs + 60 * 60000).toISOString();
  return dayISO + 'T17:00:00' + off;      /* 5pm local on the chosen day */
}

async function createClioTask(clio, ev, settings, tz, match, assigneeId, appUrl) {
  const data = {
    name:                 fillPattern(settings.taskNamePattern || DEFAULT_SETTINGS.taskNamePattern, ev, tz).slice(0, 250),
    description:          taskDescription(ev, tz, match, appUrl),
    description_text_type:'rich_text',
    due_at:               dueAtFor(ev, settings, tz),
    priority:             settings.taskPriority || 'Normal',
    permission:           settings.taskPermission || 'public',
    status:               'pending',
    notify_assignee:      !!settings.notifyAssignee
  };
  if (assigneeId)                       data.assignee = { id: Number(assigneeId), type: 'User' };
  if (match && match.confidence !== 'low') data.matter = { id: Number(match.id) };

  const created = await clio('/tasks.json?fields=id,name,due_at,status,matter{id,display_number}', {
    method: 'POST',
    body:   JSON.stringify({ data })
  });
  return created;
}

async function readPending(env) {
  const list = await kvJSON(env, K.pending, []);
  return Array.isArray(list) ? list : [];
}

async function writePending(env, list) {
  const trimmed = list
    .sort((a, b) => new Date(b.eventEnd || 0) - new Date(a.eventEnd || 0))
    .slice(0, PENDING_MAX);
  await kvPut(env, K.pending, trimmed);
  return trimmed;
}

export async function gwmScan(env, hooks, opts) {
  const started  = Date.now();
  const settings = { ...DEFAULT_SETTINGS, ...(await kvJSON(env, K.settings, {})) };
  const force    = !!(opts && opts.force);
  const result   = { ok: true, ranAt: new Date().toISOString(), scanned: 0, created: 0,
                     skipped: 0, failed: 0, calendars: [], items: [], errors: [] };

  if (!settings.enabled && !force) { result.ok = true; result.disabled = true; return result; }

  const clio = makeClio(env, hooks);
  const tz   = settings.timeZone || DEFAULT_SETTINGS.timeZone;
  const appUrl = env.APP_URL || 'https://gmannion5149.github.io/GWMNotes/';

  /* who the task belongs to */
  let assigneeId = settings.assigneeId || null;
  if (!assigneeId) {
    try { const me = await clioWhoAmI(clio); assigneeId = me && me.id; } catch (e) { result.errors.push('who_am_i: ' + e.message); }
  }

  const now     = Date.now();
  const timeMin = new Date(now - clamp(settings.lookbackHours, 1, 24 * 14) * 3600000).toISOString();
  const timeMax = new Date(now + 3600000).toISOString();

  let calIds = (settings.calendarIds || []).filter(Boolean);
  let calNames = {};
  try {
    const cals = await listCalendars(env);
    cals.forEach(c => { calNames[c.id] = c.name; });
    if (!calIds.length) {
      const primary = cals.find(c => c.primary);
      calIds = primary ? [primary.id] : cals.slice(0, 1).map(c => c.id);
    }
  } catch (e) {
    result.ok = false; result.errors.push('calendars: ' + e.message);
    if (e.reauthorize) result.reauthorize = e.reauthorize;
    return result;
  }

  const pending = await readPending(env);
  const kv = kvOf(env);

  for (const calId of calIds) {
    let events = [];
    try {
      events = await listEvents(env, calId, timeMin, timeMax);
    } catch (e) {
      result.errors.push('events(' + calId + '): ' + e.message);
      if (e.reauthorize) result.reauthorize = e.reauthorize;
      continue;
    }
    result.calendars.push({ id: calId, name: calNames[calId] || calId, events: events.length });

    for (const ev of events) {
      result.scanned++;
      ev.__calendarName = calNames[calId] || calId;

      const why = skipReason(ev, settings, now);
      if (why) { result.skipped++; continue; }

      const uid  = eventUID(calId, ev);
      const seen = await kvJSON(env, K.evt(uid));
      if (seen && !force) { result.skipped++; continue; }

      const { start, end } = eventTimes(ev);
      let match = null;
      try { match = await matchMatter(env, clio, ev, settings); }
      catch (e) { result.errors.push('matter(' + (ev.summary || '') + '): ' + e.message); }

      let task = null, taskErr = '';
      try {
        task = await createClioTask(clio, ev, settings, tz, match, assigneeId, appUrl);
        result.created++;
      } catch (e) {
        taskErr = e.message; result.failed++;
        result.errors.push('task(' + (ev.summary || '') + '): ' + e.message);
        if (e.reauthorize === 'clio') { result.reauthorize = 'clio'; }
      }

      const item = {
        uid,
        calendarId:   calId,
        calendarName: calNames[calId] || calId,
        eventId:      ev.id,
        title:        String(ev.summary || 'Untitled event').trim(),
        htmlLink:     ev.htmlLink || '',
        location:     ev.location || '',
        eventStart:   start,
        eventEnd:     end,
        dateLabel:    fmtDate(start, tz),
        timeLabel:    fmtTime(start, tz) + ' – ' + fmtTime(end, tz),
        dayISO:       fmtISODay(start, tz),
        startHM:      fmt(start, tz, { hour12: false, hour: '2-digit', minute: '2-digit' }),
        endHM:        fmt(end,   tz, { hour12: false, hour: '2-digit', minute: '2-digit' }),
        matterId:     match ? match.id : null,
        matterLabel:  match ? match.label : '',
        matterConfidence: match ? match.confidence : '',
        taskId:       task ? task.id : null,
        taskName:     task ? task.name : fillPattern(settings.taskNamePattern, ev, tz),
        taskError:    taskErr,
        status:       'open',
        notified:     false,
        createdAt:    new Date().toISOString()
      };

      const idx = pending.findIndex(p => p.uid === uid);
      if (idx >= 0) pending[idx] = { ...pending[idx], ...item }; else pending.push(item);
      result.items.push(item);

      await kv.put(K.evt(uid), JSON.stringify({ taskId: item.taskId, at: item.createdAt, error: taskErr }),
                   { expirationTtl: EVT_TTL });
    }
  }

  await writePending(env, pending);
  result.ms = Date.now() - started;
  await kvPut(env, K.runlog, result);
  return result;
}

/* ── 6 · HTTP ROUTES ──────────────────────────────────────────────────────── */

function popupPage(ok, title, message, payload) {
  return HTML(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
 background:#08090C;background-image:radial-gradient(700px 320px at 50% -10%,rgba(184,135,59,.10) 0%,transparent 62%),
 linear-gradient(180deg,#0E1116 0%,#08090C 60%,#060709 100%);
 color:#E4E9F0;display:flex;align-items:center;justify-content:center;padding:26px}
.card{width:100%;max-width:420px;text-align:center;background:linear-gradient(180deg,#12161C 0%,#0C0F14 100%);
 border:1px solid #2A323D;border-radius:12px;padding:34px 30px 30px;position:relative;box-shadow:0 26px 70px rgba(0,0,0,.75)}
.card::before{content:'';position:absolute;top:0;left:16px;right:16px;height:1px;
 background:linear-gradient(90deg,transparent,#B8873B,transparent);box-shadow:0 0 10px rgba(184,135,59,.45)}
.badge{width:46px;height:46px;border-radius:10px;margin:0 auto 18px;display:flex;align-items:center;justify-content:center;
 font-size:20px;font-weight:800;color:#DCB878;background:linear-gradient(150deg,#1A212B,#0E1218);
 border:1px solid rgba(184,135,59,.34);box-shadow:0 0 16px rgba(184,135,59,.16),inset 0 1px 0 rgba(255,255,255,.05)}
h1{font-size:16px;font-weight:700;margin-bottom:8px;color:${ok ? '#7FC095' : '#E9A9A2'}}
p{font-size:13px;color:#6C7686;line-height:1.65}
</style></head><body><div class="card"><div class="badge">§</div>
<h1>${esc(title)}</h1><p>${esc(message)}</p></div>
<script>
try{ if(window.opener && !window.opener.closed){ window.opener.postMessage(${JSON.stringify(payload)},"*"); } }catch(e){}
setTimeout(function(){ try{ window.close(); }catch(e){} }, ${ok ? 900 : 4000});
</script></body></html>`, ok ? 200 : 400);
}

/* Returns a Response for anything this module owns, or null so your Worker's
   own router carries on untouched. */
export async function gwmRoute(request, env, ctx, hooks) {
  const url    = new URL(request.url);
  const path   = url.pathname.replace(/\/+$/, '') || '/';
  const origin = request.headers.get('Origin') || '';
  const mine   = path.startsWith('/google') || path.startsWith('/gwm') || path === '/clio/task' || path.startsWith('/clio/task/');
  if (!mine) return null;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

  const body = async () => { try { return await request.json(); } catch (e) { return {}; } };
  const settings = async () => ({ ...DEFAULT_SETTINGS, ...(await kvJSON(env, K.settings, {})) });

  try {
    /* ---- Google connection ------------------------------------------------ */

    if (path === '/google/status') {
      const rec = await kvJSON(env, K.google);
      if (!rec || !rec.refresh_token) return J({ connected: false }, 200, origin);
      let live = true, err = '';
      try { await googleToken(env); } catch (e) { live = false; err = e.message; }
      return J({ connected: live, email: rec.email || '', connected_at: rec.connected_at || '', error: err }, 200, origin);
    }

    if (path === '/google/authorize') {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        return J({ error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set on this Worker.' }, 500, origin);
      }
      const state = crypto.randomUUID();
      await kvOf(env).put(K.state + ':' + state, '1', { expirationTtl: 900 });
      return Response.redirect(googleAuthURL(env, request.url, state), 302);
    }

    if (path === '/google/callback') {
      const err   = url.searchParams.get('error');
      const code  = url.searchParams.get('code');
      const state = url.searchParams.get('state') || '';
      if (err)  return popupPage(false, 'Google authorization declined', err, { type: 'gwm-google-failed', error: err });
      if (!code) return popupPage(false, 'No authorization code', 'Google did not return a code.', { type: 'gwm-google-failed', error: 'no code' });

      const okState = state && await kvOf(env).get(K.state + ':' + state);
      if (!okState) return popupPage(false, 'Session expired', 'Close this window and press Connect again.', { type: 'gwm-google-failed', error: 'bad state' });
      await kvOf(env).delete(K.state + ':' + state);

      try {
        const rec = await googleExchange(env, request.url, code);
        return popupPage(true, 'Google Calendar Connected',
          (rec.email ? 'Signed in as ' + rec.email + '. ' : '') + 'You can close this window.',
          { type: 'gwm-google-connected', email: rec.email || '' });
      } catch (e) {
        return popupPage(false, 'Google connection failed', e.message, { type: 'gwm-google-failed', error: e.message });
      }
    }

    if (path === '/google/disconnect' && request.method === 'POST') {
      await kvOf(env).delete(K.google);
      return J({ ok: true, connected: false }, 200, origin);
    }

    if (path === '/google/calendars') {
      const cals = await listCalendars(env);
      const s = await settings();
      return J({ ok: true, calendars: cals, selected: s.calendarIds || [] }, 200, origin);
    }

    if (path === '/google/upcoming') {
      const s = await settings();
      const tz = s.timeZone || DEFAULT_SETTINGS.timeZone;
      const cals = await listCalendars(env);
      const names = {}; cals.forEach(c => names[c.id] = c.name);
      let ids = (s.calendarIds || []).filter(Boolean);
      if (!ids.length) { const p = cals.find(c => c.primary); ids = p ? [p.id] : []; }
      const days = clamp(url.searchParams.get('days') || 1, 1, 14);
      const t0 = new Date(Date.now() - 12 * 3600000).toISOString();
      const t1 = new Date(Date.now() + days * 86400000).toISOString();
      const done = await readPending(env);
      const out = [];
      for (const id of ids) {
        const evs = await listEvents(env, id, t0, t1);
        evs.forEach(ev => {
          const { start, end, allDay } = eventTimes(ev);
          if (!start) return;
          const uid = eventUID(id, ev);
          const p = done.find(x => x.uid === uid);
          out.push({
            uid, title: ev.summary || 'Untitled event', calendarName: names[id] || id,
            start, end, allDay,
            dateLabel: fmtDate(start, tz), timeLabel: allDay ? 'All day' : (fmtTime(start, tz) + ' – ' + fmtTime(end, tz)),
            noteStatus: p ? p.status : (new Date(end).getTime() < Date.now() ? 'unfiled' : 'upcoming'),
            taskId: p ? p.taskId : null
          });
        });
      }
      out.sort((a, b) => new Date(a.start) - new Date(b.start));
      return J({ ok: true, events: out }, 200, origin);
    }

    /* ---- Settings --------------------------------------------------------- */

    if (path === '/gwm/settings' && request.method === 'GET') {
      return J({ ok: true, settings: await settings(), defaults: DEFAULT_SETTINGS }, 200, origin);
    }

    if (path === '/gwm/settings' && request.method === 'POST') {
      const incoming = await body();
      const merged = { ...DEFAULT_SETTINGS, ...(await kvJSON(env, K.settings, {})), ...(incoming.settings || incoming) };
      merged.lookbackHours      = clamp(merged.lookbackHours, 1, 336);
      merged.fireOffsetMinutes  = clamp(merged.fireOffsetMinutes, 0, 1440);
      merged.minDurationMinutes = clamp(merged.minDurationMinutes, 0, 600);
      merged.quietStart         = clamp(merged.quietStart, 0, 23);
      merged.quietEnd           = clamp(merged.quietEnd, 0, 23);
      if (!['High', 'Normal', 'Low'].includes(merged.taskPriority)) merged.taskPriority = 'Normal';
      if (!['public', 'private'].includes(merged.taskPermission))   merged.taskPermission = 'public';
      if (!['event_end', 'end_of_day', 'next_day'].includes(merged.dueMode)) merged.dueMode = 'end_of_day';
      if (!Array.isArray(merged.calendarIds)) merged.calendarIds = [];
      if (!Array.isArray(merged.skipKeywords)) merged.skipKeywords = DEFAULT_SETTINGS.skipKeywords;
      if (!Array.isArray(merged.onlyKeywords)) merged.onlyKeywords = [];
      await kvPut(env, K.settings, merged);
      return J({ ok: true, settings: merged }, 200, origin);
    }

    /* ---- Pending queue ---------------------------------------------------- */

    if (path === '/gwm/pending' && request.method === 'GET') {
      const list = await readPending(env);
      const s    = await settings();
      const open = list.filter(p => p.status === 'open');
      const run  = await kvJSON(env, K.runlog, null);
      return J({ ok: true, pending: open, all: list.length, count: open.length,
                 settings: { browserNotifications: s.browserNotifications, quietStart: s.quietStart, quietEnd: s.quietEnd },
                 lastRun: run ? { ranAt: run.ranAt, created: run.created, scanned: run.scanned, errors: run.errors } : null
               }, 200, origin);
    }

    if (path === '/gwm/pending/seen' && request.method === 'POST') {
      const { uids } = await body();
      const list = await readPending(env);
      (uids || []).forEach(u => { const p = list.find(x => x.uid === u); if (p) p.notified = true; });
      await writePending(env, list);
      return J({ ok: true }, 200, origin);
    }

    if (path === '/gwm/pending/resolve' && request.method === 'POST') {
      const { uid, action, completeTask } = await body();
      const list = await readPending(env);
      const p = list.find(x => x.uid === uid);
      if (!p) return J({ error: 'Unknown item' }, 404, origin);

      p.status     = action === 'dismiss' ? 'dismissed' : 'done';
      p.resolvedAt = new Date().toISOString();

      let taskResult = null;
      if (p.taskId && completeTask !== false) {
        try {
          const clio = makeClio(env, hooks);
          await clio('/tasks/' + p.taskId + '.json?fields=id,status', {
            method: 'PATCH',
            body:   JSON.stringify({ data: { status: 'complete' } })
          });
          taskResult = { ok: true, id: p.taskId };
          p.taskCompleted = true;
        } catch (e) { taskResult = { ok: false, error: e.message }; }
      }
      await writePending(env, list);
      return J({ ok: true, item: p, task: taskResult }, 200, origin);
    }

    if (path === '/gwm/pending/clear' && request.method === 'POST') {
      await kvPut(env, K.pending, []);
      return J({ ok: true }, 200, origin);
    }

    /* ---- Manual scan + diagnostics ---------------------------------------- */

    if (path === '/gwm/scan' && request.method === 'POST') {
      const { force } = await body();
      const res = await gwmScan(env, hooks, { force: !!force });
      return J(res, res.ok ? 200 : 502, origin);
    }

    if (path === '/gwm/status') {
      const g   = await kvJSON(env, K.google);
      const s   = await settings();
      const run = await kvJSON(env, K.runlog, null);
      const list = await readPending(env);
      return J({
        ok: true,
        google:  { connected: !!(g && g.refresh_token), email: (g && g.email) || '' },
        settings: s,
        pendingOpen: list.filter(p => p.status === 'open').length,
        lastRun: run
      }, 200, origin);
    }

    /* ---- Ad-hoc Clio task (used by the app's "make me a task" button) ------ */

    if (path === '/clio/task' && request.method === 'POST') {
      const b = await body();
      if (!b.name) return J({ ok: false, error: 'A task name is required.' }, 400, origin);
      const clio = makeClio(env, hooks);
      const data = {
        name:                  String(b.name).slice(0, 250),
        description:           b.description || '',
        description_text_type: b.description_text_type || 'rich_text',
        priority:              ['High', 'Normal', 'Low'].includes(b.priority) ? b.priority : 'Normal',
        permission:            b.permission === 'private' ? 'private' : 'public',
        status:                'pending',
        notify_assignee:       b.notify_assignee !== false
      };
      if (b.due_at)      data.due_at   = b.due_at;
      if (b.matter_id)   data.matter   = { id: Number(b.matter_id) };
      if (b.assignee_id) data.assignee = { id: Number(b.assignee_id), type: 'User' };
      else {
        try { const me = await clioWhoAmI(clio); if (me && me.id) data.assignee = { id: me.id, type: 'User' }; } catch (e) {}
      }
      const created = await clio('/tasks.json?fields=id,name,due_at,status', { method: 'POST', body: JSON.stringify({ data }) });
      return J({ ok: true, id: created.id, summary: created.name, task: created }, 200, origin);
    }

    if (path.startsWith('/clio/task/') && request.method === 'PATCH') {
      const id = path.split('/').pop();
      const b = await body();
      const clio = makeClio(env, hooks);
      const created = await clio('/tasks/' + id + '.json?fields=id,name,status', {
        method: 'PATCH', body: JSON.stringify({ data: b.data || b })
      });
      return J({ ok: true, task: created }, 200, origin);
    }

    return J({ error: 'Unknown GWM route: ' + path }, 404, origin);

  } catch (e) {
    return J({ error: e.message || String(e), reauthorize: e.reauthorize || undefined }, e.status || 500, origin);
  }
}

/* Cron entry point. Wire it to your scheduled() export. */
export async function gwmScheduled(event, env, ctx, hooks) {
  try {
    const res = await gwmScan(env, hooks);
    console.log('[gwm] scan', JSON.stringify({ created: res.created, scanned: res.scanned, skipped: res.skipped, errors: res.errors.slice(0, 3) }));
  } catch (e) {
    console.log('[gwm] scan failed:', e.message);
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   INTEGRATION — three edits to your existing Worker

   1) at the top of your Worker entry file
        import { gwmRoute, gwmScheduled } from './gwm-calendar-automation.js';

   2) as the FIRST thing inside your fetch handler, before your own router
        const hooks = { clioFetch: myAuthenticatedClioFetch };   // optional
        const gwm = await gwmRoute(request, env, ctx, hooks);
        if (gwm) return gwm;

      `myAuthenticatedClioFetch(path, init)` is whatever your Worker already
      uses to call https://app.clio.com/api/v4 with a live bearer token; it
      must return the raw Response. Leave `hooks` undefined and this module
      finds the token in KV on its own.

   3) add a scheduled export next to your fetch export
        export default {
          fetch:     (request, env, ctx) => handleFetch(request, env, ctx),
          scheduled: (event, env, ctx)   => ctx.waitUntil(gwmScheduled(event, env, ctx, hooks))
        };

   wrangler.toml needs:
        [triggers]
        crons = ["*_/5 * * * *"]      <-- remove the underscore; it is only here so this comment block does not end early

        [[kv_namespaces]]
        binding = "GWM_KV"
        id      = "<your kv id>"          # the same namespace is fine

   secrets:
        npx wrangler secret put GOOGLE_CLIENT_ID
        npx wrangler secret put GOOGLE_CLIENT_SECRET
        # optional, only for the KV-fallback Clio path:
        npx wrangler secret put CLIO_CLIENT_ID
        npx wrangler secret put CLIO_CLIENT_SECRET

   vars:
        APP_URL              = "https://gmannion5149.github.io/GWMNotes/"
        GOOGLE_REDIRECT_URI  = "https://gwm-clio-api.gmannion.workers.dev/google/callback"
   ══════════════════════════════════════════════════════════════════════════════ */

/* Exposed for the test harness only — safe to leave in, nothing reads it at runtime. */
export const __internals = { fillPattern, skipReason, dueAtFor, taskDescription, eventTimes, eventUID, fmtDate, fmtTime, zoneOffset, matchMatter };
