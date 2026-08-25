/**
 * The console's two screens, as strings.
 *
 * Hand-written HTML with inline CSS and no build step, because the alternative
 * is a bundler in a repo that has never needed one — to serve a login box and a
 * form with three fields. Everything the page needs is in the file it arrives
 * in, so there is nothing to cache-bust and nothing to keep in sync.
 */

import { Sponsor } from '../sponsor/repo';

const SHELL = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>
  :root {
    --bg: #faf6f0; --card: #ffffff; --ink: #33211a; --muted: #8a7a70;
    --line: #e6dcd2; --accent: #c97b4e; --accent-ink: #ffffff;
    --danger: #b4432b; --ok: #2f7d54;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #211610; --card: #2c1e17; --ink: #f3e9e0; --muted: #a89488;
      --line: #402e24; --accent: #d98a5c; --accent-ink: #241009;
      --danger: #e8735a; --ok: #6cc494;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; justify-content: center;
  }
  .card {
    width: 100%; max-width: 760px; background: var(--card);
    border: 1px solid var(--line); border-radius: 14px; padding: 24px;
  }
  h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: -0.01em; }
  .sub { margin: 0 0 20px; color: var(--muted); font-size: 13px; }
  label { display: block; margin: 14px 0 6px; font-size: 13px; font-weight: 600; }
  input[type=text], input[type=email], input[type=password], input[type=number],
  select, textarea {
    width: 100%; padding: 10px 12px; border: 1px solid var(--line);
    border-radius: 9px; background: var(--bg); color: var(--ink);
    font: inherit; resize: vertical;
  }
  input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .count { float: right; font-weight: 400; color: var(--muted); }
  button {
    padding: 11px 18px; border: 0; border-radius: 9px; background: var(--accent);
    color: var(--accent-ink); font: inherit; font-weight: 650; cursor: pointer;
  }
  button.ghost { background: transparent; color: var(--ink); border: 1px solid var(--line); }
  button:disabled { opacity: .55; cursor: default; }
  .row { display: flex; gap: 10px; align-items: center; margin-top: 20px; flex-wrap: wrap; }
  .grow { flex: 1; }
  .msg { margin-top: 16px; padding: 11px 13px; border-radius: 9px; font-size: 14px; display: none; white-space: pre-wrap; }
  .msg.err { display: block; background: color-mix(in srgb, var(--danger) 13%, transparent); color: var(--danger); }
  .msg.ok  { display: block; background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
  .preview { margin-top: 12px; display: none; }
  .preview img { max-width: 100%; max-height: 220px; border-radius: 9px; border: 1px solid var(--line); display: block; }
  .hint { color: var(--muted); font-size: 12px; margin-top: 6px; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .warn { margin-top: 22px; padding: 11px 13px; border: 1px dashed var(--line); border-radius: 9px; color: var(--muted); font-size: 12.5px; }

  .tabs { display: flex; gap: 6px; margin: 18px 0 4px; border-bottom: 1px solid var(--line); }
  .tab {
    background: transparent; color: var(--muted); border: 0; border-bottom: 2px solid transparent;
    border-radius: 0; padding: 9px 12px; font-weight: 600; font-size: 14px;
  }
  .tab.on { color: var(--ink); border-bottom-color: var(--accent); }

  /* User data feed + analytics */
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 10px; margin-top: 6px; }
  .stat { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .stat .n { font-size: 21px; font-weight: 700; letter-spacing: -0.02em; }
  .stat .l { font-size: 11px; color: var(--muted); margin-top: 2px; text-transform: uppercase; letter-spacing: .04em; }

  .table-wrap { overflow-x: auto; margin-top: 12px; border: 1px solid var(--line); border-radius: 10px; }
  table.data { width: 100%; border-collapse: collapse; font-size: 13px; white-space: nowrap; }
  table.data th, table.data td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--line); }
  table.data th {
    color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase;
    letter-spacing: .04em; background: var(--card); position: sticky; top: 0;
  }
  table.data tbody tr:last-child td { border-bottom: 0; }
  table.data tr.clickable { cursor: pointer; }
  table.data tr.clickable:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .pill.ok { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
  .pill.bad { background: color-mix(in srgb, var(--danger) 13%, transparent); color: var(--danger); }

  .bars { display: flex; align-items: flex-end; gap: 3px; height: 90px; }
  .bars .bar { flex: 1; background: var(--accent); border-radius: 3px 3px 0 0; min-height: 2px; }
  .bars .bar.zero { background: var(--line); }

  .overlay {
    position: fixed; inset: 0; background: rgba(20, 12, 8, .5); display: flex;
    justify-content: center; align-items: flex-start; padding: 40px 16px; overflow-y: auto; z-index: 10;
  }
  .overlay[hidden] { display: none; }
  .sheet { width: 100%; max-width: 640px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 22px; }
  .sheet .close { float: right; }
  .sheet h2 { margin: 0 30px 2px 0; font-size: 18px; }

  .check { display: flex; gap: 9px; align-items: flex-start; margin: 18px 0 4px; }
  .check input { width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--accent); }
  .check label { margin: 0; font-weight: 600; }
  .two { display: flex; gap: 12px; flex-wrap: wrap; }
  .two > div { flex: 1 1 190px; }
  input[type=color] {
    width: 46px; height: 38px; padding: 2px; border: 1px solid var(--line);
    border-radius: 9px; background: var(--bg);
  }

  /* A stand-in for the strip as the phone draws it: the same band, on the same
     brown hero panel, with the same two lines. Not pixel-exact and not meant to
     be — it exists so nobody publishes a sponsor to every install without
     having looked at it once. */
  .sim {
    margin-top: 14px; border-radius: 16px; padding: 18px 16px;
    background: linear-gradient(135deg, #4a2e22, #8b5a3c);
  }
  .sim .strip {
    display: flex; align-items: center; gap: 12px;
    background: rgba(247, 239, 230, .10); border-radius: 12px;
    padding: 8px 12px 8px 8px;
  }
  .sim .mark {
    width: 44px; height: 44px; border-radius: 12px; flex: 0 0 auto;
    display: flex; align-items: center; justify-content: center; overflow: hidden;
  }
  .sim .mark img { width: 100%; height: 100%; object-fit: cover; }
  .sim .mark svg { width: 22px; height: 22px; }
  .sim .txt { flex: 1 1 auto; min-width: 0; }
  .sim .brand, .sim .second {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .sim .brand { color: #f7efe6; font-size: 15px; font-weight: 700; }
  .sim .second { color: #c4ac99; font-size: 12px; margin-top: 1px; }
  .sim .right { flex: 0 0 auto; text-align: right; }
  .sim .tag {
    color: #c4ac99; font-size: 9px; font-weight: 700;
    letter-spacing: .09em; text-transform: uppercase;
  }
  .sim .cta { color: #f7efe6; font-size: 11px; font-weight: 700; margin-top: 4px; }
  .sim .off {
    color: #c4ac99; font-size: 12.5px; font-style: italic; margin-top: 12px;
  }
</style>
</head>
<body>
<div class="card">
${body}
</div>
</body>
</html>`;

export const loginPage = (): string =>
  SHELL(
    'Cement Desk — Console',
    `<h1>Cement Desk console</h1>
<p class="sub">Sign in to send a notification.</p>
<form id="f" autocomplete="on">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <div class="row">
    <button id="go" type="submit">Sign in</button>
  </div>
</form>
<div id="msg" class="msg"></div>
<script>
const f = document.getElementById('f'), go = document.getElementById('go'), msg = document.getElementById('msg');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  go.disabled = true; msg.className = 'msg';
  try {
    const r = await fetch('/console/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || 'Sign-in failed');
    // replace(), not href: the login form has served its purpose, and leaving
    // it in history means Back lands on a page that will only bounce forward.
    location.replace('/console');
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = err.message;
    go.disabled = false;
  }
});
</script>`,
  );

export const consolePage = (opts: {
  email: string;
  topic: string;
  images: boolean;
  sponsor: Sponsor;
}): string =>
  SHELL(
    'Cement Desk — Console',
    `<div class="top">
  <div>
    <h1 id="head">Send a notification</h1>
    <p class="sub" id="subhead">Goes to every install subscribed to <strong>${escapeHtml(opts.topic)}</strong>.</p>
  </div>
  <button class="ghost" id="out" type="button">Sign out</button>
</div>

<div class="tabs" role="tablist">
  <button class="tab on" data-tab="send" role="tab" type="button">Notification</button>
  <button class="tab" data-tab="sponsor" role="tab" type="button">Sponsored card</button>
  <button class="tab" data-tab="plans" role="tab" type="button">Plans</button>
  <button class="tab" data-tab="users" role="tab" type="button">User data feed</button>
  <button class="tab" data-tab="analytics" role="tab" type="button">Users & analysis</button>
</div>

<div id="panel-send">
<form id="f">
  <label for="title">Title <span class="count" id="tc">0 / 100</span></label>
  <input id="title" type="text" maxlength="100" required>

  <label for="body">Message <span class="count" id="bc">0 / 500</span></label>
  <textarea id="body" rows="4" maxlength="500" required></textarea>

  ${
    opts.images
      ? `<label for="image">Image <span class="count">optional</span></label>
  <input id="image" type="file" accept="image/png,image/jpeg,image/webp">
  <div class="hint">PNG, JPEG or WebP, under 4 MB. Shown when the notification is expanded.</div>
  <div class="preview" id="pv"><img id="pvimg" alt=""></div>`
      : `<div class="hint" style="margin-top:14px">Image uploads are off — set CONSOLE_MEDIA_DIR and PUBLIC_BASE_URL to enable them.</div>`
  }

  <div class="row">
    <button id="send" type="submit">Send to everyone</button>
    <button id="test" class="ghost" type="button">Test without sending</button>
    <span class="grow"></span>
  </div>
</form>

<div id="msg" class="msg"></div>

<div class="warn">
  There is no undo — a delivered notification cannot be recalled. "Test without
  sending" runs the whole request through Firebase and drops it at the last
  step, which is the way to check an image actually loads.
</div>
</div>

<div id="panel-sponsor" hidden>
<form id="spf">
  <!-- The image already saved, if any. Carried in the form so a save that does
       not touch the file input keeps it, and "Remove image" can clear it. -->
  <input id="sp-image-url" type="hidden" value="${escapeHtml(opts.sponsor.imageUrl)}">
  <div class="check">
    <input id="sp-enabled" type="checkbox" ${opts.sponsor.enabled ? 'checked' : ''}>
    <label for="sp-enabled">Show this sponsor instead of Cement Desk's own</label>
  </div>
  <div class="hint">
    This is the strip across the top of the Home screen, on the brown panel.
    Off means every install keeps seeing the in-house Cement Desk one. The
    bottom banners are unaffected either way — those still come from AdMob.
  </div>

  <div class="two">
    <div>
      <label for="sp-label">Label</label>
      <input id="sp-label" type="text" maxlength="40" value="${escapeHtml(opts.sponsor.label)}">
      <div class="hint">The small line above the card.</div>
    </div>
    <div>
      <label for="sp-cta">Button text <span class="count">optional</span></label>
      <input id="sp-cta" type="text" maxlength="30" value="${escapeHtml(opts.sponsor.cta)}" placeholder="Know more">
      <div class="hint">Only shown if you set a link below.</div>
    </div>
  </div>

  <label for="sp-brand">Sponsor name <span class="count" id="sp-bc">0 / 60</span></label>
  <input id="sp-brand" type="text" maxlength="60" value="${escapeHtml(opts.sponsor.brand)}" placeholder="UltraTech Cement">

  <label for="sp-by">Second line <span class="count">optional</span></label>
  <input id="sp-by" type="text" maxlength="80" value="${escapeHtml(opts.sponsor.byLine)}" placeholder="Authorised stockist — Kota">

  <label for="sp-pitch">Pitch <span class="count" id="sp-pc">0 / 300</span></label>
  <textarea id="sp-pitch" rows="3" maxlength="300" placeholder="One short line.">${escapeHtml(opts.sponsor.pitch)}</textarea>
  <div class="hint">
    Tapping the strip always opens a full page with your image and this pitch
    in full. On the strip itself there is room for only one line under the
    name — the second line above wins it, and the pitch fills that line only
    when the second line is left empty.
  </div>

  <label for="sp-link">Link <span class="count">optional</span></label>
  <input id="sp-link" type="text" maxlength="500" value="${escapeHtml(opts.sponsor.linkUrl)}" placeholder="https://…">
  <div class="hint">Where the button on the full page sends people. No link means no button — the page still shows your image and pitch.</div>

  <label>Accent</label>
  <div class="row" style="margin-top:6px">
    <input id="sp-accent" type="color" data-on="${opts.sponsor.accent ? '1' : ''}" value="${escapeHtml(opts.sponsor.accent || '#8fa85c')}">
    <button class="ghost" id="sp-accent-off" type="button">Use app colour</button>
    <span class="hint" id="sp-accent-state"></span>
  </div>

  ${
    opts.images
      ? `<label for="sp-logo">Image <span class="count">optional</span></label>
  <input id="sp-logo" type="file" accept="image/png,image/jpeg,image/webp">
  <div class="hint">PNG, JPEG or WebP, under 4 MB. Drawn as a small square beside the name, so a square logo works best. Kept for as long as the sponsor runs.</div>
  <div class="row" style="margin-top:8px">
    <button class="ghost" id="sp-logo-clear" type="button">Remove image</button>
  </div>`
      : `<div class="hint" style="margin-top:14px">Image uploads are off — set CONSOLE_MEDIA_DIR and PUBLIC_BASE_URL to enable them.</div>`
  }

  <div class="row">
    <button id="sp-save" type="submit">Save</button>
    <span class="grow"></span>
  </div>
</form>

<div id="spmsg" class="msg"></div>

<div class="sim" id="sim">
  <div class="strip">
    <div class="mark" id="sim-mark"><img id="sim-img" alt="" hidden></div>
    <div class="txt">
      <div class="brand" id="sim-brand"></div>
      <div class="second" id="sim-second"></div>
    </div>
    <div class="right">
      <div class="tag" id="sim-label"></div>
      <div class="cta" id="sim-cta"></div>
    </div>
  </div>
  <div class="off" id="sim-off" hidden>Switched off — installs keep seeing the Cement Desk strip.</div>
</div>

<div class="warn">
  Saving takes effect without a release: the app re-reads this every time it is
  opened, and keeps the last copy so the card still draws with no connection.
  Expect up to five minutes before a change reaches every phone.
</div>
</div>

<div id="panel-users" hidden>
  <input id="u-search" type="text" placeholder="Search by email, name or phone…">
  <div class="table-wrap">
    <table class="data">
      <thead><tr>
        <th>Email</th><th>Name</th><th>Phone</th><th>Verified</th><th>Status</th>
        <th>Firms</th><th>Last active</th><th>Joined</th>
      </tr></thead>
      <tbody id="u-body"></tbody>
    </table>
  </div>
  <div class="row">
    <span class="hint" id="u-count"></span>
    <span class="grow"></span>
    <button class="ghost" id="u-more" type="button" hidden>Load more</button>
  </div>
  <div class="hint">Click a row for the full account: every firm it touches, per-firm counts, and its signed-in devices.</div>
</div>

<div id="panel-plans" hidden>
  <div class="table-wrap">
    <table class="data">
      <thead><tr><th>Plan</th><th>Play product</th><th>Unlocks</th><th>Status</th></tr></thead>
      <tbody id="pl-body"></tbody>
    </table>
  </div>
  <div class="row"><button id="pl-new" class="ghost" type="button">New plan</button></div>

  <form id="plf" hidden>
    <input id="pl-id" type="hidden">
    <div class="two">
      <div>
        <label for="pl-name">Plan name</label>
        <input id="pl-name" type="text" maxlength="60" placeholder="Pro">
      </div>
      <div>
        <label for="pl-period">Billing period</label>
        <select id="pl-period">
          <option value="month">Monthly</option>
          <option value="year">Yearly</option>
          <option value="lifetime">One-time</option>
        </select>
      </div>
    </div>

    <label for="pl-desc">Description <span class="count">optional</span></label>
    <textarea id="pl-desc" rows="2" maxlength="300" placeholder="Everything unlocked."></textarea>

    <label for="pl-sku">Play product id</label>
    <input id="pl-sku" type="text" maxlength="120" placeholder="pro_monthly">
    <div class="hint">
      <b>The price is not set here — it is set in Play Console.</b> Create the
      product there, paste its id in this box, and the app asks Play what it
      costs. That way the price on the paywall is always the one the user is
      actually charged, in their own currency, including any promotion Google
      is running for them. Leave this empty and the plan can still be granted
      by hand from the User data feed; it just cannot be bought.
    </div>

    <div class="hint" style="margin-top:22px"><b>What this plan unlocks</b></div>
    <div class="check">
      <input id="pl-adfree" type="checkbox">
      <label for="pl-adfree">No ads &mdash; every banner, the Home strip and the full-screen ad</label>
    </div>
    <div class="check">
      <input id="pl-export" type="checkbox">
      <label for="pl-export">Excel export</label>
    </div>
    <div class="two">
      <div>
        <label for="pl-firms">Firms</label>
        <input id="pl-firms" type="number" min="-1" max="500" step="1" value="1">
      </div>
      <div>
        <label for="pl-devices">Devices signed in at once</label>
        <input id="pl-devices" type="number" min="-1" max="500" step="1" value="1">
      </div>
    </div>
    <div class="hint">
      &minus;1 means unlimited. The free tier &mdash; anyone with no plan at all
      &mdash; gets 1 firm, 1 device, ads on and no export. Users who already had
      more than that before plans existed keep what they had, subscribed or not.
    </div>

    <div class="two">
      <div>
        <label for="pl-sort">Order on the paywall</label>
        <input id="pl-sort" type="number" min="0" max="999" step="1" value="0">
      </div>
      <div>
        <label>&nbsp;</label>
        <div class="check">
          <input id="pl-active" type="checkbox" checked>
          <label for="pl-active">Offer this plan</label>
        </div>
      </div>
    </div>
    <div class="hint">
      Switching a plan off retires it: it stops being offered, and keeps working
      for everyone already on it. That is what to do instead of deleting a price.
    </div>

    <div class="row">
      <button id="pl-save" type="submit">Save plan</button>
      <button id="pl-cancel" class="ghost" type="button">Cancel</button>
      <span class="grow"></span>
      <button id="pl-del" class="ghost" type="button">Delete</button>
    </div>
    <div class="msg" id="pl-msg"></div>
  </form>
</div>

<div id="panel-analytics" hidden>
  <div class="stat-grid" id="an-stats"></div>
  <div class="hint" style="margin-top:20px">Sign-ups, last 30 days</div>
  <div class="bars" id="an-bars"></div>
  <div class="hint" style="margin-top:20px">Busiest firms, by live freight entries</div>
  <div class="table-wrap">
    <table class="data">
      <thead><tr><th>Firm</th><th>Owner</th><th>Entries</th></tr></thead>
      <tbody id="an-firms-body"></tbody>
    </table>
  </div>
</div>

<div class="overlay" id="u-overlay" hidden>
  <div class="sheet">
    <button class="ghost close" id="u-close" type="button">Close</button>
    <div id="u-detail"></div>
  </div>
</div>

<div class="warn" style="border-style:solid">Signed in as ${escapeHtml(opts.email)}.</div>

<script>
const $ = (id) => document.getElementById(id);
const title = $('title'), body = $('body'), msg = $('msg');
const imageInput = $('image');

const count = (el, out, max) => {
  const f = () => { out.textContent = el.value.length + ' / ' + max; };
  el.addEventListener('input', f); f();
};
count(title, $('tc'), 100);
count(body, $('bc'), 500);

// Read the file here rather than posting multipart: the server takes a data
// URL, which keeps it to one JSON endpoint and no body-parser plugin.
let imageData = null;
if (imageInput) {
  imageInput.addEventListener('change', () => {
    const file = imageInput.files && imageInput.files[0];
    imageData = null;
    $('pv').style.display = 'none';
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      msg.className = 'msg err';
      msg.textContent = 'That image is ' + (file.size / 1048576).toFixed(1) + ' MB — keep it under 4 MB.';
      imageInput.value = '';
      return;
    }
    const fr = new FileReader();
    fr.onload = () => {
      imageData = fr.result;
      $('pvimg').src = imageData;
      $('pv').style.display = 'block';
    };
    fr.readAsDataURL(file);
  });
}

async function submit(validateOnly) {
  const buttons = [$('send'), $('test')];
  buttons.forEach((b) => (b.disabled = true));
  msg.className = 'msg';
  try {
    if (!title.value.trim() || !body.value.trim()) throw new Error('Title and message are both needed.');
    if (!validateOnly && !confirm('Send this to every user? It cannot be recalled.')) {
      throw new Error('Not sent.');
    }
    const r = await fetch('/console/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: title.value.trim(),
        body: body.value.trim(),
        image: imageData || undefined,
        validateOnly,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { location.href = '/console'; return; }
    if (!r.ok) throw new Error((j.error && j.error.message) || 'Send failed');
    msg.className = 'msg ok';
    msg.textContent = validateOnly
      ? 'Checked by Firebase and not delivered.' + (j.imageUrl ? '\\nImage: ' + j.imageUrl : '')
      : 'Sent to everyone.' + (j.imageUrl ? '\\nImage: ' + j.imageUrl : '');
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

$('f').addEventListener('submit', (e) => { e.preventDefault(); submit(false); });
$('test').addEventListener('click', () => submit(true));
$('out').addEventListener('click', async () => {
  await fetch('/console/logout', { method: 'POST' });
  location.href = '/console';
});
${TABS_JS}
${SPONSOR_JS}
${USERS_JS}
${ANALYTICS_JS}
</script>`,
  );

/**
 * Tab plumbing, shared by every panel the page has.
 */
const TABS_JS = `
const HEADS = {
  send: ['Send a notification', null],
  sponsor: ['Sponsored card', 'The card at the top of Home, on every install.'],
  plans: ['Plans', 'How many plans there are and what each one unlocks. Prices live in Play Console.'],
  users: ['User data feed', 'Browse every account, search it, and open one for the full picture.'],
  analytics: ['Users & analysis', 'Platform-wide numbers: growth, activity, and the busiest books.'],
};

// A panel that only needs its data the first time it is opened registers here
// instead of loading on page load — the notification tab is what most visits
// are for, and a users table nobody looked at yet should not cost a query.
const TAB_INIT = {};

// Captured rather than interpolated a second time: the topic name is already in
// the markup, and a copy in here would drift from it.
const sendSubhead = $('subhead').innerHTML;

function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('on', t.dataset.tab === name);
  }
  for (const key of Object.keys(HEADS)) {
    const panel = $('panel-' + key);
    if (panel) panel.hidden = key !== name;
  }
  const head = HEADS[name];
  $('head').textContent = head[0];
  // null means "the notification subhead", which is markup rather than text
  // because it names the topic in bold.
  if (head[1] === null) $('subhead').innerHTML = sendSubhead;
  else $('subhead').textContent = head[1];
  if (TAB_INIT[name]) TAB_INIT[name]();
}
for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => showTab(t.dataset.tab));
}

// textContent everywhere below, never innerHTML: text on this page comes from
// rows the users of this product typed in, and from a model reading them. A
// dealer who names a firm with a script tag should not get to run it here.
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
`;

/**
 * The sponsored card.
 *
 * The whole point of the panel is the preview underneath it: this card goes to
 * every install at once, with no release and no review, so the operator should
 * have read the thing they are publishing before they publish it.
 */
const SPONSOR_JS = `
const sp = {
  enabled: $('sp-enabled'), label: $('sp-label'), brand: $('sp-brand'),
  by: $('sp-by'), pitch: $('sp-pitch'), cta: $('sp-cta'), link: $('sp-link'),
  accent: $('sp-accent'), imageUrl: $('sp-image-url'),
};
const spmsg = $('spmsg'), spLogo = $('sp-logo');

// A colour input always has a value, so "no accent set" needs a flag of its
// own. Seeded from the markup rather than from a second interpolation.
let accentOn = sp.accent.dataset.on === '1';

// Set when a new file is picked; null means "leave whatever is saved alone".
let logoData = null;

count(sp.brand, $('sp-bc'), 60);
count(sp.pitch, $('sp-pc'), 300);

/** Mirrors the app: text colour read off the fill, not off a fixed palette. */
function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#2a1f18' : '#ffffff';
}

function draw() {
  const accent = accentOn ? sp.accent.value : '#8fa85c';
  $('sp-accent-state').textContent = accentOn ? '' : 'using the app colour';
  $('sim-label').textContent = sp.label.value.trim() || 'Sponsored';
  $('sim-brand').textContent = sp.brand.value.trim() || 'Sponsor name';

  // Mirrors the app exactly: one line under the name — the second line if
  // there is one, otherwise the pitch.
  $('sim-second').textContent = sp.by.value.trim() || sp.pitch.value.trim();

  // The strip is always tappable for an enabled sponsor — it opens a full
  // page with the image and pitch. The arrow says so; the button text next to
  // it is optional and only means something once a link is set too.
  $('sim-cta').textContent = sp.cta.value.trim()
    ? sp.cta.value.trim() + ' \\u2192'
    : '\\u2192';

  const mark = $('sim-mark');
  const img = $('sim-img');
  const src = logoData || sp.imageUrl.value;
  img.hidden = !src;
  if (src) img.src = src;
  // The badge shows through only when there is no logo, so it wears the accent.
  mark.style.background = src ? 'transparent' : accent;
  mark.style.color = inkOn(accent);

  $('sim-off').hidden = sp.enabled.checked;
}

for (const f of [sp.enabled, sp.label, sp.brand, sp.by, sp.pitch, sp.cta, sp.link]) {
  f.addEventListener('input', draw);
  f.addEventListener('change', draw);
}
sp.accent.addEventListener('input', () => { accentOn = true; draw(); });
$('sp-accent-off').addEventListener('click', () => { accentOn = false; draw(); });

if (spLogo) {
  spLogo.addEventListener('change', () => {
    const file = spLogo.files && spLogo.files[0];
    logoData = null;
    if (!file) { draw(); return; }
    if (file.size > 4 * 1024 * 1024) {
      spmsg.className = 'msg err';
      spmsg.textContent = 'That image is ' + (file.size / 1048576).toFixed(1) + ' MB — keep it under 4 MB.';
      spLogo.value = '';
      draw();
      return;
    }
    const fr = new FileReader();
    fr.onload = () => { logoData = fr.result; draw(); };
    fr.readAsDataURL(file);
  });
  $('sp-logo-clear').addEventListener('click', () => {
    logoData = null;
    spLogo.value = '';
    sp.imageUrl.value = '';
    draw();
  });
}

draw();

$('spf').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('sp-save');
  btn.disabled = true;
  spmsg.className = 'msg';
  try {
    const r = await fetch('/console/sponsor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: sp.enabled.checked,
        label: sp.label.value,
        brand: sp.brand.value,
        byLine: sp.by.value,
        pitch: sp.pitch.value,
        cta: sp.cta.value,
        linkUrl: sp.link.value,
        accent: accentOn ? sp.accent.value : '',
        image: logoData || undefined,
        imageUrl: sp.imageUrl.value,
      }),
    });
    if (r.status === 401) { location.href = '/console'; return; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || 'Save failed');
    // The server may have replaced the image, so take its answer as the truth
    // and forget the local file — a second save must not re-upload it.
    sp.imageUrl.value = j.imageUrl || '';
    logoData = null;
    if (spLogo) spLogo.value = '';
    draw();
    spmsg.className = 'msg ok';
    spmsg.textContent = sp.enabled.checked
      ? 'Saved. Every install will show this card within five minutes.'
      : 'Saved, and switched off — installs keep seeing the Cement Desk card.';
  } catch (err) {
    spmsg.className = 'msg err';
    spmsg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
`;

/**
 * The user data feed.
 *
 * A search box over `GET /console/users`, and a click-through to
 * `GET /console/users/:id` for the full picture — every firm the account
 * touches, counted per firm, plus its signed-in devices. Loads lazily, on the
 * tab's first visit (`TAB_INIT.users`, set at the bottom), so a console
 * session spent only sending notifications never pays for a users query.
 */
const USERS_JS = `
const uSearch = $('u-search'), uBody = $('u-body'), uMore = $('u-more'), uCount = $('u-count');
const uOverlay = $('u-overlay'), uDetail = $('u-detail'), uClose = $('u-close');
let uOffset = 0, uTotal = 0, uQuery = '', uSearchTimer = null, usersLoaded = false;

function fmtDate(iso) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}
function pill(ok, yes, no) { return el('span', 'pill ' + (ok ? 'ok' : 'bad'), ok ? yes : no); }

