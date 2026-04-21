// ---------------------------------------------------------------------------
// landing-styles.ts
// ---------------------------------------------------------------------------
// The full CSS for the public landing page, kept as a string so the landing
// component can inject it via a `<style>` tag in its return tree. React
// mounts / unmounts the `<style>` element with the component, so the CSS
// only applies while the landing page is rendered. When the user navigates
// to /auth/sign-in or /auth/sign-up, the landing component unmounts and
// the CSS is removed from the DOM — the auth pages render against their
// own Clerk-themed styles without bleed.
//
// Ported as-is from the /v1/design bundle (`qualifydm-s/project/landing.html`)
// with only two changes:
//   - Removed the `.tweaks` design-tool edit-mode panel rules
//   - `body { font-family: "Geist", ... }` kept as-is since Geist is already
//     loaded via next/font in src/components/themes/font.config.ts
// ---------------------------------------------------------------------------

export const LANDING_CSS = `
  :root {
    /* Light, Chronicle-inspired palette */
    --bg: #f3f3f3;          /* neutral light gray */
    --bg-2: #ededed;
    --bg-3: #e5e5e5;
    --surface: #ffffff;
    --surface-2: #f8f8f8;
    --ink: #1a1815;
    --ink-2: #4a453e;
    --ink-3: #868075;
    --ink-4: #b5ad9f;
    --line: rgba(26,24,21,0.08);
    --line-2: rgba(26,24,21,0.14);
    --accent: #2f5fff;       /* rich editorial blue */
    --accent-soft: #e8efff;
    --accent-ink: #1a3fc4;
    --shadow-sm: 0 1px 2px rgba(26,24,21,0.04), 0 2px 8px rgba(26,24,21,0.04);
    --shadow-md: 0 1px 2px rgba(26,24,21,0.04), 0 20px 40px -20px rgba(26,24,21,0.15);
    --shadow-lg: 0 1px 2px rgba(26,24,21,0.04), 0 40px 80px -30px rgba(26,24,21,0.25);
  }
  [data-accent="indigo"] { --accent:#4f46e5; --accent-soft:#eceafb; --accent-ink:#3a32bf;}
  [data-accent="emerald"]{ --accent:#059669; --accent-soft:#e1f4ec; --accent-ink:#047553;}
  [data-accent="crimson"]{ --accent:#c6364b; --accent-soft:#fae7ea; --accent-ink:#9b2636;}

  .landing-root * { box-sizing: border-box; }
  .landing-root, .landing-root body { background: var(--bg); color: var(--ink);}
  body:has(.landing-root) {
    margin: 0; padding: 0;
    background: var(--bg); color: var(--ink);
    font-family: "Geist", "Inter", system-ui, sans-serif;
    font-size: 16.5px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    overflow-x: hidden;
    letter-spacing: -0.005em;
    position: relative;
  }
  .landing-root {
    font-family: "Geist", "Inter", system-ui, sans-serif;
    font-size: 16.5px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    letter-spacing: -0.005em;
    position: relative;
    min-height: 100vh;
  }

  /* ===== Background pinstripes (Chronicle-style) ===== */
  .landing-root .bg-pinstripes {
    position: fixed; inset: 0;
    pointer-events: none; z-index: 0;
    background-image:
      repeating-linear-gradient(
        to right,
        transparent 0,
        transparent 23px,
        rgba(26,24,21,0.08) 23px,
        rgba(26,24,21,0.08) 24px
      );
    background-size: 24px 100%;
    background-repeat: repeat;
    -webkit-mask-image: linear-gradient(
      to right,
      transparent 0%,
      transparent 18%,
      rgba(0,0,0,1) 40%,
      rgba(0,0,0,1) 60%,
      transparent 82%,
      transparent 100%
    );
    mask-image: linear-gradient(
      to right,
      transparent 0%,
      transparent 18%,
      rgba(0,0,0,1) 40%,
      rgba(0,0,0,1) 60%,
      transparent 82%,
      transparent 100%
    );
    -webkit-mask-size: 200% 100%;
    mask-size: 200% 100%;
    -webkit-mask-repeat: no-repeat;
    mask-repeat: no-repeat;
    animation: stripeReveal 16s ease-in-out infinite;
    will-change: mask-position, -webkit-mask-position;
  }
  @keyframes stripeReveal {
    0%   { -webkit-mask-position: 100% 0%; mask-position: 100% 0%; }
    50%  { -webkit-mask-position: 0% 0%;   mask-position: 0% 0%;   }
    100% { -webkit-mask-position: 100% 0%; mask-position: 100% 0%; }
  }
  @media (prefers-reduced-motion: reduce) {
    .landing-root .bg-pinstripes { animation: none;}
  }

  .landing-root .nav-wrap,
  .landing-root main,
  .landing-root section,
  .landing-root footer { position: relative; z-index: 1; }
  .landing-root ::selection { background: var(--accent); color: white; }
  .landing-root a { color: inherit; }

  .landing-root .mono { font-family: "JetBrains Mono", ui-monospace, monospace; }

  .landing-root h1,
  .landing-root h2,
  .landing-root h3,
  .landing-root h4 {
    margin: 0; letter-spacing: -0.035em; font-weight: 500;
    font-family: "Geist", system-ui, sans-serif;
  }
  .landing-root p { margin: 0; }

  .landing-root .wrap { max-width: 1140px; margin: 0 auto; padding: 0 28px; }
  .landing-root .wrap-narrow { max-width: 880px; margin: 0 auto; padding: 0 28px; }

  /* ===== NAV ===== */
  .landing-root .nav-wrap {
    position: fixed; top: 14px; left: 0; right: 0; z-index: 50;
    display: flex; justify-content: center; pointer-events: none;
  }
  .landing-root .nav {
    pointer-events: auto;
    display: flex; align-items: center; gap: 28px;
    padding: 8px 8px 8px 22px;
    background: rgba(243,243,243,0.78);
    border: 1px solid rgba(26,24,21,0.08);
    border-radius: 999px;
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    box-shadow: 0 1px 2px rgba(26,24,21,0.04), 0 10px 40px -15px rgba(26,24,21,0.12);
    transition: all .3s ease;
  }
  .landing-root .logo { display: flex; align-items: center; gap: 10px; color: var(--ink); text-decoration: none; font-weight: 500; letter-spacing: -0.015em; font-size: 15.5px;}
  .landing-root .logo-mark {
    width: 24px; height: 24px; border-radius: 7px;
    background: var(--ink);
    display: grid; place-items: center;
    color: var(--bg); font-weight: 600; font-size: 12.5px;
  }
  .landing-root .nav-links { display: flex; gap: 22px; }
  .landing-root .nav-links a { color: var(--ink-2); text-decoration: none; font-size: 14px; transition: color .2s; }
  .landing-root .nav-links a:hover { color: var(--ink); }
  .landing-root .nav-auth { display: flex; align-items: center; gap: 8px; }
  .landing-root .nav-signin {
    padding: 9px 16px; color: var(--ink-2);
    border-radius: 999px; font-size: 13.5px; font-weight: 500;
    text-decoration: none; white-space: nowrap;
    transition: color .2s, background .2s;
  }
  .landing-root .nav-signin:hover { color: var(--ink); background: rgba(26,24,21,0.05); }
  .landing-root .nav-cta {
    padding: 9px 18px; background: var(--ink); color: var(--bg);
    border-radius: 999px; font-size: 13.5px; font-weight: 500;
    text-decoration: none; white-space: nowrap;
    transition: transform .15s, background .2s;
  }
  .landing-root .nav-cta:hover { background: #000; transform: translateY(-1px);}
  @media (max-width: 760px) {
    .landing-root .nav-links { display: none; }
    .landing-root .nav { gap: 10px; padding-left: 16px;}
    .landing-root .nav-signin { padding: 8px 12px; font-size: 13px;}
  }

  /* ===== BUTTONS ===== */
  .landing-root .btn {
    display: inline-flex; align-items: center; gap: 10px;
    padding: 14px 24px; border-radius: 999px;
    font-family: "Geist", sans-serif;
    font-size: 15px; font-weight: 500;
    text-decoration: none; cursor: pointer; border: 0;
    transition: transform .2s cubic-bezier(.2,.8,.2,1), box-shadow .3s, background .2s;
    white-space: nowrap;
  }
  .landing-root .btn-primary { background: var(--ink); color: var(--bg); box-shadow: var(--shadow-sm);}
  .landing-root .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 1px 2px rgba(26,24,21,0.05), 0 18px 40px -10px rgba(26,24,21,0.3);}
  .landing-root .btn-primary .arrow { transition: transform .25s; }
  .landing-root .btn-primary:hover .arrow { transform: translateX(3px); }
  .landing-root .btn-lg { padding: 16px 28px; font-size: 15.5px; }
  .landing-root .btn-ghost {
    background: rgba(26,24,21,0.05); color: var(--ink);
    border: 1px solid transparent;
  }
  .landing-root .btn-ghost:hover { background: rgba(26,24,21,0.09); }

  /* ===== HERO ===== */
  .landing-root .hero { padding: 160px 0 100px; position: relative; text-align: center; }
  .landing-root .pill {
    display: inline-flex; align-items: center;
    padding: 0; background: transparent; border: 0; box-shadow: none;
  }
  .landing-root .pill-icon {
    width: 44px; height: 44px; border-radius: 999px;
    display: grid; place-items: center;
    box-shadow: 0 0 0 3px var(--bg), 0 6px 14px -6px rgba(26,24,21,0.25);
    transition: transform .25s ease;
  }
  .landing-root .pill-icon + .pill-icon { margin-left: -10px; }
  .landing-root .pill:hover .pill-icon { transform: translateX(3px);}
  .landing-root .pill:hover .pill-icon:first-child { transform: translateX(-3px);}
  .landing-root .pill-icon svg { width: 22px; height: 22px;}
  .landing-root .pill-icon-ig {
    background: linear-gradient(135deg, #833ab4 0%, #e1306c 50%, #fd7e14 100%);
  }
  .landing-root .pill-icon-fb { background: #1877f2; }

  .landing-root .hero h1 {
    font-family: "Geist", sans-serif;
    font-weight: 500;
    font-size: clamp(44px, 7vw, 92px);
    line-height: 1.0;
    letter-spacing: -0.045em;
    margin: 28px auto 0;
    max-width: 17ch;
    text-wrap: balance;
  }
  .landing-root .hero h1 .it { font-weight: 400; color: var(--ink-2); }
  .landing-root .hero h1 .acc { color: var(--accent); font-weight: 500;}

  .landing-root .hero-sub {
    margin: 32px auto 0;
    max-width: 56ch;
    font-size: 18.5px;
    line-height: 1.5;
    color: var(--ink-2);
    text-wrap: pretty;
  }
  .landing-root .hero-tag {
    margin-top: 22px;
    color: var(--ink-3);
    font-size: 16px; font-weight: 400;
    letter-spacing: -0.005em;
  }
  .landing-root .hero-cta { margin-top: 38px; display: flex; justify-content: center; gap: 12px; flex-wrap: wrap; }
  .landing-root .hero-meta {
    margin-top: 26px; display: flex; justify-content: center; gap: 22px;
    color: var(--ink-3); font-size: 13px; flex-wrap: wrap;
  }
  .landing-root .hero-meta svg { width: 14px; height: 14px; color: var(--accent);}
  .landing-root .hero-meta span { display: inline-flex; align-items: center; gap: 6px;}

  /* ===== Section heading ===== */
  .landing-root .eyebrow {
    display: inline-flex; align-items: center; gap: 9px;
    font-family: "JetBrains Mono", monospace;
    font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.2em;
    color: var(--ink-3);
  }
  .landing-root .eyebrow::before {
    content: ""; width: 6px; height: 6px; border-radius: 2px; background: var(--accent);
  }
  .landing-root h2.section-h {
    font-family: "Geist", sans-serif;
    font-weight: 500;
    font-size: clamp(36px, 5vw, 62px);
    line-height: 1.03;
    letter-spacing: -0.04em;
    margin-top: 18px;
    max-width: 18ch;
    text-wrap: balance;
  }
  .landing-root h2.section-h .it { font-weight: 400; color: var(--ink-2);}
  .landing-root h2.section-h .acc { color: var(--accent); font-weight: 500;}
  .landing-root h2.section-h.center { margin-left: auto; margin-right: auto; text-align: center; }
  .landing-root .section-sub {
    margin-top: 20px; color: var(--ink-2);
    font-size: 17.5px; max-width: 58ch;
    text-wrap: pretty;
  }
  .landing-root .section-sub.center { margin-left: auto; margin-right: auto; text-align: center; }

  /* ===== PROBLEM ===== */
  .landing-root .problem { padding: 100px 0 60px; }
  .landing-root .problem-head { display: flex; flex-direction: column; align-items: flex-start; margin-bottom: 50px;}
  .landing-root .problems-list { border-top: 1px solid var(--line); }
  .landing-root .problem-item {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 40px;
    padding: 42px 0;
    border-bottom: 1px solid var(--line);
    align-items: baseline;
  }
  .landing-root .problem-num {
    font-family: "Geist", sans-serif;
    font-weight: 500;
    font-size: 54px;
    line-height: 1;
    color: var(--accent);
    letter-spacing: -0.04em;
  }
  .landing-root .problem-body {
    font-weight: 400;
    font-size: 20px;
    color: var(--ink);
    line-height: 1.45;
    max-width: 58ch;
    text-wrap: pretty;
    letter-spacing: -0.012em;
  }
  .landing-root .problem-body em { font-style: normal; font-weight: 500; color: var(--accent-ink); }
  .landing-root .problem-closer {
    margin-top: 56px;
    font-weight: 500;
    font-size: clamp(28px, 4vw, 44px);
    line-height: 1.1;
    max-width: 22ch;
    letter-spacing: -0.035em;
  }
  .landing-root .problem-closer .dash { color: var(--accent); }
  .landing-root .problem-closer .it { font-style: normal; font-weight: 400; color: var(--ink-2);}
  @media (max-width: 640px) {
    .landing-root .problem-item { grid-template-columns: 1fr; gap: 10px; padding: 32px 0;}
    .landing-root .problem-num { font-size: 54px;}
    .landing-root .problem-body { font-size: 19px;}
  }

  /* ===== FEATURES ===== */
  .landing-root .features { padding: 100px 0; }
  .landing-root .features-head { text-align: center; margin-bottom: 70px; display: flex; flex-direction: column; align-items: center;}
  .landing-root .feature-row {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: 80px; align-items: center;
    padding: 60px 0;
  }
  .landing-root .feature-row.reverse .feat-copy { order: 2;}
  .landing-root .feature-row.reverse .feat-visual { order: 1;}
  .landing-root .feat-copy .feat-num {
    font-family: "JetBrains Mono", monospace;
    font-size: 11.5px; color: var(--ink-3);
    letter-spacing: 0.2em; text-transform: uppercase;
  }
  .landing-root .feat-copy h3 {
    font-family: "Geist", sans-serif;
    font-weight: 500;
    font-size: clamp(28px, 3.6vw, 42px);
    line-height: 1.05;
    letter-spacing: -0.04em;
    margin-top: 14px;
    text-wrap: balance;
  }
  .landing-root .feat-copy h3 .it { font-weight: 400; color: var(--ink-2);}
  .landing-root .feat-copy .feat-sub {
    margin-top: 16px; font-size: 17px; color: var(--ink-2); max-width: 42ch;
  }
  .landing-root .feat-bullets { margin-top: 28px; display: flex; flex-direction: column; gap: 14px;}
  .landing-root .feat-bullet {
    display: flex; gap: 12px; align-items: flex-start;
    color: var(--ink); font-size: 15.5px;
  }
  .landing-root .feat-bullet .dot {
    width: 18px; height: 18px; border-radius: 999px;
    background: var(--accent-soft);
    flex-shrink: 0; margin-top: 3px;
    display: grid; place-items: center;
  }
  .landing-root .feat-bullet .dot::after {
    content: ""; width: 7px; height: 7px; border-radius: 999px;
    background: var(--accent);
  }
  @media (max-width: 860px) {
    .landing-root .feature-row { grid-template-columns: 1fr; gap: 44px; padding: 30px 0;}
    .landing-root .feature-row.reverse .feat-copy { order: 1;}
    .landing-root .feature-row.reverse .feat-visual { order: 2;}
  }

  /* Bento-style visual card */
  .landing-root .bento {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 28px;
    padding: 34px;
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    min-height: 520px;
  }
  .landing-root .bento::before {
    content: ""; position: absolute; inset: 0;
    background: radial-gradient(600px 300px at 50% 120%, var(--accent-soft), transparent 60%);
    pointer-events: none;
  }

  /* iPhone */
  .landing-root .phone-wrap { display: flex; justify-content: center; position: relative; z-index: 1;}
  .landing-root .phone {
    position: relative;
    width: 290px; height: 590px;
    border-radius: 42px;
    background: #0a0a0b;
    border: 1px solid rgba(0,0,0,0.2);
    padding: 8px;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.05) inset,
      0 40px 80px -30px rgba(26,24,21,0.45),
      0 10px 30px -10px rgba(26,24,21,0.2);
  }
  .landing-root .phone-screen {
    width: 100%; height: 100%;
    border-radius: 34px; background: #000;
    overflow: hidden; position: relative;
    display: flex; flex-direction: column;
  }
  .landing-root .phone-notch {
    position: absolute; top: 8px; left: 50%; transform: translateX(-50%);
    width: 92px; height: 22px; background: #000; border-radius: 999px; z-index: 3;
  }
  .landing-root .ig-bar {
    padding: 38px 14px 9px; border-bottom: 0.5px solid rgba(255,255,255,0.1);
    display: flex; align-items: center; gap: 10px;
    background: #000;
  }
  .landing-root .ig-back { color: #fff; font-size: 22px; line-height: 1; }
  .landing-root .ig-avatar {
    width: 30px; height: 30px; border-radius: 999px;
    background: linear-gradient(135deg,#60a5fa,#2f5fff);
    display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 11.5px;
    flex-shrink: 0;
  }
  .landing-root .ig-user { display: flex; flex-direction: column; flex: 1; min-width: 0;}
  .landing-root .ig-name { color: #fff; font-size: 12.5px; font-weight: 600;}
  .landing-root .ig-active { color: rgba(255,255,255,0.5); font-size: 10px;}
  .landing-root .ig-actions { display: flex; gap: 12px; color: #fff; opacity: .9;}
  .landing-root .ig-actions svg { width: 19px; height: 19px; }

  .landing-root .ig-thread {
    flex: 1; overflow: hidden;
    padding: 10px 10px 6px;
    display: flex; flex-direction: column; gap: 3px;
    background: #000;
    font-family: -apple-system, "SF Pro Text", system-ui, sans-serif;
  }
  .landing-root .bubble {
    max-width: 78%; padding: 7px 12px;
    border-radius: 18px; font-size: 12.5px; line-height: 1.35;
    word-wrap: break-word;
  }
  .landing-root .bubble.them { align-self: flex-start; background: #262626; color: #fff; border-bottom-left-radius: 5px;}
  .landing-root .bubble.me { align-self: flex-end; background: #3797f0; color: #fff; border-bottom-right-radius: 5px;}
  .landing-root .bubble.me.grad { background: linear-gradient(135deg, #833ab4, #e1306c 70%, #fd7e14);}
  .landing-root .ts { align-self: center; color: rgba(255,255,255,0.5); font-size: 10px; margin: 5px 0;}
  .landing-root .stage-label {
    align-self: center; font-size: 9.5px;
    color: #a5c4ff;
    font-family: "JetBrains Mono", monospace;
    padding: 3px 8px; border: 1px solid rgba(165,196,255,0.3); border-radius: 999px;
    background: rgba(47,95,255,0.1);
    margin: 6px 0 3px; letter-spacing: 0.1em; text-transform: uppercase;
  }
  .landing-root .typing {
    align-self: flex-start; background: #262626;
    padding: 9px 13px; border-radius: 18px; border-bottom-left-radius: 5px;
    display: inline-flex; gap: 3px;
  }
  .landing-root .typing span { width: 6px; height: 6px; border-radius: 999px; background: rgba(255,255,255,0.5); animation: tdot 1.3s infinite;}
  .landing-root .typing span:nth-child(2){ animation-delay:.15s;}
  .landing-root .typing span:nth-child(3){ animation-delay:.3s;}
  @keyframes tdot { 0%,60%,100%{transform:translateY(0);opacity:.4;} 30%{transform:translateY(-3px);opacity:1;}}

  .landing-root .ig-input {
    padding: 7px 10px 12px; background: #000; border-top: 0.5px solid rgba(255,255,255,0.1);
    display: flex; gap: 6px; align-items: center;
  }
  .landing-root .ig-input-field {
    flex: 1; background: #1a1a1a; color: rgba(255,255,255,0.5);
    padding: 7px 12px; border-radius: 999px; font-size: 11px;
  }
  .landing-root .ig-input-icons { display: flex; gap: 8px; color: #fff; opacity: .8;}
  .landing-root .ig-input-icons svg { width: 17px; height: 17px;}

  /* Floating overlays on bento */
  .landing-root .overlay-card {
    position: absolute; background: var(--surface);
    border: 1px solid var(--line); border-radius: 14px;
    padding: 12px 14px; box-shadow: var(--shadow-md);
    font-size: 12.5px; z-index: 2;
  }
  .landing-root .stage-chip {
    right: 20px; top: 60px;
    display: flex; flex-direction: column; gap: 8px; min-width: 170px;
    font-family: "JetBrains Mono", monospace; font-size: 11px;
  }
  .landing-root .stage-chip .title { color: var(--ink-3); font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; margin-bottom: 2px;}
  .landing-root .stage-chip .stage-item { display: flex; align-items: center; gap: 9px; color: var(--ink-3);}
  .landing-root .stage-chip .stage-item.done { color: var(--ink);}
  .landing-root .stage-chip .stage-item.active { color: var(--accent);}
  .landing-root .stage-chip .sq { width: 11px; height: 11px; border-radius: 3px; border: 1.5px solid var(--line-2);}
  .landing-root .stage-chip .done .sq { background: var(--ink); border-color: var(--ink);}
  .landing-root .stage-chip .active .sq { background: var(--accent); border-color: var(--accent); box-shadow: 0 0 0 3px rgba(47,95,255,0.15);}

  .landing-root .route-card {
    right: 16px; top: 60px;
    min-width: 220px; padding: 14px 16px;
  }
  .landing-root .route-card .rc-title { font-family: "JetBrains Mono", monospace; font-size: 10px; color: var(--ink-3); letter-spacing: 0.15em; text-transform: uppercase; margin-bottom: 8px;}
  .landing-root .route-card .rc-row { display: flex; justify-content: space-between; align-items: center; font-size: 12.5px; color: var(--ink-3); padding: 5px 0; border-bottom: 1px dashed var(--line);}
  .landing-root .route-card .rc-row:last-of-type { border: 0;}
  .landing-root .route-card .rc-row strong { color: var(--ink); font-weight: 500;}
  .landing-root .route-card .rc-badge {
    display: inline-flex; align-items: center; gap: 6px;
    background: #e0f5ea; color: #047553;
    padding: 3px 9px; border-radius: 999px; font-size: 11px;
    font-family: "JetBrains Mono", monospace;
  }
  .landing-root .route-card .rc-badge::before { content:""; width: 5px; height: 5px; border-radius: 999px; background: #10b981;}
  .landing-root .route-card .rc-cta {
    margin-top: 12px; background: var(--accent); color: white; font-weight: 500;
    text-align: center; padding: 8px; border-radius: 10px; font-size: 12px;
  }

  /* Inbox card — feature 2 */
  .landing-root .inbox-card {
    right: 14px; top: 36px;
    width: 290px; padding: 14px 14px 10px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .landing-root .inbox-card .title {
    font-family: "JetBrains Mono", monospace;
    font-size: 10px; color: var(--ink-3);
    letter-spacing: 0.15em; text-transform: uppercase;
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 2px;
  }
  .landing-root .inbox-pulse {
    display: inline-flex; align-items: center; gap: 6px;
    color: #047553; background: #e0f5ea;
    padding: 3px 8px; border-radius: 999px;
    font-size: 9.5px; letter-spacing: 0.08em;
  }
  .landing-root .inbox-pulse span {
    width: 6px; height: 6px; border-radius: 999px;
    background: #10b981;
    animation: pulseDot 1.6s ease-in-out infinite;
  }
  @keyframes pulseDot {
    0%,100% { box-shadow: 0 0 0 0 rgba(16,185,129,0.55);}
    50% { box-shadow: 0 0 0 6px rgba(16,185,129,0);}
  }
  .landing-root .inbox-row {
    display: grid; grid-template-columns: 28px 1fr auto;
    gap: 10px; align-items: center;
    padding: 8px 0;
    border-top: 1px dashed var(--line);
  }
  .landing-root .inbox-av {
    width: 28px; height: 28px; border-radius: 999px;
    display: flex; align-items: center; justify-content: center;
    color: white; font-size: 11px; font-weight: 600;
    background: linear-gradient(135deg,#833ab4,#e1306c);
  }
  .landing-root .inbox-meta { min-width: 0;}
  .landing-root .inbox-name {
    font-size: 12px; font-weight: 500; color: var(--ink);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .landing-root .inbox-src {
    font-family: "JetBrains Mono", monospace;
    font-size: 9.5px; color: var(--ink-3); font-weight: 400;
    letter-spacing: 0.04em;
  }
  .landing-root .inbox-preview {
    font-size: 11.5px; color: var(--ink-3);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    margin-top: 1px;
  }
  .landing-root .inbox-time { text-align: right; display: flex; flex-direction: column; gap: 2px;}
  .landing-root .inbox-time .stamp {
    font-family: "JetBrains Mono", monospace;
    font-size: 9.5px; color: var(--ink-3); letter-spacing: 0.05em;
  }
  .landing-root .inbox-time .reply {
    font-family: "JetBrains Mono", monospace;
    font-size: 9.5px; color: var(--accent); font-weight: 500;
    letter-spacing: 0.02em;
  }

  @media (max-width: 860px) {
    .landing-root .overlay-card { display: none;}
    .landing-root .bento { padding: 28px 18px; min-height: auto;}
  }

  /* ===== STATS ===== */
  .landing-root .stats { padding: 80px 0;}
  .landing-root .stats-grid {
    display: grid; grid-template-columns: repeat(3, 1fr);
    border: 1px solid var(--line); border-radius: 24px;
    overflow: hidden; background: var(--surface);
    box-shadow: var(--shadow-sm);
  }
  .landing-root .stat {
    padding: 48px 36px;
    display: flex; flex-direction: column; gap: 14px;
    border-right: 1px solid var(--line);
  }
  .landing-root .stat:last-child { border-right: 0;}
  .landing-root .stat-num {
    font-family: "Geist", sans-serif;
    font-weight: 500;
    font-size: clamp(54px, 6.8vw, 86px);
    line-height: 0.95;
    color: var(--accent);
    letter-spacing: -0.05em;
  }
  .landing-root .stat-num .it { font-weight: 300; color: var(--ink-3);}
  .landing-root .stat-label { color: var(--ink-2); font-size: 15px; max-width: 26ch;}
  @media (max-width: 760px) {
    .landing-root .stats-grid { grid-template-columns: 1fr;}
    .landing-root .stat { border-right: 0; border-bottom: 1px solid var(--line); padding: 36px 28px;}
    .landing-root .stat:last-child { border-bottom: 0;}
  }

  /* ===== COMPARE ===== */
  .landing-root .compare { padding: 100px 0;}
  .landing-root .compare-head { text-align: center; margin-bottom: 56px; display: flex; flex-direction: column; align-items: center;}
  .landing-root .compare-table {
    display: grid; grid-template-columns: 1.2fr 1fr 1fr;
    border: 1px solid var(--line); border-radius: 20px; overflow: hidden;
    background: var(--surface);
    box-shadow: var(--shadow-sm);
  }
  .landing-root .ct-head {
    padding: 22px 24px;
    font-family: "JetBrains Mono", monospace; font-size: 11.5px;
    letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink-3);
    border-bottom: 1px solid var(--line);
  }
  .landing-root .ct-head.hl {
    color: var(--accent); background: var(--accent-soft);
    position: relative;
  }
  .landing-root .ct-head.hl::after {
    content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px;
    background: var(--accent);
  }
  .landing-root .ct-label,
  .landing-root .ct-cell {
    padding: 22px 24px; border-bottom: 1px solid var(--line);
    font-size: 14.5px; color: var(--ink-2); line-height: 1.5;
  }
  .landing-root .ct-label { color: var(--ink); font-weight: 500;}
  .landing-root .ct-cell.hl { background: color-mix(in oklab, var(--accent-soft) 60%, transparent); color: var(--ink);}
  .landing-root .compare-table > *:nth-last-child(-n+3) { border-bottom: 0;}
  .landing-root .ct-cell .check {
    display: inline-flex; width: 16px; height: 16px; border-radius: 999px;
    background: var(--accent); margin-right: 8px; flex-shrink: 0;
    align-items: center; justify-content: center; vertical-align: -3px;
  }
  .landing-root .ct-cell .check::after { content: ""; width: 6px; height: 3px; border-left: 1.5px solid #fff; border-bottom: 1.5px solid #fff; transform: rotate(-45deg) translate(1px,-1px);}
  .landing-root .ct-cell .x {
    display: inline-flex; width: 16px; height: 16px; border-radius: 999px;
    background: rgba(26,24,21,0.06); margin-right: 8px; color: var(--ink-3);
    font-size: 10px; align-items: center; justify-content: center; vertical-align: -3px;
  }
  @media (max-width: 760px) {
    .landing-root .compare-table { grid-template-columns: 1fr;}
    .landing-root .compare-table > *:nth-last-child(-n+3) { border-bottom: 1px solid var(--line);}
    .landing-root .compare-table > *:last-child { border-bottom: 0;}
    .landing-root .ct-label { background: var(--surface-2); padding-top: 20px;}
  }

  /* ===== TESTIMONIALS ===== */
  .landing-root .testimonials { padding: 100px 0;}
  .landing-root .testimonials-head { text-align: center; margin-bottom: 60px; display: flex; flex-direction: column; align-items: center;}
  .landing-root .t-grid { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 20px;}
  .landing-root .t-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 20px; padding: 30px;
    display: flex; flex-direction: column; gap: 22px;
    box-shadow: var(--shadow-sm);
    transition: transform .3s, box-shadow .3s;
  }
  .landing-root .t-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-md);}
  .landing-root .t-card.featured {
    background: var(--accent-soft);
    border-color: color-mix(in oklab, var(--accent) 20%, transparent);
  }
  .landing-root .t-tag {
    display: inline-flex;
    font-family: "JetBrains Mono", monospace;
    font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--ink-3);
    padding: 5px 10px; border: 1px solid var(--line-2); border-radius: 999px;
    align-self: flex-start;
  }
  .landing-root .t-card.featured .t-tag { color: var(--accent); border-color: color-mix(in oklab, var(--accent) 25%, transparent);}
  .landing-root .t-quote {
    font-weight: 400;
    font-size: 19px; line-height: 1.4; color: var(--ink);
    letter-spacing: -0.012em; flex: 1; text-wrap: pretty;
  }
  .landing-root .t-card.featured .t-quote { font-size: 22px; font-weight: 450; letter-spacing: -0.02em;}
  .landing-root .t-author { display: flex; gap: 12px; align-items: center;}
  .landing-root .t-avatar {
    width: 40px; height: 40px; border-radius: 999px; flex-shrink: 0;
    background: linear-gradient(135deg,#60a5fa,#2f5fff);
    display: grid; place-items: center; color: white; font-weight: 600; font-size: 15px;
  }
  .landing-root .t-meta { display: flex; flex-direction: column;}
  .landing-root .t-name { font-size: 14.5px; font-weight: 500; color: var(--ink);}
  .landing-root .t-handle { font-size: 13px; color: var(--ink-3);}
  .landing-root .t-placeholder { opacity: .7;}
  .landing-root .t-placeholder .t-quote { color: var(--ink-3);}
  .landing-root .t-coming { font-family: "JetBrains Mono", monospace; font-size: 10.5px; color: var(--ink-3); letter-spacing: 0.1em; text-transform: uppercase; display: inline-flex; align-items: center; gap: 6px;}
  .landing-root .t-coming::before { content:""; width: 5px; height: 5px; border-radius: 999px; background: var(--ink-3); animation: pulse 2s infinite;}
  @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:.5;}}
  @media (max-width: 860px) { .landing-root .t-grid { grid-template-columns: 1fr;}}

  /* ===== FAQ ===== */
  .landing-root .faq { padding: 100px 0;}
  .landing-root .faq-head { text-align: center; margin-bottom: 50px; display: flex; flex-direction: column; align-items: center;}
  .landing-root .faq-list { border-top: 1px solid var(--line);}
  .landing-root .faq-item { border-bottom: 1px solid var(--line);}
  .landing-root .faq-q {
    width: 100%; background: none; border: 0; color: var(--ink);
    text-align: left; cursor: pointer;
    padding: 26px 0;
    display: flex; align-items: center; justify-content: space-between; gap: 20px;
    font-family: "Geist", sans-serif; font-weight: 500;
    font-size: clamp(18px, 2vw, 22px);
    letter-spacing: -0.025em;
    transition: color .2s;
  }
  .landing-root .faq-q:hover { color: var(--accent);}
  .landing-root .faq-icon {
    width: 32px; height: 32px; flex-shrink: 0;
    border: 1px solid var(--line-2); border-radius: 999px;
    display: grid; place-items: center;
    transition: transform .35s, background .2s, border-color .2s;
    position: relative;
  }
  .landing-root .faq-icon::before,
  .landing-root .faq-icon::after {
    content: ""; position: absolute; background: var(--ink-2);
    transition: transform .35s, opacity .3s, background .2s;
  }
  .landing-root .faq-icon::before { width: 11px; height: 1.5px;}
  .landing-root .faq-icon::after { width: 1.5px; height: 11px;}
  .landing-root .faq-item.open .faq-icon { background: var(--accent); border-color: var(--accent);}
  .landing-root .faq-item.open .faq-icon::before,
  .landing-root .faq-item.open .faq-icon::after { background: #fff;}
  .landing-root .faq-item.open .faq-icon::after { transform: rotate(90deg); opacity: 0;}
  .landing-root .faq-a {
    overflow: hidden; max-height: 0;
    transition: max-height .4s cubic-bezier(.2,.8,.2,1);
    color: var(--ink-2);
    font-size: 16px; line-height: 1.6;
  }
  .landing-root .faq-a-inner { padding: 0 0 28px; max-width: 70ch;}
  .landing-root .faq-item.open .faq-a { max-height: 500px;}
  .landing-root .faq-cta { margin-top: 50px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px;}
  .landing-root .faq-cta-sub { color: var(--ink-3); font-size: 13.5px;}

  /* ===== FINAL ===== */
  .landing-root .final { padding: 140px 0 110px; text-align: center; position: relative; overflow: hidden;}
  .landing-root .final::before {
    content: ""; position: absolute; left: 50%; top: 40%; transform: translate(-50%,-50%);
    width: 900px; height: 900px;
    background: radial-gradient(closest-side, var(--accent-soft), transparent 70%);
    z-index: 0;
  }
  .landing-root .final-inner { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 22px;}
  .landing-root .final h2 {
    font-family: "Geist", sans-serif; font-weight: 500;
    font-size: clamp(44px, 7vw, 88px); line-height: 1; letter-spacing: -0.05em;
    max-width: 16ch; text-wrap: balance;
  }
  .landing-root .final h2 .it { font-weight: 500; color: var(--accent);}
  .landing-root .final p { max-width: 58ch; color: var(--ink-2); font-size: 18px; text-wrap: pretty;}
  .landing-root .final-tag { color: var(--ink-3); font-size: 15.5px;}

  /* ===== FOOTER ===== */
  .landing-root footer { padding: 44px 0 56px; border-top: 1px solid var(--line);}
  .landing-root .foot { display: flex; flex-wrap: wrap; gap: 26px; align-items: center; justify-content: space-between;}
  .landing-root .foot-links { display: flex; gap: 22px;}
  .landing-root .foot-links a { color: var(--ink-3); text-decoration: none; font-size: 13.5px; transition: color .2s;}
  .landing-root .foot-links a:hover { color: var(--ink);}
  .landing-root .foot-copy { color: var(--ink-4); font-size: 12.5px;}
  .landing-root .foot-social a {
    width: 34px; height: 34px; border-radius: 999px;
    border: 1px solid var(--line-2); display: grid; place-items: center;
    color: var(--ink-2); transition: all .2s;
  }
  .landing-root .foot-social a:hover { color: var(--accent); border-color: var(--accent);}
  .landing-root .foot-social svg { width: 15px; height: 15px;}

  /* Reveal animation */
  .landing-root .reveal { opacity: 0; transform: translateY(22px); transition: opacity .8s cubic-bezier(.2,.8,.2,1), transform .8s cubic-bezier(.2,.8,.2,1);}
  .landing-root .reveal.in { opacity: 1; transform: none;}
  .landing-root .reveal.d1 { transition-delay: .08s;}
  .landing-root .reveal.d2 { transition-delay: .16s;}
  .landing-root .reveal.d3 { transition-delay: .24s;}
  .landing-root .reveal.d4 { transition-delay: .32s;}
`;
