const VETCARE_CONTACT = {
  toEmail: 'hello@vetcare.bg',
  web3formsEndpoint: 'https://api.web3forms.com/submit',
  web3formsAccessKey: 'e18d1f2a-aad9-4407-bb36-ef1fe85f6e8a', // get at https://web3forms.com — tied to hello@vetcare.bg
};

// Scroll distance, in px, that flips the sticky demo bar. Scrolling down is reading, so the bar
// gets out of the way almost immediately; scrolling up is re-evaluating, which is the moment a
// call to action is wanted rather than resented. The up threshold is the larger of the two so
// iOS momentum jitter and rubber-banding can't flicker the bar in and out.
const VC_CTA_REVEAL_UP = 24;
const VC_CTA_REVEAL_DOWN = 6;
// How long the bar stays suppressed after a programmatic scroll: goTo()/scrollToTop() move the
// page upward, which would otherwise read as the "user is looking for something" gesture.
const VC_CTA_SCROLL_LOCK_MS = 700;

// Sections in document order, for the mobile orientation strip under the header. The hero (#top)
// is deliberately absent: the strip only appears once the hero is off screen, so the count starts
// at the first section a reader actually scrolls into. Ids must match <section id> in index.html.
const VC_SECTIONS = [
  { id: 'problemi', label: 'Проблемът' },
  { id: 'kak-raboti', label: 'Как работи' },
  { id: 'polzi', label: 'Ползи' },
  { id: 'istoriya', label: 'История' },
  { id: 'waitlist', label: 'Ранна покана' },
  { id: 'ceni', label: 'Цени' },
  { id: 'demo', label: 'Демо' },
  { id: 'chesti-vaprosi', label: 'Въпроси' },
  { id: 'kontakti', label: 'Контакти' },
];

// Backend demo-provisioning endpoint, resolved per environment:
//   1. an explicit <meta name="vetcare-demo-api" content="..."> (set per deploy) always wins;
//   2. otherwise auto-detected from the current host (local dev / dev VPS);
//   3. else same-origin /api/demo/request (deployments that proxy /api to the app).
function resolveDemoApi() {
  const meta = document.querySelector('meta[name="vetcare-demo-api"]');
  const configured = meta && meta.content && meta.content.trim();
  if (configured) {
    return configured;
  }
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:5500/api/demo/request';
  }
  if (host === 'dev.vetcare.bg') {
    return 'https://dev.vetcare.bg/api/demo/request';
  }
  return `${window.location.origin}/api/demo/request`;
}
const VETCARE_DEMO_API = resolveDemoApi();

const VETCARE_ANALYTICS = {
  posthogKey: 'phc_B5rBY3ZG9ytQVQoGjTDzcmLg2LdLFyAzNaz2ugk6ewbq', // public project key from eu.posthog.com
  apiHost: 'https://eu.i.posthog.com',
  uiHost: 'https://eu.posthog.com',
};
const analyticsEnabled = () => !VETCARE_ANALYTICS.posthogKey.startsWith('REPLACE_WITH');

const VC_CONSENT_KEY = 'vc-analytics-consent';
let posthogLoadPromise = null;

function loadPostHog() {
  if (!analyticsEnabled()) return Promise.reject(new Error('Analytics disabled'));
  if (posthogLoadPromise) return posthogLoadPromise;
  posthogLoadPromise = new Promise((resolve, reject) => {
    if (window.posthog && window.posthog.__loaded) { resolve(window.posthog); return; }
    const script = document.createElement('script');
    script.src = 'https://eu-assets.i.posthog.com/static/array.js';
    script.async = true;
    script.onload = () => {
      window.posthog.init(VETCARE_ANALYTICS.posthogKey, {
        api_host: VETCARE_ANALYTICS.apiHost,
        ui_host: VETCARE_ANALYTICS.uiHost,
        person_profiles: 'identified_only',
        capture_pageview: true,
        autocapture: true,
        opt_out_capturing_by_default: true,
        disable_session_recording: true,
        maskAllInputs: true,
      });
      resolve(window.posthog);
    };
    script.onerror = () => reject(new Error('Failed to load posthog-js'));
    document.head.appendChild(script);
  });
  return posthogLoadPromise;
}