// ── Plans ───────────────────────────────────────────────────────────────────
// The console owns the product, not the price. Everything here edits what a
// plan *unlocks*; what it costs comes from Play against the product id.

let plans = [];

function unlocks(f) {
  const bits = [];
  if (f.adFree) bits.push('no ads');
  if (f.excelExport) bits.push('export');
  bits.push('firms: ' + (f.maxFirms === -1 ? 'unlimited' : f.maxFirms));
  bits.push('devices: ' + (f.maxDevices === -1 ? 'unlimited' : f.maxDevices));
  return bits.join(' · ');
}

function drawPlans() {
  const body = $('pl-body');
  body.textContent = '';
  if (!plans.length) {
    const tr = el('tr');
    const td = el('td', 'sub', 'No plans yet — every account is on the free tier.');
    td.colSpan = 4;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (const p of plans) {
    const tr = el('tr');
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => fillPlan(p));
    const first = el('td');
    first.appendChild(el('div', null, p.name));
    if (p.description) first.appendChild(el('div', 'sub', p.description));
    tr.appendChild(first);
    tr.appendChild(el('td', p.sku ? null : 'sub', p.sku || 'not linked'));
    tr.appendChild(el('td', 'sub', unlocks(p.features)));
    const st = el('td');
    st.appendChild(pill(p.active, 'Offered', 'Hidden'));
    tr.appendChild(st);
    body.appendChild(tr);
  }
}

