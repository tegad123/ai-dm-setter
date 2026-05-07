'use client';

// ---------------------------------------------------------------------------
// LandingPage
// ---------------------------------------------------------------------------
// Ported from the /v1/design bundle (qualifydm-s/project/landing.html).
// Matches the Chronicle-inspired design the user iterated to: warm neutral
// palette (#f3f3f3), Geist sans-serif, blue accent, pinstripe background
// with horizontal-sweep mask animation, iPhone-framed IG DM mockups.
//
// Changes from the original HTML prototype:
//   - Removed the design-tool "Tweaks" edit-mode panel (not needed in prod)
//   - Calendly CTAs → /auth/sign-up route
//   - qualifydms.io/auth/* links → /auth/sign-in and /auth/sign-up
//   - Wrapped all top-level selectors in a .landing-root scope so the CSS
//     doesn't leak onto the Clerk auth pages or dashboard
//
// Interactivity (ported from the inline <script>):
//   - FAQ accordion toggle (useEffect click handlers)
//   - IntersectionObserver-driven .reveal animations
//   - Smooth anchor scroll for in-page links
// ---------------------------------------------------------------------------

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { LANDING_CSS } from './landing-styles';

export function LandingPage() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    // Scroll-reveal via IntersectionObserver — same threshold + rootMargin
    // as the original prototype.
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -5% 0px' }
    );
    root.querySelectorAll('.reveal').forEach((el) => io.observe(el));

    // FAQ accordion — clicking a question opens it, closes any other
    // currently-open item (only one open at a time).
    const faqButtons = Array.from(
      root.querySelectorAll<HTMLButtonElement>('.faq-q')
    );
    const faqHandlers = faqButtons.map((btn) => {
      const handler = () => {
        const item = btn.closest('.faq-item');
        if (!item) return;
        const wasOpen = item.classList.contains('open');
        root
          .querySelectorAll('.faq-item.open')
          .forEach((i) => i.classList.remove('open'));
        if (!wasOpen) item.classList.add('open');
      };
      btn.addEventListener('click', handler);
      return { btn, handler };
    });

    // Smooth anchor scrolling for #hash links (How It Works / FAQ / etc.)
    const anchors = Array.from(
      root.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')
    );
    const anchorHandlers = anchors.map((a) => {
      const handler = (e: Event) => {
        const id = a.getAttribute('href')?.slice(1);
        if (!id) return;
        const el = document.getElementById(id);
        if (el) {
          e.preventDefault();
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      };
      a.addEventListener('click', handler);
      return { a, handler };
    });

    return () => {
      io.disconnect();
      faqHandlers.forEach(({ btn, handler }) =>
        btn.removeEventListener('click', handler)
      );
      anchorHandlers.forEach(({ a, handler }) =>
        a.removeEventListener('click', handler)
      );
    };
  }, []);

  return (
    <div ref={rootRef} className='landing-root' data-accent='blue'>
      <style dangerouslySetInnerHTML={{ __html: LANDING_CSS }} />
      <div className='bg-pinstripes' aria-hidden='true' />

      {/* ─── NAV ───────────────────────────────────── */}
      <div className='nav-wrap'>
        <nav className='nav'>
          <a href='#' className='logo'>
            <span className='logo-mark'>Q</span>QualifyDMs
          </a>
          <div className='nav-links'>
            <a href='#how'>How It Works</a>
            <a href='#testimonials'>Testimonials</a>
            <a href='#faq'>FAQ</a>
            <a href='#contact'>Contact</a>
          </div>
          <div className='nav-auth'>
            <Link href='/auth/sign-in' className='nav-signin'>
              Sign in
            </Link>
            <Link href='/auth/sign-up' className='nav-cta'>
              Sign up
            </Link>
          </div>
        </nav>
      </div>

      {/* ─── HERO ──────────────────────────────────── */}
      <section className='hero'>
        <div className='wrap'>
          <span className='pill reveal'>
            <span className='pill-icon pill-icon-ig' aria-label='Instagram'>
              <svg
                viewBox='0 0 24 24'
                fill='none'
                stroke='white'
                strokeWidth='1.8'
                aria-hidden='true'
              >
                <rect x='3' y='3' width='18' height='18' rx='5' />
                <circle cx='12' cy='12' r='4' />
                <circle cx='17.5' cy='6.5' r='1.1' fill='white' />
              </svg>
            </span>
            <span className='pill-icon pill-icon-fb' aria-label='Facebook'>
              <svg viewBox='0 0 24 24' fill='white' aria-hidden='true'>
                <path d='M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06C2 17.08 5.66 21.25 10.44 22v-7.03H7.9v-2.9h2.54V9.85c0-2.52 1.49-3.91 3.78-3.91 1.1 0 2.24.2 2.24.2v2.47h-1.26c-1.24 0-1.63.78-1.63 1.57v1.88h2.78l-.44 2.9h-2.34V22C18.34 21.25 22 17.08 22 12.06Z' />
              </svg>
            </span>
          </span>

          <h1 className='reveal d1'>
            Every lead that goes <span className='it'>cold</span>
            <br />
            in your DMs is{' '}
            <span className='acc'>revenue you&apos;ll never get back.</span>
          </h1>

          <p className='hero-sub reveal d2'>
            We build AI-powered DM sales systems that qualify leads, send voice
            notes in your voice, and book calls — 24 hours a day, 7 days a week.
          </p>

          <p className='hero-tag reveal d3'>
            Every lead that goes unanswered is a call that never gets booked.
          </p>

          <div className='hero-cta reveal d3'>
            <Link href='/auth/sign-up' className='btn btn-primary btn-lg'>
              Book a Free 30-Min Call
              <svg
                className='arrow'
                width='16'
                height='16'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2'
              >
                <path d='M5 12h14M13 5l7 7-7 7' />
              </svg>
            </Link>
          </div>

          <div className='hero-meta reveal d4'>
            <span>
              <svg
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2.5'
              >
                <path d='M5 13l4 4L19 7' />
              </svg>
              No signup
            </span>
            <span>
              <svg
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2.5'
              >
                <path d='M5 13l4 4L19 7' />
              </svg>
              No commitment
            </span>
            <span>
              <svg
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2.5'
              >
                <path d='M5 13l4 4L19 7' />
              </svg>
              30 minutes
            </span>
          </div>
        </div>
      </section>

      {/* ─── PROBLEM ───────────────────────────────── */}
      <section className='problem' id='problem'>
        <div className='wrap'>
          <div className='problem-head reveal'>
            <span className='eyebrow'>The Problem</span>
            <h2 className='section-h'>
              You already know
              <br />
              <span className='it'>the problem.</span>
            </h2>
          </div>

          <div className='problems-list'>
            <div className='problem-item reveal'>
              <div className='problem-num'>01</div>
              <p className='problem-body'>
                A lead DMs you at <em>11pm</em>. Your setter is asleep. By
                morning the lead followed two competitors and forgot about you.
                That call never gets booked.
              </p>
            </div>
            <div className='problem-item reveal'>
              <div className='problem-num'>02</div>
              <p className='problem-body'>
                Your setter goes <em>off-script</em>. Sends the booking link
                before qualifying. Your closer sits on a call with someone who
                has $200 to their name. An hour wasted.
              </p>
            </div>
            <div className='problem-item reveal'>
              <div className='problem-num'>03</div>
              <p className='problem-body'>
                Your best setter <em>quits</em>. Two months of training walks
                out the door. You start over with someone new who doesn&apos;t
                know your offer, your voice, or your leads.
              </p>
            </div>
          </div>

          <p className='problem-closer reveal'>
            The real question is <span className='dash'>—</span> what are{' '}
            <span className='it'>you</span> doing about it.
          </p>
        </div>
      </section>

      {/* ─── FEATURES ──────────────────────────────── */}
      <section className='features' id='how'>
        <div className='wrap'>
          <div className='features-head reveal'>
            <span className='eyebrow'>How We Fix It</span>
            <h2 className='section-h center'>
              How we fix <span className='acc'>your DMs.</span>
            </h2>
            <p className='section-sub center'>
              Everything you need to stop losing leads and start booking calls
              on autopilot.
            </p>
          </div>

          {/* Feature 1 — Voice / rapport */}
          <FeatureOne />

          {/* Feature 2 — 24/7 inbox */}
          <FeatureTwo />

          {/* Feature 3 — Smart routing */}
          <FeatureThree />
        </div>
      </section>

      {/* ─── STATS ─────────────────────────────────── */}
      <section className='stats'>
        <div className='wrap'>
          <div className='stats-grid reveal'>
            <div className='stat'>
              <div className='stat-num'>
                &lt;60<span className='it'>s</span>
              </div>
              <div className='stat-label'>
                Average first response time to new leads.
              </div>
            </div>
            <div className='stat'>
              <div className='stat-num'>
                24<span className='it'>/</span>7
              </div>
              <div className='stat-label'>
                DMs handled around the clock, every day.
              </div>
            </div>
            <div className='stat'>
              <div className='stat-num'>
                100<span className='it'>%</span>
              </div>
              <div className='stat-label'>
                Script adherence — every lead, every conversation.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── COMPARE ───────────────────────────────── */}
      <section className='compare'>
        <div className='wrap'>
          <div className='compare-head reveal'>
            <span className='eyebrow'>The Math</span>
            <h2 className='section-h center'>
              Stop paying for <span className='acc'>inconsistency.</span>
            </h2>
          </div>

          <div className='compare-table reveal'>
            <div className='ct-head'></div>
            <div className='ct-head'>Human DM Setter</div>
            <div className='ct-head hl'>QualifyDMs AI</div>

            <div className='ct-label'>Response time</div>
            <div className='ct-cell'>
              <span className='x'>×</span>Minutes to hours. Leads go cold.
            </div>
            <div className='ct-cell hl'>
              <span className='check'></span>Under 60 seconds. Every time.
            </div>

            <div className='ct-label'>Availability</div>
            <div className='ct-cell'>
              <span className='x'>×</span>8–10 hours a day if you&apos;re lucky.
            </div>
            <div className='ct-cell hl'>
              <span className='check'></span>24/7/365. Never misses a lead.
            </div>

            <div className='ct-label'>Voice notes</div>
            <div className='ct-cell'>
              <span className='x'>×</span>Manual recording when they feel like
              it.
            </div>
            <div className='ct-cell hl'>
              <span className='check'></span>AI-cloned, triggered automatically
              at the right moments.
            </div>

            <div className='ct-label'>Capital screening</div>
            <div className='ct-cell'>
              <span className='x'>×</span>Inconsistent. Sometimes skipped
              entirely.
            </div>
            <div className='ct-cell hl'>
              <span className='check'></span>Every lead screened before touching
              your calendar.
            </div>

            <div className='ct-label'>Script adherence</div>
            <div className='ct-cell'>
              <span className='x'>×</span>Goes off-script. Sends links too
              early. Skips steps.
            </div>
            <div className='ct-cell hl'>
              <span className='check'></span>Follows your exact methodology
              every single time.
            </div>

            <div className='ct-label'>When they quit</div>
            <div className='ct-cell'>
              <span className='x'>×</span>Months of training walks out the door.
            </div>
            <div className='ct-cell hl'>
              <span className='check'></span>Your AI keeps improving. Never
              leaves.
            </div>

            <div className='ct-label'>Cost</div>
            <div className='ct-cell'>
              <span className='x'>×</span>$1,500–$3,000/mo + commission per
              booking.
            </div>
            <div className='ct-cell hl'>
              <span className='check'></span>A fraction of the cost.
            </div>
          </div>
        </div>
      </section>

      {/* ─── TESTIMONIALS ──────────────────────────── */}
      <section className='testimonials' id='testimonials'>
        <div className='wrap'>
          <div className='testimonials-head reveal'>
            <span className='eyebrow'>Proof</span>
            <h2 className='section-h center'>
              What our <span className='acc'>clients say.</span>
            </h2>
            <p className='section-sub center'>
              High-ticket creators automating their DM sales with QualifyDMs.
            </p>
          </div>

          <div className='t-grid'>
            <div className='t-card featured reveal'>
              <span className='t-tag'>Day Trading Education</span>
              <p className='t-quote'>
                &ldquo;The AI handles my DMs better than any setter I&apos;ve
                hired. It follows the script, qualifies properly, and never
                takes a day off. My team just focuses on closing.&rdquo;
              </p>
              <div className='t-author'>
                <div className='t-avatar'>D</div>
                <div className='t-meta'>
                  <span className='t-name'>Dae .E</span>
                  <span className='t-handle'>@Daetradez</span>
                </div>
              </div>
            </div>

            <div className='t-card t-placeholder reveal d1'>
              <span className='t-tag'>Fitness Coaching</span>
              <p className='t-quote'>
                &ldquo;Your testimonial, right here. We&apos;re onboarding new
                clients weekly.&rdquo;
              </p>
              <div className='t-author'>
                <div
                  className='t-avatar'
                  style={{ background: 'var(--bg-3)', color: 'var(--ink-3)' }}
                >
                  —
                </div>
                <div className='t-meta'>
                  <span className='t-coming'>Coming soon</span>
                </div>
              </div>
            </div>

            <div className='t-card t-placeholder reveal d2'>
              <span className='t-tag'>Business Coaching</span>
              <p className='t-quote'>
                &ldquo;Your testimonial, right here. We&apos;re onboarding new
                clients weekly.&rdquo;
              </p>
              <div className='t-author'>
                <div
                  className='t-avatar'
                  style={{ background: 'var(--bg-3)', color: 'var(--ink-3)' }}
                >
                  —
                </div>
                <div className='t-meta'>
                  <span className='t-coming'>Coming soon</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── FAQ ───────────────────────────────────── */}
      <section className='faq' id='faq'>
        <div className='wrap-narrow'>
          <div className='faq-head reveal'>
            <span className='eyebrow'>FAQ</span>
            <h2 className='section-h center'>
              Frequently asked <span className='acc'>questions.</span>
            </h2>
            <p className='section-sub center'>
              Common questions before booking a call.
            </p>
          </div>

          <div className='faq-list reveal'>
            {FAQ_ITEMS.map((item) => (
              <div key={item.q} className='faq-item'>
                <button className='faq-q' type='button'>
                  {item.q}
                  <span className='faq-icon'></span>
                </button>
                <div className='faq-a'>
                  <div className='faq-a-inner'>{item.a}</div>
                </div>
              </div>
            ))}
          </div>

          <div className='faq-cta reveal'>
            <Link href='/auth/sign-up' className='btn btn-primary btn-lg'>
              Book Free 30-Min Call
              <svg
                className='arrow'
                width='16'
                height='16'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2'
              >
                <path d='M5 12h14M13 5l7 7-7 7' />
              </svg>
            </Link>
            <span className='faq-cta-sub'>
              Free consultation • No commitment required
            </span>
          </div>
        </div>
      </section>

      {/* ─── FINAL CTA ─────────────────────────────── */}
      <section className='final' id='contact'>
        <div className='wrap final-inner'>
          <h2 className='reveal'>
            Ready to stop <span className='it'>losing leads?</span>
          </h2>
          <p className='reveal d1'>
            Book a free 30-minute strategy call. We&apos;ll show you exactly how
            QualifyDMs works on a live account with real conversations.
          </p>
          <div className='reveal d2'>
            <Link href='/auth/sign-up' className='btn btn-primary btn-lg'>
              Book Free Strategy Call
              <svg
                className='arrow'
                width='16'
                height='16'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2'
              >
                <path d='M5 12h14M13 5l7 7-7 7' />
              </svg>
            </Link>
          </div>
          <p className='final-tag reveal d3'>
            Every lead that goes unanswered is a call that never gets booked.
          </p>
        </div>
      </section>

      {/* ─── FOOTER ────────────────────────────────── */}
      <footer>
        <div className='wrap foot'>
          <a href='#' className='logo'>
            <span className='logo-mark'>Q</span>QualifyDMs
          </a>
          <div className='foot-links'>
            <a href='#'>Home</a>
            <Link href='/privacy'>Privacy</Link>
            <a href='#contact'>Contact</a>
          </div>
          <div className='foot-social'>
            <a href='#' aria-label='Instagram'>
              <svg
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='1.8'
              >
                <rect x='2' y='2' width='20' height='20' rx='5' />
                <path d='M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37zM17.5 6.5h.01' />
              </svg>
            </a>
          </div>
          <div className='foot-copy'>© 2026 QualifyDMs</div>
        </div>
      </footer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Feature section components — each renders a bento card with an
