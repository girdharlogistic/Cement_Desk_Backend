/**
 * The public landing page, at `/`.
 *
 * Everyone who reaches this origin lands somewhere: the Play listing's
 * "developer website" URL, the link inside the app, Cloudflare health probes.
 * Until now they got a 404 envelope meant for API clients. This is the one
 * page meant for people on phones deciding whether to install — so it is one
 * self-contained HTML document: no build, no assets to 404, no tracking.
 *
 * The palette and the phone mockup mirror the app itself (light `cream`,
 * `cocoa` hero, `terracotta` accents, and the dark palette under
 * `prefers-color-scheme`), which is the cheapest truth-telling a landing page
 * can do: what you see here is what opens after the install.
 */

const PLAY_URL =
  'https://play.google.com/store/apps/details?id=com.girdharlogistics.cementdesk';

/**
 * A hand-drawn phone showing a stylised Freight day. Numbers are invented;
 * every colour and label is taken from the real screens, so it reads as the
 * app rather than as stock imagery.
 */
const PHONE = `
<div class="phone" aria-hidden="true">
  <div class="phone-screen">
    <div class="p-head">
      <div class="p-dot"></div>
      <div>
        <div class="p-app">Cement Desk</div>
        <div class="p-firm">Girdhar Logistics</div>
      </div>
    </div>
    <div class="p-hero">
      <div class="p-kicker">TODAY'S FREIGHT</div>
      <div class="p-big">₹ 42,180</div>
      <div class="p-sub">7 trips · 2 vehicles</div>
      <div class="p-spark"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    </div>
    <div class="p-row">
      <div>
        <div class="p-title">Sharma Traders</div>
        <div class="p-sub">Kota → Jaipur · 320 bags</div>
      </div>
      <div class="p-amount">+ ₹6,840</div>
    </div>
    <div class="p-row">
      <div>
        <div class="p-title">Jaiswal Traders</div>
        <div class="p-sub">Kota → Bundi · 500 bags</div>
      </div>
      <div class="p-amount">+ ₹9,200</div>
    </div>
    <div class="p-row">
      <div>
        <div class="p-title">Apex Hardware</div>
        <div class="p-sub">Self-lift · 350 bags</div>
      </div>
      <div class="p-amount neg">− ₹1,150</div>
    </div>
    <div class="p-tabbar"><i class="on"></i><i></i><i></i><i></i><i></i></div>
  </div>
</div>`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cement Desk — the back office for cement dealers</title>
<meta name="description" content="Freight vouchers, daily physical-vs-SAP stock reconciliation and scheme landed-cost accounting for cement dealers in India. Offline-first, syncs across phones, keeps every set of books tidy.">
<meta property="og:title" content="Cement Desk — the back office for cement dealers">
<meta property="og:description" content="Freight, Plus Minus stock tally and scheme accounting in one offline-first app. Built for Indian cement dealerships.">
<meta property="og:type" content="website">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Urbanist:wght@500;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<!--
  The PWA's manifest, linked from the marketing page on purpose: Chrome only
  offers its install prompt on a page that declares one, and the install
  button belongs here, beside the Play button, not hidden inside the app.
  The manifest scopes itself to /app/ and starts there, so installing from
  this page still gives you an icon that opens the app and not the pitch.