async function loadPlans() {
  const r = await fetch('/console/plans', { credentials: 'same-origin' });
  if (!r.ok) return;
  const j = await r.json();
  plans = j.plans || [];
  drawPlans();
}
TAB_INIT.plans = loadPlans;

function planMsg(text, ok) {
  const m = $('pl-msg');
  m.textContent = text;
  m.className = 'msg ' + (ok ? 'ok' : 'err');
}

/** null opens a blank form for a new plan. */
function fillPlan(p) {
  $('pl-id').value = p ? p.id : '';
  $('pl-name').value = p ? p.name : '';
  $('pl-desc').value = p ? p.description : '';
  $('pl-sku').value = p ? p.sku : '';
  $('pl-period').value = p ? p.period : 'month';
  $('pl-sort').value = p ? p.sortOrder : plans.length;
  $('pl-active').checked = p ? p.active : true;
  const f = p ? p.features : { adFree: true, excelExport: true, maxFirms: -1, maxDevices: -1 };
  $('pl-adfree').checked = f.adFree;
  $('pl-export').checked = f.excelExport;
  $('pl-firms').value = f.maxFirms;
  $('pl-devices').value = f.maxDevices;
  $('pl-del').hidden = !p;
  $('pl-msg').className = 'msg';
  $('plf').hidden = false;
  $('pl-name').focus();
}

