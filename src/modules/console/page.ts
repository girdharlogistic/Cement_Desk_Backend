/**
 * The console's two screens, as strings.
 *
 * Hand-written HTML with inline CSS and no build step, because the alternative
 * is a bundler in a repo that has never needed one — to serve a login box and a
 * form with three fields. Everything the page needs is in the file it arrives
 * in, so there is nothing to cache-bust and nothing to keep in sync.
 */

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
    width: 100%; max-width: 560px; background: var(--card);
    border: 1px solid var(--line); border-radius: 14px; padding: 24px;
  }
  h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: -0.01em; }
  .sub { margin: 0 0 20px; color: var(--muted); font-size: 13px; }
  label { display: block; margin: 14px 0 6px; font-size: 13px; font-weight: 600; }
  input[type=text], input[type=email], input[type=password], textarea {
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

export const consolePage = (opts: { email: string; topic: string; images: boolean }): string =>
  SHELL(
    'Cement Desk — Console',
    `<div class="top">
  <div>
    <h1>Send a notification</h1>
    <p class="sub">Goes to every install subscribed to <strong>${escapeHtml(opts.topic)}</strong>.</p>
  </div>
  <button class="ghost" id="out" type="button">Sign out</button>
</div>

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
  Signed in as ${escapeHtml(opts.email)}. There is no undo — a delivered
  notification cannot be recalled. "Test without sending" runs the whole
  request through Firebase and drops it at the last step, which is the way to
  check an image actually loads.
</div>

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
</script>`,
  );

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