// ── hCaptcha ────────────────────────────────────────────────────────────────────────────────────
// web3forms/client/script.js does NOT render the widgets itself: it stamps its own free-plan
// sitekey onto every [data-captcha="true"] element and injects hCaptcha's api.js, forwarding the
// data-lang / data-render / data-onload attributes as ?hl / ?render / ?onload. We ask it for
// `render=explicit` + `onload=vcCaptchaReady` so the widgets are created here instead of by
// hCaptcha's auto-render. That's what makes the two forms independently controllable:
// hcaptcha.render() hands back a widget id, whereas auto-rendered widgets leave us guessing, and a
// bare hcaptcha.reset()/execute() would act on the *first* widget on the page — the other form's.
//
// The contact form uses a normal checkbox widget; the waitlist is invisible (a captcha box under a
// single email field costs more conversions than it's worth), so its challenge is triggered from
// submitWait via hcaptcha.execute() and only actually shows a puzzle when hCaptcha wants one.
const VETCARE_CAPTCHA = {
  // Fallback only — web3forms/client/script.js sets data-sitekey on each container before api.js
  // loads, and that value wins so a key rotation on their side doesn't need a change here.
  sitekey: '50b2fe65-b00b-4b9e-ad62-3ba471098be2',
  widgets: { contact: null, wait: null }, // hCaptcha widget ids, filled in by vcCaptchaReady
};

// Named on window because it's what ?onload= in hCaptcha's api.js URL resolves against. Declared at
// module scope (not inside alpine:init) so it exists before api.js finishes loading.
window.vcCaptchaReady = function vcCaptchaReady() {
  for (const [name, opts] of [['contact', {}], ['wait', { size: 'invisible' }]]) {
    const el = document.querySelector(`[data-vc-captcha="${name}"]`);
    if (!el) continue;
    VETCARE_CAPTCHA.widgets[name] = window.hcaptcha.render(el, {
      sitekey: el.dataset.sitekey || VETCARE_CAPTCHA.sitekey,
      ...opts,
    });
  }
};

const captchaReady = (name) => VETCARE_CAPTCHA.widgets[name] !== null && !!window.hcaptcha;

// Returns the token for a form, or '' if the user hasn't satisfied the captcha. For the invisible
// widget this opens the challenge and waits; for the checkbox one it just reads what's already
// there. Web3Forms verifies the token only if it travels in the payload — the plain-HTML POST gets
// it for free from the form encoding, but this site submits JSON and has to send it explicitly.
async function captchaToken(name) {
  const id = VETCARE_CAPTCHA.widgets[name];
  if (name !== 'wait') return window.hcaptcha.getResponse(id) || '';
  try {
    const { response } = await window.hcaptcha.execute(id, { async: true });
    return response || '';
  } catch {
    // Thrown when the user closes or fails the challenge — not an error worth its own message.
    return '';
  }
}

// A token is single-use, so a submission that failed after Web3Forms saw it leaves the widget
// holding a spent token; reset it or the retry fails too.
function resetCaptcha(name) {
  const id = VETCARE_CAPTCHA.widgets[name];
  if (id !== null && window.hcaptcha) window.hcaptcha.reset(id);
}

async function sendToWeb3Forms(fields) {
  const res = await fetch(VETCARE_CONTACT.web3formsEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ access_key: VETCARE_CONTACT.web3formsAccessKey, ...fields }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.message || 'Web3Forms submission failed');
}