$('pl-new').addEventListener('click', () => fillPlan(null));
$('pl-cancel').addEventListener('click', () => { $('plf').hidden = true; });

$('plf').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const id = $('pl-id').value;
  const payload = {
    name: $('pl-name').value.trim(),
    description: $('pl-desc').value.trim(),
    sku: $('pl-sku').value.trim(),
    period: $('pl-period').value,
    sortOrder: Number($('pl-sort').value || 0),
    active: $('pl-active').checked,
    features: {
      adFree: $('pl-adfree').checked,
      excelExport: $('pl-export').checked,
      maxFirms: Number($('pl-firms').value),
      maxDevices: Number($('pl-devices').value),
    },
  };
  $('pl-save').disabled = true;
  try {
    const r = await fetch(id ? '/console/plans/' + id : '/console/plans', {
      method: id ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      planMsg((j.error && j.error.message) || 'Could not save that.', false);
      return;
    }
    await loadPlans();
    planMsg('Saved.', true);
    $('pl-id').value = j.plan ? j.plan.id : id;
    $('pl-del').hidden = false;
  } catch (e) {
    planMsg('Could not reach the server.', false);
  } finally {
    $('pl-save').disabled = false;
  }
});

$('pl-del').addEventListener('click', async () => {
  const id = $('pl-id').value;
  if (!id) return;
  if (!confirm('Delete this plan? Only possible while nobody is on it.')) return;
  const r = await fetch('/console/plans/' + id, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    planMsg((j.error && j.error.message) || 'Could not delete that.', false);
    return;
  }
  await loadPlans();
  $('plf').hidden = true;
});