-->
<link rel="manifest" href="/app/manifest.json">
<meta name="theme-color" content="#FAF6F0" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#100E0B" media="(prefers-color-scheme: dark)">
<link rel="apple-touch-icon" href="/app/icons/apple-touch-icon-180.png">
<style>
  :root {
    --cream: #FAF6F0; --paper: #FFFFFF; --shell: #F1E9DF; --hairline: #E4D9CC;
    --ink: #2A1F18; --ink-muted: #7A6A5D;
    --cocoa: #4A2E22; --clay: #8B5A3C; --terracotta: #C97B4E;
    --sage: #6E8742; --sage-soft: #DCE6C4;
    --on-dark: #F7EFE6; --on-dark-muted: #C4AC99;
    --radius: 24px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --cream: #14100C; --paper: #1F1811; --shell: #2A2118; --hairline: #3B2F24;
      --ink: #F3EAE0; --ink-muted: #A99684;
      --cocoa: #6A4432; --clay: #C08A63; --terracotta: #D89264;
      --sage: #9DB86A; --sage-soft: #38471F;
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--cream); color: var(--ink);
    font: 16px/1.6 Inter, ui-sans-serif, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  h1, h2, h3, .wordmark { font-family: Urbanist, Inter, sans-serif; }
  a { color: var(--terracotta); }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 24px; }

  /* ── nav ── */
  nav {
    display: flex; align-items: center; gap: 12px;
    padding: 22px 0;
  }
  .mark {
    width: 34px; height: 34px; border-radius: 9px; flex: none;
    background: linear-gradient(135deg, var(--cocoa), var(--clay));
    display: grid; place-items: center; color: var(--on-dark);
    font-family: Urbanist, sans-serif; font-weight: 800; font-size: 17px;
  }
  .wordmark { font-weight: 800; font-size: 18px; letter-spacing: -0.01em; }
  nav .spacer { flex: 1; }
  .btn {
    display: inline-flex; align-items: center; gap: 10px;
    padding: 13px 22px; border-radius: 999px; text-decoration: none;
    font-weight: 600; font-size: 15px; transition: transform .15s ease, box-shadow .15s ease;
  }
  .btn-primary { background: var(--cocoa); color: var(--on-dark); border: 1px solid transparent; }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 12px 28px rgba(74,46,34,.25); }
  .btn-ghost { border: 1px solid var(--hairline); color: var(--ink); background: var(--paper); }
  .btn svg { width: 18px; height: 18px; flex: none; }

  /* ── hero ── */
  .hero { padding: 56px 0 72px; }
  .hero-inner { display: grid; grid-template-columns: 1.05fr .95fr; gap: 48px; align-items: center; }
  .eyebrow {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--sage-soft); color: var(--sage);
    font-size: 12.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
    padding: 7px 14px; border-radius: 999px;
  }
  .eyebrow i { width: 7px; height: 7px; border-radius: 50%; background: var(--sage); display: inline-block; }
  h1 {
    font-size: clamp(38px, 5.4vw, 58px); line-height: 1.06;
    letter-spacing: -0.025em; margin: 22px 0 18px; font-weight: 800;
  }
  h1 em { font-style: normal; color: var(--terracotta); }
  .lede { font-size: 18px; color: var(--ink-muted); max-width: 46ch; margin: 0 0 30px; }
  .hero-ctas { display: flex; gap: 12px; flex-wrap: wrap; }
  .hero-proof { margin-top: 26px; color: var(--ink-muted); font-size: 14px; display: flex; gap: 18px; flex-wrap: wrap; }
  .hero-proof b { color: var(--ink); font-weight: 600; }

  /* ── phone mockup ── */
  .phone-stage { display: grid; place-items: center; }
  .phone {
    width: 300px; border-radius: 40px; padding: 11px;
    background: linear-gradient(150deg, var(--cocoa), #241209);
    box-shadow: 0 40px 80px -24px rgba(33,18,9,.5);
  }
  .phone-screen {
    background: #FAF6F0; border-radius: 30px; padding: 14px;
    color: #2A1F18; font-size: 13px; overflow: hidden;
  }
  .p-head { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; }
  .p-dot { width: 30px; height: 30px; border-radius: 8px; background: linear-gradient(135deg, #4A2E22, #8B5A3C); }
  .p-app { font-weight: 700; font-size: 14px; line-height: 1.2; }
  .p-firm { color: #7A6A5D; font-size: 11.5px; }
  .p-hero {
    background: linear-gradient(135deg, #4A2E22, #8B5A3C);
    color: #F7EFE6; border-radius: 18px; padding: 16px; margin-bottom: 12px;
  }
  .p-kicker { font-size: 10px; letter-spacing: .12em; opacity: .75; font-weight: 600; }
  .p-big { font-family: Urbanist, sans-serif; font-size: 26px; font-weight: 800; margin: 4px 0 2px; }
  .p-sub { font-size: 11.5px; opacity: .8; }
  .p-spark { display: flex; gap: 5px; align-items: flex-end; height: 30px; margin-top: 10px; }
  .p-spark i { flex: 1; background: rgba(247,239,230,.35); border-radius: 3px; display: block; }
  .p-spark i:nth-child(1) { height: 40%; } .p-spark i:nth-child(2) { height: 65%; }
  .p-spark i:nth-child(3) { height: 50%; } .p-spark i:nth-child(4) { height: 85%; }
  .p-spark i:nth-child(5) { height: 70%; } .p-spark i:nth-child(6) { height: 95%; }
  .p-spark i:nth-child(7) { height: 60%; }
  .p-row {
    display: flex; justify-content: space-between; align-items: center; gap: 10px;
    background: #fff; border: 1px solid #E4D9CC; border-radius: 14px;
    padding: 10px 12px; margin-bottom: 8px;
  }
  .p-title { font-weight: 600; font-size: 13px; }
  .p-amount { font-weight: 700; color: #6E8742; font-size: 12.5px; white-space: nowrap; }
  .p-amount.neg { color: #B4553C; }
  .p-tabbar { display: flex; justify-content: space-around; padding: 8px 4px 2px; }
  .p-tabbar i { width: 26px; height: 5px; border-radius: 3px; background: #E4D9CC; }
  .p-tabbar i.on { background: #4A2E22; }

  /* ── sections ── */
  section { padding: 78px 0; }
  .section-head { max-width: 640px; margin-bottom: 44px; }
  .section-head h2 { font-size: clamp(28px, 3.6vw, 38px); letter-spacing: -0.02em; line-height: 1.15; margin: 0 0 12px; }
  .section-head p { color: var(--ink-muted); margin: 0; font-size: 17px; }

  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
  .card {
    background: var(--paper); border: 1px solid var(--hairline);
    border-radius: var(--radius); padding: 26px;
    transition: transform .15s ease, box-shadow .15s ease;
  }
  .card:hover { transform: translateY(-3px); box-shadow: 0 18px 40px -18px rgba(33,18,9,.22); }
  .card .icon {
    width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center;
    background: var(--shell); color: var(--cocoa); margin-bottom: 16px;
  }
  .card .icon svg { width: 22px; height: 22px; }
  .card h3 { margin: 0 0 8px; font-size: 18px; }
  .card p { margin: 0; color: var(--ink-muted); font-size: 14.5px; }

  /* ── split feature rows ── */
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; align-items: center; }
  .split + .split { margin-top: 56px; }
  .split h3 { font-size: 24px; letter-spacing: -0.01em; margin: 0 0 10px; }
  .split p { color: var(--ink-muted); margin: 0 0 16px; }
  .split ul { margin: 0; padding: 0; list-style: none; }
  .split li { display: flex; gap: 10px; margin-bottom: 10px; font-size: 15px; }
  .split li::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--terracotta); flex: none; margin-top: 9px; }
  .panel {
    background: var(--paper); border: 1px solid var(--hairline); border-radius: var(--radius);
    padding: 24px; min-height: 240px;
  }
  .quote { font-size: 15px; }
  .quote b { font-weight: 600; }
  .statline { display: flex; gap: 26px; margin-top: 18px; flex-wrap: wrap; }
  .statline div b { display: block; font-family: Urbanist, sans-serif; font-size: 26px; font-weight: 800; }
  .statline div span { color: var(--ink-muted); font-size: 13px; }

  /* ── pricing ── */
  .pricing { background: linear-gradient(150deg, var(--cocoa) 0%, #241209 100%); color: var(--on-dark); }
  .pricing .section-head p { color: var(--on-dark-muted); }
  .pricing .card { background: rgba(247,239,230,.06); border-color: rgba(247,239,230,.14); color: var(--on-dark); }
  .pricing .card p { color: var(--on-dark-muted); }
  .price-big { font-family: Urbanist, sans-serif; font-size: 40px; font-weight: 800; letter-spacing: -0.02em; margin: 14px 0 2px; }
  .price-per { color: var(--on-dark-muted); font-size: 14px; margin-bottom: 18px; }
  .trial {
    display: inline-block; background: var(--terracotta); color: #241209;
    font-size: 12.5px; font-weight: 700; padding: 5px 12px; border-radius: 999px;
  }
  .save {
    display: inline-block; background: rgba(143,168,92,.2); color: #B4CC7E;
    font-size: 12.5px; font-weight: 700; padding: 5px 12px; border-radius: 999px; margin-left: 8px;
  }
  .price-value.small { text-decoration: line-through; opacity: .5; font-size: 22px; font-family: Urbanist, sans-serif; font-weight: 700; }

  /* ── faq ── */
  details { background: var(--paper); border: 1px solid var(--hairline); border-radius: 16px; padding: 18px 22px; margin-bottom: 12px; }
  summary { cursor: pointer; font-weight: 600; font-size: 15.5px; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::after { content: '+'; float: right; color: var(--terracotta); font-size: 20px; line-height: 1; }
  details[open] summary::after { content: '–'; }
  details p { color: var(--ink-muted); margin: 12px 0 0; font-size: 14.5px; }

  /* ── install ── */
  .btn-install { background: var(--terracotta); color: #241209; border: 1px solid transparent; }
  .btn-install:hover { transform: translateY(-1px); box-shadow: 0 12px 28px rgba(201,123,78,.3); }
  .install-note { margin-top: 10px; font-size: 13.5px; color: var(--ink-muted); }

  /* The iOS instructions. Safari has never implemented an install prompt, so
     the only honest thing a button can do there is show where the control is. */
  #ios-sheet {
    position: fixed; inset: 0; z-index: 50;
    display: none; align-items: flex-end; justify-content: center;
    background: rgba(20, 12, 6, .48);
  }
  #ios-sheet.open { display: flex; }
  #ios-sheet .sheet {
    background: var(--paper); color: var(--ink);
    border-radius: 26px 26px 0 0; padding: 26px 24px 34px;
    width: 100%; max-width: 460px;
    box-shadow: 0 -20px 60px rgba(20,12,6,.35);
  }
  #ios-sheet h3 { margin: 0 0 6px; font-size: 20px; }
  #ios-sheet p { color: var(--ink-muted); margin: 0 0 18px; font-size: 14.5px; }
  #ios-sheet ol { margin: 0 0 20px; padding-left: 20px; }
  #ios-sheet li { margin-bottom: 10px; font-size: 15px; }
  #ios-sheet .close {
    width: 100%; font: inherit; font-weight: 600; cursor: pointer;
    border: 1px solid var(--hairline); background: var(--shell); color: var(--ink);
    border-radius: 999px; padding: 12px;
  }
  .share-glyph {
    display: inline-block; vertical-align: -3px;
    width: 16px; height: 16px; color: var(--terracotta);
  }

  /* ── footer ── */
  footer { border-top: 1px solid var(--hairline); padding: 40px 0 56px; color: var(--ink-muted); font-size: 14px; }
  footer .row { display: flex; gap: 24px; flex-wrap: wrap; align-items: center; }
  footer .row .grow { flex: 1; }

  @media (max-width: 860px) {
    /* The bar holds a wordmark and two buttons; below this the install one
       moves to the hero, where it is anyway the more prominent of the two. */
    #install-nav { display: none; }
    .hero-inner { grid-template-columns: 1fr; }
    .grid-3 { grid-template-columns: 1fr; }
    .split { grid-template-columns: 1fr; }
    .phone { width: 270px; }
    section { padding: 56px 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    .btn, .card { transition: none; }
  }
</style>
</head>
<body>

<nav class="wrap">
  <span class="mark">C</span>
  <span class="wordmark">Cement Desk</span>
  <span class="spacer"></span>
  <a class="btn btn-install" id="install-nav" href="/app/" data-install>Add to Home Screen</a>
  <a class="btn btn-primary" href="${PLAY_URL}">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.6 2.3c-.3.3-.5.8-.5 1.4v16.6c0 .6.2 1.1.6 1.4l.1.1L13 12.5v-.4L3.7 2.2l-.1.1zm13.2 10.6-3-3 4.4-2.5c1.4-.8 1.5-2.1.3-2.8L4.9 2l8.8 8.8 3.1 2.1zm-3 2.2L4.9 22 18.6 14c1.2-.7 1.1-2-.3-2.8l-4.4-2.5 3 2.4z" transform="translate(0 -.7) scale(1.0)"/></svg>
    Get it on Google Play
  </a>
</nav>

<header class="hero">
  <div class="wrap hero-inner">
    <div>
      <span class="eyebrow"><i></i>For cement dealers in India</span>
      <h1>The back office<br>your dealership <em>actually</em> runs on.</h1>
      <p class="lede">Freight vouchers, the daily physical-vs-SAP tally and scheme landed-cost accounting — in one offline-first app that syncs across every phone the family works from.</p>
      <div class="hero-ctas">
        <a class="btn btn-primary" href="${PLAY_URL}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.6 2.3c-.3.3-.5.8-.5 1.4v16.6c0 .6.2 1.1.6 1.4l.1.1L13 12.5v-.4L3.7 2.2l-.1.1zm13.2 10.6-3-3 4.4-2.5c1.4-.8 1.5-2.1.3-2.8L4.9 2l8.8 8.8 3.1 2.1zm-3 2.2L4.9 22 18.6 14c1.2-.7 1.1-2-.3-2.8l-4.4-2.5 3 2.4z" transform="translate(0 -.7)"/></svg>
          Download — free trial
        </a>
        <a class="btn btn-install" href="/app/" data-install>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
          Add to Home Screen
        </a>
        <a class="btn btn-ghost" href="#features">See what it does</a>
      </div>
      <p class="install-note" id="install-note">Installs straight from this page — works on Android and iPhone, no store needed.</p>
      <div class="hero-proof">
        <span><b>30 days</b> free trial</span>
        <span><b>Works offline</b> fully</span>
        <span><b>No training</b> needed</span>
      </div>
    </div>
    <div class="phone-stage">${PHONE}</div>
  </div>
</header>

<section id="features">
  <div class="wrap">
    <div class="section-head">
      <h2>Three jobs, one desk</h2>
      <p>Built for how a cement dealership actually keeps books — not a generic accounting app with the wrong abstractions.</p>
    </div>
    <div class="grid-3">
      <div class="card">
        <div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 17h4V5H2v12h3m15 0h2v-5h-5m-7 0 4-4m-7 4h7"/><circle cx="7.5" cy="17.5" r="1.9"/><circle cx="17.5" cy="17.5" r="1.9"/></svg></div>
        <h3>Freight vouchers</h3>
        <p>Numbered trips with party, location, vehicle and rate. Margin lands per trip — your own vehicle by the kilometre, self-lifting parties by the bag. Serials come from the server, so no two phones ever issue the same number.</p>
      </div>
      <div class="card">
        <div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/><rect x="3" y="3" width="18" height="18" rx="3"/></svg></div>
        <h3>Plus Minus</h3>
        <p>The daily physical-vs-SAP reconciliation, per grade and per party — the way your godown actually tallies. Opening balances carry forward on their own, so you only type the day that changed.</p>
      </div>
      <div class="card">
        <div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg></div>
        <h3>Scheme accounting</h3>
        <p>Company slab schemes — monthly, quarterly, annual — with premium-mix percentages and cash discounts. Landed-cost tables, the estimate planner, run-rate analysis and claims with credit-note ageing.</p>
      </div>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="split">
      <div>
        <h3>Works in the godown, not just the office</h3>
        <p>Wi-Fi dies at the worst spot — Cement Desk doesn't. Every screen reads and writes instantly from local storage, and changes queue up to sync the moment signal returns.</p>
        <ul>
          <li>Full read and write with zero connectivity</li>
          <li>Auto-syncs when the network comes back</li>
          <li>Conflicts resolve themselves, with none of your numbers silently touched</li>
        </ul>
      </div>
      <div class="panel quote">
        <div class="statline">
          <div><b>0s</b><span>load time on any screen</span></div>
          <div><b>1 tap</b><span>to share the day's sheet</span></div>
        </div>
        <p style="margin-top:18px">One signed-in phone is an island; add a second and they are mirrors. Your accountant in town and your brother at the godown see the same books, live, without anyone calling anyone.</p>
      </div>
    </div>
    <div class="split">
      <div class="panel quote">
        <p><b>Firms are switched in one tap.</b> Each firm keeps its own parties, routes, vouchers and stock sheets — family businesses running two or three sets of books stay separate, always.</p>
        <p style="margin-top:12px">Share a firm by email invite — owner, admin or read-only. The invite decides what they may touch; you decide when it ends.</p>
      </div>
      <div>
        <h3>Numbers that leave the app when you need them</h3>
        <p>CSV and Excel exports that open anywhere — for the CA, the bank or the group chat — with date ranges and party picks when you upgrade.</p>
        <ul>
          <li>Freight CSV with grade columns</li>
          <li>Plus Minus as a branded Excel workbook</li>
          <li>Full JSON backup you actually own</li>
        </ul>
      </div>
    </div>
  </div>
</section>

<section class="pricing">
  <div class="wrap">
    <div class="section-head">
      <h2>Free to run the shop.<br>Premium when it pays for itself.</h2>
      <p>Every account starts free, forever: one firm, one device, every feature working — ads pay for it. Go premium and the ads leave with you.</p>
    </div>
    <div class="grid-3">
      <div class="card" style="grid-row: span 1;">
        <h3>Free</h3>
        <div class="price-big">₹0</div>
        <div class="price-per">forever</div>
        <p>One firm, one phone, all features. A short ad now and then keeps it free for everyone.</p>
      </div>
      <div class="card">
        <span class="trial">30 days free</span>
        <h3 style="margin-top:12px">Premium Monthly</h3>
        <div class="price-big">₹99</div>
        <div class="price-per">per month</div>
        <p>No ads. Exports with any filter. Unlimited firms and devices, shared with whoever keeps the books with you.</p>
      </div>
      <div class="card">
        <span class="trial">30 days free</span><span class="save">save 50%</span>
        <h3 style="margin-top:12px">Premium Yearly</h3>
        <div><span class="price-value small">₹1,188</span></div>
        <div class="price-big" style="margin-top:-22px">₹599</div>
        <div class="price-per">per year</div>
        <p>Same everything as monthly, for the price of six months. The one most dealers end up on.</p>
      </div>
    </div>
    <div class="hero-ctas" style="margin-top:36px">
      <a class="btn btn-install" href="/app/" data-install>Add to Home Screen</a>
      <a class="btn btn-ghost" style="border-color:rgba(247,239,230,.3);color:var(--on-dark);background:transparent" href="${PLAY_URL}">Start the free trial on Google Play</a>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="section-head">
      <h2>Questions dealers actually ask</h2>
    </div>
    <details>
      <summary>What happens to my data if I stop paying?</summary>
      <p>Nothing. Your books stay on your phone — you go back to the free tier: everything visible, everything working, ads back on, exports unfiltered. Premium is rental of convenience, never rent on your own data.</p>
    </details>
    <details>
      <summary>Does it need internet to work?</summary>
      <p>No. Signing in and syncing need a connection; the daily work — vouchers, stock sheets, scheme estimates — works fully offline. Everything queues and catches up when you're back in signal.</p>
    </details>
    <details>
      <summary>Can my accountant use it on their phone?</summary>
      <p>Yes — add them as read-only on the firm and they see the same books live, without your password and without touching anything. Premium removes its ads too.</p>
    </details>
    <details>
      <summary>Is there an iPhone app?</summary>
      <p>Not on the App Store — but tap <b>Add to Home Screen</b> above and Cement Desk installs itself on an iPhone or iPad, with its own icon, its own window and no Safari chrome. It is the same app: the same screens, the same offline working, the same books syncing to the same account. Android works this way too if you would rather not use the Play Store.</p>
    </details>
    <details>
      <summary>Does the web version keep working without signal?</summary>
      <p>Yes. Once it has installed, everything lives on the device exactly as it does in the Android app — you can write a whole day of vouchers on a dead connection and it catches up when you have one. Buying Premium is the one thing that only happens in the Android app; whatever you buy there applies everywhere you sign in.</p>
    </details>
    <details>
      <summary>I'm switching from WhatsApp-and-Excel — how do my books get in?</summary>
      <p>Parties, locations and grades take minutes to set up. The history doesn't need importing: the app starts from your opening balances, exactly like the register did before it.</p>
    </details>
  </div>
</section>

<footer>
  <div class="wrap row">
    <span>© Girdhar Logistics · Cement Desk</span>
    <span class="grow"></span>
    <a href="/app/">Web app</a>
    <a href="${PLAY_URL}">Google Play</a>
    <a href="/delete-account">Delete account</a>
  </div>
</footer>

<div id="ios-sheet" role="dialog" aria-modal="true" aria-labelledby="ios-title">
  <div class="sheet">
    <h3 id="ios-title">Add Cement Desk to your Home Screen</h3>
    <p>Safari does not let a page install itself, so it takes two taps.</p>
    <ol>
      <li>Tap the Share button
        <svg class="share-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V3"/><path d="m8 7 4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>
        at the bottom of Safari.</li>
      <li>Scroll down and choose <b>Add to Home Screen</b>.</li>
      <li>Tap <b>Add</b>. Cement Desk gets its own icon and opens without Safari around it.</li>
    </ol>
    <button type="button" class="close" id="ios-close">Got it</button>
  </div>
</div>

<script>
(function () {
  'use strict';

  var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-install]'));
  var note = document.getElementById('install-note');
  var sheet = document.getElementById('ios-sheet');
  var deferred = null;

  function standalone() {
    try {
      if (window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) { /* older engine */ }
    return navigator.standalone === true;
  }

  var ua = navigator.userAgent;
  // iPadOS 13+ reports a desktop Safari string, so the touch count is what
  // separates an iPad from a Mac. Chrome and Firefox on iOS are Safari
  // underneath and behave the same way here.
  var isApple = /iPhone|iPad|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

  function label(text) {
    buttons.forEach(function (b) {
      // Only the text node is replaced, so the arrow glyph in the hero
      // button survives.
      var replaced = false;
      Array.prototype.forEach.call(b.childNodes, function (n) {
        if (n.nodeType === 3 && n.textContent.trim()) {
          n.textContent = replaced ? '' : ' ' + text + ' ';
          replaced = true;
        }
      });
      if (!replaced) b.textContent = text;
    });
  }

  function say(text) { if (note) note.textContent = text; }

  // Already installed: the button has nothing to add, so it opens the thing
  // instead. Same for a desktop browser that will not install — the link it
  // carries in the markup already works, and is left alone.
  function markInstalled() {
    label('Open the web app');
    say('Cement Desk is installed on this device — open it from your home screen, or tap here.');
  }

  if (standalone()) markInstalled();

  // Chrome, Edge, Samsung Internet. Firing this event is the browser saying
  // the page passes every installability check, which is the only reliable
  // signal there is — so the real install button is only offered here.
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    label('Add to Home Screen');
    say('Installs straight from this page. No store, no download, about 7 MB.');
  });

  window.addEventListener('appinstalled', function () {
    deferred = null;
    markInstalled();
  });

  buttons.forEach(function (button) {
    button.addEventListener('click', function (event) {
      if (deferred) {
        event.preventDefault();
        deferred.prompt();
        deferred.userChoice.then(function (choice) {
          if (choice.outcome !== 'accepted') {
            // Kept for a second try: the event only fires once per page load.
            say('No problem — the web app opens in the browser too.');
          }
          deferred = null;
        });
        return;
      }
      if (isApple && !standalone()) {
        event.preventDefault();
        sheet.classList.add('open');
        return;
      }
      // Everything else follows the href to /app/, which is the right answer
      // for a desktop browser and for one that has already installed it.
    });
  });

  if (sheet) {
    document.getElementById('ios-close').addEventListener('click', function () {
      sheet.classList.remove('open');
    });
    sheet.addEventListener('click', function (e) {
      if (e.target === sheet) sheet.classList.remove('open');
    });
  }

  // Chrome will not raise its install prompt on a page no service worker
  // controls. This one is a pass-through that caches nothing — the PWA's real
  // worker lives at /app/sw.js. See the backend's webapp module.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* fine */ });
    });
  }
})();
</script>

</body>
</html>`;

export function renderLandingPage(): string {
  return PAGE;
}