document.addEventListener('alpine:init', () => {
  // The three "how it works" steps already look like a vertical tab list; this makes them behave
  // like one — roving tabindex plus arrow keys, so a keyboard user reaches the panel in two keys
  // instead of tabbing through every step.
  Alpine.data('vetcareSteps', () => ({
    activeStep: 0,
    stepCount: 3,
    move(delta) {
      this.activeStep = (this.activeStep + delta + this.stepCount) % this.stepCount;
      this.$refs[`tab${this.activeStep}`]?.focus();
    },
    jump(index) {
      this.activeStep = index;
      this.$refs[`tab${index}`]?.focus();
    },
  }));

  Alpine.data('vetcare', () => ({
    menuOpen: false,
    scrolled: false,
    faqOpen: null,
    consentChoice: null,
    showConsent: false,

    activeSection: 'top',
    scrollProgress: 0,
    // Plain "is on screen" for the sections the sticky demo button has to keep out of: the hero and
    // the demo form show the same call to action, the waitlist and contact forms have their own
    // submit button that the bar would otherwise float over. #ceni is deliberately absent — the
    // pricing cards carry no button of their own, so there the bar is the only action available.
    // Seeded so the button stays hidden over the hero even before the observer's first callback.
    onScreen: { top: true, demo: false, waitlist: false, kontakti: false },
    // Set by updateCtaReveal() from the scroll direction; see VC_CTA_REVEAL_UP.
    ctaRevealed: false,

    demoEmail: '', demoHoney: '', demoDone: false, demoErr: '', demoLoading: false,
    waitEmail: '', waitDone: false, waitErr: '', waitLoading: false,
    contactName: '', contactEmail: '', contactMessage: '',
    contactHoney: '', contactDone: false, contactErr: '', contactLoading: false,

    init() {
      this.scrolled = window.scrollY > 12;
      this._scrollDepthFired = new Set();
      this._inBand = {}; // section id -> is inside the "currently reading" band; not reactive
      this._lastY = Math.max(window.scrollY, 0);
      this._ctaDelta = 0;      // px travelled in the current direction, reset on every flip
      this._ctaLockUntil = 0;  // epoch ms; see VC_CTA_SCROLL_LOCK_MS
      this.updateScrollProgress();
      window.addEventListener('scroll', () => {
        this.scrolled = window.scrollY > 12;
        this.updateScrollProgress();
        this.updateCtaReveal();
        this.trackScrollDepth();
      }, { passive: true });

      this.initSectionSpy();
      // The menu is a full-height overlay on phones — letting the page scroll behind it loses the
      // reader's place.
      this.$watch('menuOpen', (open) => {
        document.documentElement.classList.toggle('vc-no-scroll', open);
      });

      this.consentChoice = localStorage.getItem(VC_CONSENT_KEY);
      if (analyticsEnabled() && this.consentChoice === 'accepted') {
        loadPostHog().then((ph) => {
          ph.opt_in_capturing();
          ph.startSessionRecording();
        });
      } else if (analyticsEnabled() && !this.consentChoice) {
        this.showConsent = true;
      }
    },

    // ── Orientation ───────────────────────────────────────────────────────────────────────────
    // Two observers rather than one, because the two questions need different framings: the nav
    // highlight wants a narrow band under the header ("what am I reading?"), the sticky button
    // wants plain visibility ("is the demo form already on screen?").
    initSectionSpy() {
      const sections = Array.from(document.querySelectorAll('main section[id]'));
      if (!sections.length || !('IntersectionObserver' in window)) return;

      // A section is current from the moment it clears the header until it leaves the top 45% of
      // the viewport. The topmost match wins, so a short section can't steal the highlight from
      // the long one still filling the screen.
      const spy = new IntersectionObserver((entries) => {
        entries.forEach((e) => { this._inBand[e.target.id] = e.isIntersecting; });
        const current = sections.find((s) => this._inBand[s.id]);
        if (current) this.activeSection = current.id;
      }, { rootMargin: '-88px 0px -55% 0px' });
      sections.forEach((s) => spy.observe(s));

      const presence = new IntersectionObserver((entries) => {
        entries.forEach((e) => { this.onScreen[e.target.id] = e.isIntersecting; });
      }, { threshold: 0 });
      Object.keys(this.onScreen).forEach((id) => {
        const el = document.getElementById(id);
        if (el) presence.observe(el);
      });
    },

    updateScrollProgress() {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      this.scrollProgress = scrollable > 0 ? Math.min(window.scrollY / scrollable, 1) : 0;
    },

    // Distance is accumulated per direction rather than acted on per event: a single scroll event
    // can be one pixel, and reacting to each one would make the bar flicker on the smallest wobble.
    // A change of direction restarts the count, so only sustained travel flips the bar.
    updateCtaReveal() {
      const y = Math.max(window.scrollY, 0);
      const delta = y - this._lastY;
      this._lastY = y;
      if (!delta) return;
      if (Date.now() < this._ctaLockUntil) { this._ctaDelta = 0; return; }

      this._ctaDelta = (this._ctaDelta < 0) === (delta < 0) ? this._ctaDelta + delta : delta;
      if (this._ctaDelta <= -VC_CTA_REVEAL_UP) {
        this.ctaRevealed = true;
        this._ctaDelta = 0;
      } else if (this._ctaDelta >= VC_CTA_REVEAL_DOWN) {
        this.ctaRevealed = false;
        this._ctaDelta = 0;
      }
    },

    isActive(id) {
      return this.activeSection === id;
    },
    // Set on click so the strip and the menu update the instant you tap, instead of waiting for
    // the smooth scroll to land the section in the band.
    goTo(id) {
      this.menuOpen = false;
      this.activeSection = id;
      this.lockCtaReveal();
    },

    // Jumping to an anchor above the current position scrolls the page upward, which is the same
    // signal updateCtaReveal() reads as "show the bar" — so silence it for the length of the ride.
    lockCtaReveal() {
      this.ctaRevealed = false;
      this._ctaDelta = 0;
      this._ctaLockUntil = Date.now() + VC_CTA_SCROLL_LOCK_MS;
    },

    get currentSection() {
      return VC_SECTIONS.find((s) => s.id === this.activeSection) || null;
    },
    get sectionNumber() {
      return VC_SECTIONS.findIndex((s) => s.id === this.activeSection) + 1;
    },
    get sectionTotal() {
      return VC_SECTIONS.length;
    },
    // Shown only while the reader is scrolling back up (ctaRevealed) and only where nothing else
    // already offers the next step: redundant over the hero and the demo form, and in the way of
    // the waitlist and contact forms, whose own submit buttons sit exactly where the bar lands.
    // Also out of the way while the menu or the consent banner is open.
    get showStickyCta() {
      return this.ctaRevealed
        && !this.onScreen.top && !this.onScreen.demo
        && !this.onScreen.waitlist && !this.onScreen.kontakti
        && !this.menuOpen && !this.showConsent;
    },

    scrollToTop() {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
      this.activeSection = 'top';
      this.lockCtaReveal();
      // The button disappears on arrival, so keyboard focus has to go somewhere sensible —
      // otherwise it falls back to <body> and the next Tab starts from the top of the tab order.
      const main = document.getElementById('main-content');
      if (main) main.focus({ preventScroll: true });
    },

    // Reads scrollProgress instead of measuring again: updateScrollProgress() runs first in the
    // same scroll handler, and scrollHeight is a layout-forcing read worth doing only once.
    trackScrollDepth() {
      const pct = this.scrollProgress * 100;
      if (pct <= 0) return;
      [25, 50, 75, 100].forEach((threshold) => {
        if (pct >= threshold && !this._scrollDepthFired.has(threshold)) {
          this._scrollDepthFired.add(threshold);
          this.track('scroll_depth', { percent: threshold });
        }
      });
    },

    toggleFaq(i) {
      const opening = this.faqOpen !== i;
      this.faqOpen = opening ? i : null;
      if (opening) this.track('faq_opened', { index: i });
    },

    acceptAnalytics() {
      localStorage.setItem(VC_CONSENT_KEY, 'accepted');
      this.consentChoice = 'accepted';
      this.showConsent = false;
      if (analyticsEnabled()) {
        loadPostHog().then((ph) => {
          ph.opt_in_capturing();
          ph.startSessionRecording();
          ph.capture('cookie_consent_given', { source: 'consent_banner' });
        });
      }
    },
    declineAnalytics() {
      localStorage.setItem(VC_CONSENT_KEY, 'declined');
      this.consentChoice = 'declined';
      this.showConsent = false;
      if (window.posthog && window.posthog.__loaded) {
        window.posthog.opt_out_capturing();
        if (window.posthog.stopSessionRecording) window.posthog.stopSessionRecording();
      }
    },
    openConsent() {
      this.showConsent = true;
    },
    track(name, props) {
      if (!analyticsEnabled() || this.consentChoice !== 'accepted') return;
      if (!window.posthog || !window.posthog.__loaded) return;
      window.posthog.capture(name, props);
    },

    isEmailValid(v) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim());
    },
    async submitDemo(e) {
      e.preventDefault();
      if (this.demoLoading) return;
      if (this.demoHoney.trim()) { this.demoDone = true; return; }
      // The form is novalidate (the native bubble isn't translatable), so empty and malformed are
      // told apart here and the field is focused the way native validation used to do it.
      const email = this.demoEmail.trim();
      if (!email) {
        this.demoErr = 'Моля, въведете имейл адрес.';
        this.$refs.demoEmailInput?.focus();
        return;
      }
      if (!this.isEmailValid(email)) {
        this.demoErr = 'Моля, въведете валиден имейл адрес.';
        this.$refs.demoEmailInput?.focus();
        return;
      }
      this.demoErr = '';
      this.demoLoading = true;
      try {
        const res = await fetch(VETCARE_DEMO_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, website: this.demoHoney }),
        });
        if (res.ok) {
          this.demoDone = true;
          this.track('demo_submitted');
        } else if (res.status === 409) {
          this.demoErr = 'Вече съществува демо с този имейл — проверете пощата си.';
        } else if (res.status === 429) {
          this.demoErr = 'Твърде много опити. Моля, опитайте отново по-късно.';
        } else {
          this.demoErr = `Възникна грешка. Моля, опитайте отново или пишете ни на ${VETCARE_CONTACT.toEmail}.`;
        }
      } catch {
        this.demoErr = `Възникна грешка. Моля, опитайте отново или пишете ни на ${VETCARE_CONTACT.toEmail}.`;
      } finally {
        this.demoLoading = false;
      }
    },
    async submitWait(e) {
      e.preventDefault();
      if (this.waitLoading) return;
      // novalidate form (see index.html) — empty and malformed are told apart here so the message
      // is Bulgarian, and the field is focused the way native validation used to do it.
      const email = this.waitEmail.trim();
      if (!email) {
        this.waitErr = 'Моля, въведете имейл адрес.';
        this.$refs.waitEmailInput?.focus();
        return;
      }
      if (!this.isEmailValid(email)) {
        this.waitErr = 'Моля, въведете валиден имейл адрес.';
        this.$refs.waitEmailInput?.focus();
        return;
      }
      if (!captchaReady('wait')) {
        this.waitErr = `Проверката „не съм робот“ не се зареди. Презаредете страницата или ни пишете на ${VETCARE_CONTACT.toEmail}.`;
        return;
      }
      this.waitErr = '';
      // The invisible widget may open a challenge here, so show the loading state around it too —
      // otherwise the button looks idle while hCaptcha's overlay is up.
      this.waitLoading = true;
      try {
        const token = await captchaToken('wait');
        if (!token) {
          this.waitErr = 'Моля, потвърдете, че не сте робот.';
          return;
        }
        await sendToWeb3Forms({
          subject: 'Ранна покана – VetCare',
          form_name: 'Ранна покана',
          email,
          'h-captcha-response': token,
        });
        this.waitDone = true;
        this.track('waitlist_submitted');
      } catch {
        this.waitErr = `Възникна грешка. Моля, опитайте отново или пишете ни на ${VETCARE_CONTACT.toEmail}.`;
        resetCaptcha('wait');
      } finally {
        this.waitLoading = false;
      }
    },
    async submitContact(e) {
      e.preventDefault();
      if (this.contactLoading) return;
      if (this.contactHoney.trim()) { this.contactDone = true; return; }
      // novalidate form (see index.html) — empty and malformed are told apart here so the messages
      // are Bulgarian, and the offending field is focused the way native validation used to do it.
      const email = this.contactEmail.trim();
      const message = this.contactMessage.trim();
      if (!email) {
        this.contactErr = 'Моля, въведете имейл адрес.';
        this.$refs.contactEmailInput?.focus();
        return;
      }
      if (!this.isEmailValid(email)) {
        this.contactErr = 'Моля, въведете валиден имейл адрес.';
        this.$refs.contactEmailInput?.focus();
        return;
      }
      if (!message) {
        this.contactErr = 'Моля, напишете съобщение.';
        this.$refs.contactMsgInput?.focus();
        return;
      }
      // Captcha last: the token is single-use, so checking it before the fields would make a user
      // with a typo'd email solve the puzzle twice.
      if (!captchaReady('contact')) {
        this.contactErr = `Проверката „не съм робот“ не се зареди. Презаредете страницата или ни пишете на ${VETCARE_CONTACT.toEmail}.`;
        return;
      }
      const token = await captchaToken('contact');
      if (!token) {
        this.contactErr = 'Моля, потвърдете, че не сте робот.';
        return;
      }
      this.contactErr = '';
      this.contactLoading = true;
      try {
        await sendToWeb3Forms({
          subject: 'Съобщение от контакти – VetCare',
          form_name: 'Контактна форма',
          name: this.contactName,
          email,
          message,
          'h-captcha-response': token,
        });
        this.contactDone = true;
        this.track('contact_submitted');
      } catch {
        this.contactErr = `Възникна грешка. Моля, опитайте отново или пишете ни на ${VETCARE_CONTACT.toEmail}.`;
        resetCaptcha('contact');
      } finally {
        this.contactLoading = false;
      }
    },
  }));
});