async function loadUsers(reset) {
  if (reset) { uOffset = 0; uBody.textContent = ''; }
  const params = new URLSearchParams({ offset: String(uOffset) });
  if (uQuery) params.set('q', uQuery);
  const r = await fetch('/console/users?' + params.toString());
  if (r.status === 401) { location.href = '/console'; return; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return;
  uTotal = j.total;
  for (const u of j.rows) {
    const tr = el('tr', 'clickable');
    tr.appendChild(el('td', null, u.email));
    tr.appendChild(el('td', null, u.displayName || '—'));
    tr.appendChild(el('td', null, u.phone || '—'));
    const tdV = el('td'); tdV.appendChild(pill(u.emailVerified, 'Verified', 'Unverified')); tr.appendChild(tdV);
    tr.appendChild(el('td', null, u.status));
    tr.appendChild(el('td', null, u.firmsOwned + ' owned · ' + u.firmsMember + ' member'));
    tr.appendChild(el('td', null, fmtDate(u.lastActiveAt)));
    tr.appendChild(el('td', null, fmtDate(u.createdAt)));
    tr.addEventListener('click', () => openUser(u.id));
    uBody.appendChild(tr);
  }
  uOffset += j.rows.length;
  uCount.textContent = uOffset + ' of ' + uTotal;
  uMore.hidden = uOffset >= uTotal;
}

uSearch.addEventListener('input', () => {
  uQuery = uSearch.value.trim();
  clearTimeout(uSearchTimer);
  uSearchTimer = setTimeout(() => loadUsers(true), 300);
});
uMore.addEventListener('click', () => loadUsers(false));

function statTile(label, value) {
  const s = el('div', 'stat');
  s.appendChild(el('div', 'n', String(value)));
  s.appendChild(el('div', 'l', label));
  return s;
}

function renderUser(u) {
  uDetail.textContent = '';
  uDetail.appendChild(el('h2', null, u.displayName || u.email));
  uDetail.appendChild(el('p', 'sub', u.email + (u.phone ? ' · ' + u.phone : '')));

  const badges = el('div', 'row');
  badges.style.marginTop = '0';
  badges.appendChild(pill(u.emailVerified, 'Verified', 'Unverified'));
  badges.appendChild(pill(u.status === 'active', 'Active account', u.status));
  uDetail.appendChild(badges);
  uDetail.appendChild(el('div', 'hint', 'Joined ' + fmtDate(u.createdAt) + ' · across ' + u.totals.firms + ' firm(s)'));

  // ── Plan ──────────────────────────────────────────────────────────────────
  // Granting from here is how anybody gets a paid plan without paying: the
  // operator's own account, a giveaway, an apology. No Play limits apply
  // because nothing is being sold — and before Billing is wired at all, this
  // is the only way any of it can be tested.
  const ent = u.entitlement;
  const planWrap = el('div');
  planWrap.style.marginTop = '22px';
  planWrap.appendChild(el('div', 'hint', 'Plan'));

  const now = el('div', 'row');
  now.style.marginTop = '6px';
  now.appendChild(pill(Boolean(ent.planId), ent.planName, 'Free'));
  if (ent.planId) {
    now.appendChild(el('span', 'sub',
      ent.source + ' · ' + ent.status +
      (ent.expiresAt ? ' · until ' + fmtDate(ent.expiresAt) : ' · no expiry')));
  }
  planWrap.appendChild(now);
  planWrap.appendChild(el('div', 'sub', 'Gets: ' + unlocks(ent.features)));
  if (ent.grandfatheredFirms || ent.grandfatheredDevices) {
    planWrap.appendChild(el('div', 'sub',
      'Grandfathered: ' +
      (ent.grandfatheredFirms ? ent.grandfatheredFirms + ' firms ' : '') +
      (ent.grandfatheredDevices ? ent.grandfatheredDevices + ' devices' : '') +
      ' — kept whether or not they subscribe.'));
  }
  if (ent.note) planWrap.appendChild(el('div', 'sub', ent.note));

  const controls = el('div', 'row');
  const sel = document.createElement('select');
  for (const p of plans) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name + (p.active ? '' : ' (hidden)');
    sel.appendChild(o);
  }
  const days = document.createElement('input');
  days.type = 'number'; days.min = '1'; days.max = '3650'; days.placeholder = 'days';
  days.style.maxWidth = '110px';
  days.title = 'Leave empty for no expiry';
  const note = document.createElement('input');
  note.type = 'text'; note.maxLength = 200; note.placeholder = 'note (optional)';
  const give = el('button', null, 'Grant');
  give.type = 'button';
  const take = el('button', 'ghost', 'Revoke');
  take.type = 'button';
  take.hidden = !ent.planId;

  if (!plans.length) {
    planWrap.appendChild(el('div', 'sub', 'Make a plan on the Plans tab first.'));
  } else {
    controls.appendChild(sel);
    controls.appendChild(days);
    controls.appendChild(note);
    controls.appendChild(give);
    controls.appendChild(take);
    planWrap.appendChild(controls);
  }
  const pmsg = el('div', 'msg');
  planWrap.appendChild(pmsg);

  async function entitle(method, body) {
    give.disabled = true; take.disabled = true;
    try {
      const r = await fetch('/console/users/' + u.id + '/entitlement', {
        method: method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        credentials: 'same-origin',
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        pmsg.textContent = (j.error && j.error.message) || 'That did not work.';
        pmsg.className = 'msg err';
        return;
      }
      openUser(u.id);
    } finally {
      give.disabled = false; take.disabled = false;
    }
  }

  give.addEventListener('click', () => {
    const d = Number(days.value);
    entitle('POST', {
      planId: sel.value,
      days: d > 0 ? d : undefined,
      note: note.value.trim(),
    });
  });
  take.addEventListener('click', () => {
    if (!confirm('Drop this account back to the free tier?')) return;
    entitle('DELETE', null);
  });

  uDetail.appendChild(planWrap);

  const stats = el('div', 'stat-grid');
  stats.style.marginTop = '14px';
  for (const [l, n] of [
    ['Freight entries', u.totals.entries], ['Stock days', u.totals.stockDays],
    ['Purchases', u.totals.purchases], ['Schemes', u.totals.schemes], ['Claims', u.totals.claims],
  ]) stats.appendChild(statTile(l, n));
  uDetail.appendChild(stats);

  if (u.firms.length) {
    uDetail.appendChild(el('div', 'hint', 'Firms'));
    Object.assign(uDetail.lastChild.style, { marginTop: '20px' });
    const wrap = el('div', 'table-wrap');
    const table = document.createElement('table'); table.className = 'data';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const h of ['Firm', 'Role', 'Entries', 'Stock days', 'Purchases', 'Schemes', 'Claims']) hr.appendChild(el('th', null, h));
    thead.appendChild(hr); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const f of u.firms) {
      const tr = el('tr');
      tr.appendChild(el('td', null, f.name + (f.owned ? ' (owner)' : '')));
      tr.appendChild(el('td', null, f.role));
      tr.appendChild(el('td', null, String(f.entries)));
      tr.appendChild(el('td', null, String(f.stockDays)));
      tr.appendChild(el('td', null, String(f.purchases)));
      tr.appendChild(el('td', null, String(f.schemes)));
      tr.appendChild(el('td', null, String(f.claims)));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody); wrap.appendChild(table);
    uDetail.appendChild(wrap);
  }

  if (u.sessions.length) {
    const label = el('div', 'hint', 'Signed-in devices, most recent first');
    label.style.marginTop = '20px';
    uDetail.appendChild(label);
    const wrap = el('div', 'table-wrap');
    const table = document.createElement('table'); table.className = 'data';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const h of ['Device', 'Last used', 'Expires', 'State']) hr.appendChild(el('th', null, h));
    thead.appendChild(hr); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const s of u.sessions) {
      const tr = el('tr');
      tr.appendChild(el('td', null, s.deviceLabel || '—'));
      tr.appendChild(el('td', null, fmtDate(s.lastUsedAt)));
      tr.appendChild(el('td', null, fmtDate(s.expiresAt)));
      const tdS = el('td'); tdS.appendChild(pill(!s.revoked, 'Live', 'Revoked')); tr.appendChild(tdS);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody); wrap.appendChild(table);
    uDetail.appendChild(wrap);
  }
}

