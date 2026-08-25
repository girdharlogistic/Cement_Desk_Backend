/**
 * The public account-deletion page, at `/delete-account`.
 *
 * Public and unauthenticated by design: Google requires an app that creates
 * accounts to publish a deletion route that a person can reach from a browser,
 * without the app installed and without already being signed in. It is linked
 * from the Play listing, so it is the one page here a stranger may land on.
 *
 * Its own stylesheet rather than the console's. They look like the same
 * product, but this page is for a customer on a phone who is upset enough to be
 * leaving, and the console is a tool for one operator — sharing a stylesheet
 * would mean every change for one had to be checked against the other.
 *
 * DEMONSTRATION ONLY at present. The credential check and the summary are real;
 * the final step deletes nothing and says so plainly, in the page and in the
 * response. Nothing here should imply otherwise to someone who believes it.
 */

const SHELL = (body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Delete your Cement Desk account</title>
<style>
  :root {
    --bg: #faf6f0; --card: #ffffff; --ink: #33211a; --muted: #8a7a70;
    --line: #e6dcd2; --accent: #c97b4e; --accent-ink: #ffffff;
    --danger: #b4432b; --danger-ink: #ffffff; --ok: #2f7d54;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #211610; --card: #2c1e17; --ink: #f3e9e0; --muted: #a89488;
      --line: #402e24; --accent: #d98a5c; --accent-ink: #241009;
      --danger: #e8735a; --danger-ink: #241009; --ok: #6cc494;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--ink);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; justify-content: center;
  }
  .card {
    width: 100%; max-width: 540px; background: var(--card);
    border: 1px solid var(--line); border-radius: 14px; padding: 24px;
  }
  h1 { margin: 0 0 6px; font-size: 21px; letter-spacing: -0.01em; }
  h2 { margin: 22px 0 8px; font-size: 15px; }
  .sub { margin: 0 0 18px; color: var(--muted); font-size: 13.5px; }
  label { display: block; margin: 14px 0 6px; font-size: 13px; font-weight: 600; }
  input[type=text], input[type=email], input[type=password] {
    width: 100%; padding: 11px 12px; border: 1px solid var(--line);
    border-radius: 9px; background: var(--bg); color: var(--ink); font: inherit;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button {
    padding: 12px 18px; border: 0; border-radius: 9px; background: var(--accent);
    color: var(--accent-ink); font: inherit; font-weight: 650; cursor: pointer;
  }
  button.danger { background: var(--danger); color: var(--danger-ink); }
  button.ghost { background: transparent; color: var(--ink); border: 1px solid var(--line); }
  button:disabled { opacity: .5; cursor: default; }
  .row { display: flex; gap: 10px; align-items: center; margin-top: 22px; flex-wrap: wrap; }
  .msg { margin-top: 16px; padding: 11px 13px; border-radius: 9px; font-size: 14px; display: none; white-space: pre-wrap; }
  .msg.err { display: block; background: color-mix(in srgb, var(--danger) 13%, transparent); color: var(--danger); }
  .msg.ok  { display: block; background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
  .hint { color: var(--muted); font-size: 12.5px; margin-top: 6px; }
  .who { padding: 11px 13px; border-radius: 9px; background: var(--bg); border: 1px solid var(--line); font-size: 14px; }
  ul.what { margin: 8px 0 0; padding-left: 20px; }
  ul.what li { margin: 3px 0; }
  ul.what b { font-variant-numeric: tabular-nums; }
  .stop {
    margin-top: 18px; padding: 13px 15px; border-radius: 9px;
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  }
  .stop p { margin: 0 0 8px; }
  .stop p:last-child { margin-bottom: 0; }
  .check { display: flex; gap: 9px; align-items: flex-start; margin-top: 16px; }
  .check input { width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--danger); }
  .check label { margin: 0; font-weight: 500; font-size: 13.5px; }
  .demo {
    margin-top: 20px; padding: 11px 13px; border: 1px dashed var(--line);
    border-radius: 9px; color: var(--muted); font-size: 12.5px;
  }
  .foot { margin-top: 26px; padding-top: 16px; border-top: 1px solid var(--line);
          color: var(--muted); font-size: 12.5px; }
</style>
</head>
<body>
<div class="card">
${body}
</div>
</body>
</html>`;

export const deleteAccountPage = (): string =>
  SHELL(`<div id="step-1">
  <h1>Delete your Cement Desk account</h1>
  <p class="sub">
    Sign in to see exactly what would be removed. Nothing is deleted at this
    step — you will get a full summary and a second confirmation first.
  </p>

  <form id="f1">
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="username" required>
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password" required>
    <div class="row">
      <button id="go" type="submit">Continue</button>
    </div>
  </form>
  <div id="m1" class="msg"></div>

  <div class="foot">
    Forgotten your password? Reset it from the app first — we cannot delete an
    account without confirming it belongs to you.
  </div>
</div>

<div id="step-2" hidden>
  <h1>Is this definitely what you want?</h1>
  <p class="sub">Read this properly. It is not reversible.</p>

  <div class="who">Signed in as <b id="who"></b></div>

  <h2>What gets deleted</h2>
  <ul class="what" id="what"></ul>

  <div id="shared-warn" class="stop" hidden>
    <p><b>Other people use your firms.</b></p>
    <p id="shared-text"></p>
  </div>

  <div class="stop">
    <p><b>There is no undo, and no backup we can restore from.</b></p>
    <p>
      Once this runs, your books are gone from our servers for good. If you want
      to keep your records, open the app first and export your freight, stock and
      purchase data to Excel — it takes a minute and you cannot come back for it
      afterwards.
    </p>
  </div>

  <h2>Instead of deleting</h2>
  <p class="sub" style="margin-bottom:0">
    If you have stopped using Cement Desk, you can simply sign out on every
    device from <b>More → Cloud</b> in the app. Your data stays where it is, and
    nothing is sent anywhere. Deleting is only for when you want it gone.
  </p>

  <form id="f2">
    <label for="confirm">Type your email address to confirm</label>
    <input id="confirm" type="text" autocomplete="off" autocapitalize="none"
           spellcheck="false" placeholder="you@example.com">
    <div class="hint">This is deliberately awkward. It should be.</div>

    <div class="check">
      <input id="understand" type="checkbox">
      <label for="understand">
        I understand that my account and every book in it will be permanently
        deleted, and that nobody at Cement Desk can bring them back.
      </label>
    </div>

    <div class="row">
      <button id="kill" class="danger" type="submit" disabled>Delete my account permanently</button>
      <button id="back" class="ghost" type="button">Cancel</button>
    </div>
  </form>
  <div id="m2" class="msg"></div>

  <div class="demo" id="demo-note">
    <b>Demonstration.</b> This page is not connected to the deletion routine
    yet. The button below checks everything and then stops — your account will
    not be touched.
  </div>
</div>

<div id="step-3" hidden>
  <h1 id="done-head">Nothing was deleted</h1>
  <p class="sub" id="done-text"></p>
  <div class="row">
    <button class="ghost" id="restart" type="button">Back to the start</button>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const step = (n) => {
  for (const i of [1, 2, 3]) $('step-' + i).hidden = i !== n;
  window.scrollTo(0, 0);
};

// Held between the two steps. Short-lived and issued by the server against the
// password just checked, so step two cannot be reached by opening it directly.
let token = null;
let verifiedEmail = '';

function say(el, kind, text) {
  el.className = 'msg' + (kind ? ' ' + kind : '');
  el.textContent = text || '';
}

// textContent everywhere: the firm names below are typed by users.
function li(label, n) {
  const item = document.createElement('li');
  const b = document.createElement('b');
  b.textContent = String(n);
  item.appendChild(b);
  item.appendChild(document.createTextNode(' ' + label));
  return item;
}

$('f1').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('go').disabled = true;
  say($('m1'), '', '');
  try {
    const r = await fetch('/delete-account/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: $('email').value,
        password: $('password').value,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || 'That did not work.');

    token = j.token;
    verifiedEmail = j.email;
    $('who').textContent = j.email;
    $('confirm').placeholder = j.email;

    const what = $('what');
    what.textContent = '';
    const s = j.summary;
    what.appendChild(li(s.firms === 1 ? 'firm you own' : 'firms you own', s.firms));
    what.appendChild(li('parties and depot locations', s.parties + s.locations));
    what.appendChild(li(s.entries === 1 ? 'freight entry' : 'freight entries', s.entries));
    what.appendChild(li(s.stockDays === 1 ? 'stock sheet' : 'stock sheets', s.stockDays));
    what.appendChild(li(s.purchases === 1 ? 'purchase' : 'purchases', s.purchases));
    what.appendChild(li(s.schemes === 1 ? 'scheme' : 'schemes', s.schemes));
    what.appendChild(li(s.claims === 1 ? 'claim' : 'claims', s.claims));
    what.appendChild(li(s.sessions === 1 ? 'signed-in device' : 'signed-in devices', s.sessions));

    if (s.sharedWith > 0) {
      $('shared-warn').hidden = false;
      $('shared-text').textContent =
        s.sharedWith + (s.sharedWith === 1 ? ' other person has' : ' other people have') +
        ' access to firms you own. Deleting your account takes those firms away from them too,' +
        ' and they will not be warned. Consider handing the firm over before you do this.';
    } else {
      $('shared-warn').hidden = true;
    }

    step(2);
  } catch (err) {
    say($('m1'), 'err', err.message);
  } finally {
    $('go').disabled = false;
  }
});

// The button stays dead until both the typed address and the tick agree.
function gate() {
  const typed = $('confirm').value.trim().toLowerCase();
  $('kill').disabled = !($('understand').checked && typed === verifiedEmail.toLowerCase());
}
$('confirm').addEventListener('input', gate);
$('understand').addEventListener('change', gate);

$('f2').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('kill').disabled = true;
  say($('m2'), '', '');
  if (!confirm('Last check. Delete this account and everything in it?')) {
    gate();
    return;
  }
  try {
    const r = await fetch('/delete-account/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, email: $('confirm').value.trim() }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || 'That did not work.');

    $('done-head').textContent = j.deleted ? 'Your account has been deleted' : 'Nothing was deleted';
    $('done-text').textContent = j.message;
    step(3);
  } catch (err) {
    say($('m2'), 'err', err.message);
    gate();
  }
});

$('back').addEventListener('click', () => {
  token = null;
  step(1);
});
$('restart').addEventListener('click', () => {
  token = null;
  $('password').value = '';
  $('confirm').value = '';
  $('understand').checked = false;
  gate();
  step(1);
});
</script>`);