// iPhone IG-DM mockup + a floating overlay card showing the AI's
// current state (stage chip / live inbox / routing card).
// ─────────────────────────────────────────────────────────────

const IG_ICONS = (
  <div className='ig-actions'>
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
    >
      <path d='M15 10l5-3v10l-5-3M3 6h12v12H3z' />
    </svg>
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
    >
      <path d='M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z' />
    </svg>
  </div>
);

const IG_INPUT = (
  <div className='ig-input'>
    <div className='ig-input-field'>Message...</div>
    <div className='ig-input-icons'>
      <svg
        viewBox='0 0 24 24'
        fill='none'
        stroke='currentColor'
        strokeWidth='1.8'
      >
        <rect x='3' y='3' width='18' height='18' rx='2' />
        <circle cx='8.5' cy='8.5' r='1.5' />
        <path d='M21 15l-5-5L5 21' />
      </svg>
      <svg
        viewBox='0 0 24 24'
        fill='none'
        stroke='currentColor'
        strokeWidth='1.8'
      >
        <path d='M12 19c3.87 0 7-3.13 7-7V6a7 7 0 0 0-14 0v6c0 3.87 3.13 7 7 7zM12 19v3' />
      </svg>
    </div>
  </div>
);

function FeatureOne() {
  return (
    <div className='feature-row reveal'>
      <div className='feat-copy'>
        <span className='feat-num'>Your Voice, Your Style</span>
        <h3>
          Trained on YOUR <span className='it'>real conversations.</span>
        </h3>
        <p className='feat-sub'>
          Not a generic chatbot. An AI that sells the way you sell.
        </p>
        <ul className='feat-bullets'>
          <li className='feat-bullet'>
            <span className='dot'></span>Upload your best DM conversations — the
            AI learns your voice, your slang, your energy
          </li>
          <li className='feat-bullet'>
            <span className='dot'></span>Mirrors how you handle objections,
            build rapport, and move leads forward
          </li>
          <li className='feat-bullet'>
            <span className='dot'></span>Gets smarter every week as you review
            and correct its responses
          </li>
        </ul>
      </div>
      <div className='feat-visual'>
        <div className='bento'>
          <div className='overlay-card stage-chip'>
            <div className='title'>Learning from you</div>
            <div className='stage-item done'>
              <span className='sq'></span>Tone · casual
            </div>
            <div className='stage-item done'>
              <span className='sq'></span>Emoji · sparingly
            </div>
            <div className='stage-item done'>
              <span className='sq'></span>Slang · &ldquo;tbh&rdquo;,
              &ldquo;fr&rdquo;
            </div>
            <div className='stage-item active'>
              <span className='sq'></span>Objection · price
            </div>
            <div className='stage-item'>
              <span className='sq'></span>Hook · story
            </div>
            <div className='stage-item'>
              <span className='sq'></span>Match score · 94%
            </div>
          </div>
          <div className='phone-wrap'>
            <div className='phone'>
              <div className='phone-screen'>
                <div className='phone-notch'></div>
                <div className='ig-bar'>
                  <div className='ig-back'>‹</div>
                  <div className='ig-avatar'>Y</div>
                  <div className='ig-user'>
                    <span className='ig-name'>yourbrand</span>
                    <span className='ig-active'>Active now</span>
                  </div>
                  {IG_ICONS}
                </div>
                <div className='ig-thread'>
                  <div className='ts'>Today 10:42 PM</div>
                  <div className='bubble them'>
                    saw your story about the 2-min scalping setup 🔥 does it
                    actually work for someone starting out?
                  </div>
                  <div className='bubble me'>
                    yo appreciate you sliding in 🙌
                  </div>
                  <div className='bubble me'>
                    def works tbh — but only if you follow the rules fr. what do
                    you currently do for work?
                  </div>
                  <div className='bubble them'>
                    software sales rn, kinda burned out tho
                  </div>
                  <div className='bubble me'>
                    feel that. sales bg = you already get discipline, big head
                    start
                  </div>
                  <div className='bubble me'>
                    what would hitting $10k/mo trading actually change for you?
                  </div>
                  <div className='stage-label'>
                    · voice match · 94% · your tone ·
                  </div>
                  <div className='typing'>
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
                {IG_INPUT}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FeatureTwo() {
  return (
    <div className='feature-row reverse reveal'>
      <div className='feat-copy'>
        <span className='feat-num'>Always On</span>
        <h3>
          Every lead. Instantly. <span className='it'>24/7.</span>
        </h3>
        <p className='feat-sub'>
          Your leads don&apos;t wait. Neither does your AI.
        </p>
        <ul className='feat-bullets'>
          <li className='feat-bullet'>
            <span className='dot'></span>Responds to every DM in under 60
            seconds — day, night, weekends, holidays
          </li>
          <li className='feat-bullet'>
            <span className='dot'></span>Handles story replies, ad responses,
            cold DMs, and referrals simultaneously
          </li>
          <li className='feat-bullet'>
            <span className='dot'></span>No more leads going cold because your
            setter was asleep, busy, or &ldquo;didn&apos;t see it&rdquo;
          </li>
        </ul>
      </div>
      <div className='feat-visual'>
        <div className='bento'>
          <div className='overlay-card inbox-card'>
            <div className='title'>
              Live inbox{' '}
              <span className='inbox-pulse'>
                <span></span>all replied
              </span>
            </div>
            {INBOX_ROWS.map((r) => (
              <div key={r.name} className='inbox-row'>
                <div
                  className='inbox-av'
                  style={{ background: r.avatarGradient }}
                >
                  {r.initial}
                </div>
                <div className='inbox-meta'>
                  <div className='inbox-name'>
                    {r.name} <span className='inbox-src'>· {r.source}</span>
                  </div>
                  <div className='inbox-preview'>&ldquo;{r.preview}&rdquo;</div>
                </div>
                <div className='inbox-time'>
                  <div className='stamp'>{r.stamp}</div>
                  <div className='reply'>replied in {r.replyTime}</div>
                </div>
              </div>
            ))}
          </div>
          <div className='phone-wrap'>
            <div className='phone'>
              <div className='phone-screen'>
                <div className='phone-notch'></div>
                <div className='ig-bar'>
                  <div className='ig-back'>‹</div>
                  <div
                    className='ig-avatar'
                    style={{
                      background: 'linear-gradient(135deg,#a78bfa,#22d3ee)'
                    }}
                  >
                    K
                  </div>
                  <div className='ig-user'>
                    <span className='ig-name'>kai.builds</span>
                    <span className='ig-active'>Active now</span>
                  </div>
                  {IG_ICONS}
                </div>
                <div className='ig-thread'>
                  <div className='ts'>Today 4:02 AM</div>
                  <div className='bubble them'>
                    yo you up? saw your reel. curious how the system works for
                    someone with a 9-5
                  </div>
                  <div className='stage-label'>· received 4:02:11 AM ·</div>
                  <div className='bubble me'>
                    yeah man, up late grinding 🌙 9-5 is actually the perfect
                    starting point tbh
                  </div>
                  <div className='bubble me'>
                    what&apos;s your schedule look like — mornings or evenings
                    free?
                  </div>
                  <div className='stage-label'>
                    · sent 4:02:58 AM ·{' '}
                    <strong style={{ color: 'var(--accent)' }}>47s</strong> ·
                  </div>
                  <div className='bubble them'>
                    wait this is actually you replying?
                  </div>
                </div>
                {IG_INPUT}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FeatureThree() {
  return (
    <div className='feature-row reveal'>
      <div className='feat-copy'>
        <span className='feat-num'>Smart Routing</span>
        <h3>
          Screen before <span className='it'>you sell.</span>
        </h3>
        <p className='feat-sub'>
          Every lead gets qualified before they ever touch your calendar.
        </p>
        <ul className='feat-bullets'>
          <li className='feat-bullet'>
            <span className='dot'></span>Asks about capital and budget directly
            in the DMs — no awkward guessing
          </li>
          <li className='feat-bullet'>
            <span className='dot'></span>Qualified leads get routed to your
            application form or booking link automatically
          </li>
          <li className='feat-bullet'>
            <span className='dot'></span>Unqualified leads get offered a
            downsell product or free resource — nothing falls through the cracks
          </li>
        </ul>
      </div>
      <div className='feat-visual'>
        <div className='bento'>
          <div className='overlay-card route-card'>
            <div className='rc-title'>Lead screening</div>
            <div className='rc-row'>
              <span>Lead</span>
              <strong>@jenna_mvmt</strong>
            </div>
            <div className='rc-row'>
              <span>Goal</span>
              <strong>$15k/mo</strong>
            </div>
            <div className='rc-row'>
              <span>Capital</span>
              <strong>$4,500</strong>
            </div>
            <div className='rc-row'>
              <span>Status</span>
              <span className='rc-badge'>Qualified</span>
            </div>
            <div className='rc-cta'>→ Route to application</div>
          </div>
          <div className='phone-wrap'>
            <div className='phone'>
              <div className='phone-screen'>
                <div className='phone-notch'></div>
                <div className='ig-bar'>
                  <div className='ig-back'>‹</div>
                  <div
                    className='ig-avatar'
                    style={{
                      background: 'linear-gradient(135deg,#34d399,#60a5fa)'
                    }}
                  >
                    J
                  </div>
                  <div className='ig-user'>
                    <span className='ig-name'>jenna_mvmt</span>
                    <span className='ig-active'>Active now</span>
                  </div>
                  {IG_ICONS}
                </div>
                <div className='ig-thread'>
                  <div className='ts'>Today 9:05 AM</div>
                  <div className='bubble me'>
                    last thing before i loop you in with the team
                  </div>
                  <div className='bubble me'>
                    what do you have set aside to invest in yourself and this
                    journey?
                  </div>
                  <div className='bubble them'>
                    around 4-5k is what i&apos;m working with rn
                  </div>
                  <div className='bubble me'>
                    perfect, that&apos;s plenty to get started 💪
                  </div>
                  <div className='stage-label'>· Capital · confirmed ·</div>
                  <div
                    className='bubble me grad'
                    style={{ padding: '10px 14px' }}
                  >
                    <strong style={{ fontWeight: 600 }}>
                      Book your intro call
                    </strong>
                    <br />
                    <span style={{ opacity: 0.85, fontSize: '11.5px' }}>
                      qualifydms.io/apply/jenna
                    </span>
                  </div>
                  <div className='bubble them'>booking now 🙏</div>
                </div>
                {IG_INPUT}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const INBOX_ROWS = [
  {
    initial: 'M',
    name: 'marcus.ftns',
    source: 'story reply',
    preview: 'damn okay that was actually helpful 😂',
    stamp: '2:14 AM',
    replyTime: '38s',
    avatarGradient: 'linear-gradient(135deg,#f59e0b,#e1306c)'
  },
  {
    initial: 'J',
    name: 'jenna_mvmt',
    source: 'ad response',
    preview: 'booking now 🙏',
    stamp: '3:47 AM',
    replyTime: '22s',
    avatarGradient: 'linear-gradient(135deg,#34d399,#60a5fa)'
  },
  {
    initial: 'K',
    name: 'kai.builds',
    source: 'cold DM',
    preview: 'wait this is actually you replying?',
    stamp: '4:02 AM',
    replyTime: '47s',
    avatarGradient: 'linear-gradient(135deg,#a78bfa,#22d3ee)'
  },
  {
    initial: 'S',
    name: 'sierra.moves',
    source: 'referral',
    preview: 'heard about you from @mike',
    stamp: '5:31 AM',
    replyTime: '19s',
    avatarGradient: 'linear-gradient(135deg,#fb7185,#f97316)'
  }
];

const FAQ_ITEMS = [
  {
    q: 'Who is this for?',
    a: "High-ticket course sellers and coaches who use Instagram DMs as a sales channel. If you're selling programs at $1,000+ and currently use human DM setters (or wish you had one), this is built for you. Trading, fitness, real estate, e-commerce, coaching, agency — any high-ticket education business."
  },
  {
    q: 'How does the AI sound human?',
    a: "Three things make it work: (1) It's trained on YOUR real DM conversations so it learns your voice, your slang, and your energy. (2) It sends AI-cloned voice notes that sound like you. (3) It texts like a real person — lowercase, short messages, natural pacing. Leads don't know they're talking to AI."
  },
  {
    q: 'Can I take over a conversation?',
    a: "Yes, instantly. One click pauses the AI and you (or your team) handle the conversation. When you're done, hand it back. The AI picks up right where you left off."
  },
  {
    q: 'How long does setup take?',
    a: 'We handle everything. You give us your sales script, your best DM conversations, and a voice sample. We configure your AI persona, test it, and launch. Most accounts are live within a week.'
  },
  {
    q: 'What if the AI gets stuck or makes a mistake?',
    a: 'Your operator dashboard shows real-time alerts for any conversation that needs attention — stuck conversations, leads showing distress, delivery issues. You check once a day and handle the exceptions. The AI handles everything else.'
  },
  {
    q: 'How much does it cost?',
    a: "Pricing depends on your volume and needs. Book a free strategy call and we'll walk you through your options. We guarantee it's a fraction of what you're paying human setters."
  },
  {
    q: 'What happens to unqualified leads?',
    a: "They don't just disappear. The AI offers them a lower-ticket product or free resource so you still capture value from every conversation. Nothing falls through the cracks."
  }
];