async function openUser(id) {
  uDetail.textContent = '';
  uDetail.appendChild(el('p', 'hint', 'Loading…'));
  uOverlay.hidden = false;
  // The grant control needs the plan list, and an operator can reach a user
  // without ever opening the Plans tab that would have loaded it.
  if (!plans.length) await loadPlans();
  const r = await fetch('/console/users/' + id);
  if (r.status === 401) { location.href = '/console'; return; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    uDetail.textContent = '';
    uDetail.appendChild(el('p', 'hint', (j.error && j.error.message) || 'Could not load that account.'));
    return;
  }
  renderUser(j.user);
}
uClose.addEventListener('click', () => { uOverlay.hidden = true; });
uOverlay.addEventListener('click', (e) => { if (e.target === uOverlay) uOverlay.hidden = true; });

TAB_INIT.users = function () {
  if (usersLoaded) return;
  usersLoaded = true;
  loadUsers(true);
};
`;

/**
 * Users & analysis.
 *
 * Platform totals, a 30-day sign-up bar row built from plain divs (the page's
 * CSP allows no script or style source but itself, so no charting library),
 * and the busiest firms by live freight entries. Also lazy — see `USERS_JS`.
 */
const ANALYTICS_JS = `
let analyticsLoaded = false;

async function loadAnalytics() {
  const grid = $('an-stats'); grid.textContent = '';
  const r = await fetch('/console/analytics');
  if (r.status === 401) { location.href = '/console'; return; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return;

  for (const [l, n] of [
    ['Total users', j.totalUsers], ['Verified', j.verifiedUsers],
    ['Active, 7d', j.activeUsers7d], ['Active, 30d', j.activeUsers30d],
    ['Firms', j.totalFirms], ['Freight entries', j.totalEntries],
    ['Stock days', j.totalStockDays], ['Purchases', j.totalPurchases],
    ['Schemes', j.totalSchemes], ['Claims', j.totalClaims],
  ]) grid.appendChild(statTile(l, n));

  const bars = $('an-bars'); bars.textContent = '';
  const max = Math.max(1, ...j.signupsByDay.map((d) => d.n));
  for (const d of j.signupsByDay) {
    const bar = el('div', 'bar' + (d.n === 0 ? ' zero' : ''));
    bar.style.height = Math.max(2, Math.round((d.n / max) * 100)) + '%';
    bar.title = d.date + ': ' + d.n + (d.n === 1 ? ' sign-up' : ' sign-ups');
    bars.appendChild(bar);
  }

  const body = $('an-firms-body'); body.textContent = '';
  for (const f of j.topFirms) {
    const tr = el('tr');
    tr.appendChild(el('td', null, f.name));
    tr.appendChild(el('td', null, f.ownerEmail));
    tr.appendChild(el('td', null, String(f.entries)));
    body.appendChild(tr);
  }
}

TAB_INIT.analytics = function () {
  if (analyticsLoaded) return;
  analyticsLoaded = true;
  loadAnalytics();
};
`;

/**
 * The email and topic are interpolated into the page. Both come from our own
 * config rather than a request, so this is belt-and-braces — but a page that
 * can notify every user is the wrong place to reason about which strings are
 * trusted today.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
