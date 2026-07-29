const VETCARE_CONTACT = {
  toEmail: 'hello@vetcare.bg',
  web3formsEndpoint: 'https://api.web3forms.com/submit',
  web3formsAccessKey: 'e18d1f2a-aad9-4407-bb36-ef1fe85f6e8a', // get at https://web3forms.com — tied to hello@vetcare.bg
};

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
  Alpine.data('vetcare', () => ({
    menuOpen: false,
    scrolled: false,
    faqOpen: null,
    consentChoice: null,
    showConsent: false,

    demoEmail: '', demoHoney: '', demoDone: false, demoErr: '', demoLoading: false,
    waitEmail: '', waitDone: false, waitErr: '', waitLoading: false,
    contactName: '', contactEmail: '', contactMessage: '',
    contactHoney: '', contactDone: false, contactErr: '', contactLoading: false,

    init() {
      this.scrolled = window.scrollY > 12;
      this._scrollDepthFired = new Set();
      window.addEventListener('scroll', () => {
        this.scrolled = window.scrollY > 12;
        this.trackScrollDepth();
      }, { passive: true });

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

    trackScrollDepth() {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollable <= 0) return;
      const pct = (window.scrollY / scrollable) * 100;
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
      if (!this.isEmailValid(this.demoEmail)) { this.demoErr = 'Моля, въведете валиден имейл адрес.'; return; }
      this.demoErr = '';
      this.demoLoading = true;
      try {
        const res = await fetch(VETCARE_DEMO_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: this.demoEmail.trim(), website: this.demoHoney }),
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
      if (!this.isEmailValid(this.waitEmail)) { this.waitErr = 'Моля, въведете валиден имейл адрес.'; return; }
      this.waitErr = '';
      this.waitLoading = true;
      try {
        await sendToWeb3Forms({ subject: 'Ранна покана – VetCare', form_name: 'Ранна покана', email: this.waitEmail });
        this.waitDone = true;
        this.track('waitlist_submitted');
      } catch {
        this.waitErr = `Възникна грешка. Моля, опитайте отново или пишете ни на ${VETCARE_CONTACT.toEmail}.`;
      } finally {
        this.waitLoading = false;
      }
    },
    async submitContact(e) {
      e.preventDefault();
      if (this.contactLoading) return;
      if (this.contactHoney.trim()) { this.contactDone = true; return; }
      if (!this.isEmailValid(this.contactEmail)) {
        this.contactErr = 'Моля, въведете валиден имейл адрес.';
        return;
      }
      if (!this.contactMessage.trim()) {
        this.contactErr = 'Моля, напишете съобщение.';
        return;
      }
      this.contactErr = '';
      this.contactLoading = true;
      try {
        await sendToWeb3Forms({
          subject: 'Съобщение от контакти – VetCare',
          form_name: 'Контактна форма',
          name: this.contactName,
          email: this.contactEmail,
          message: this.contactMessage,
        });
        this.contactDone = true;
        this.track('contact_submitted');
      } catch {
        this.contactErr = `Възникна грешка. Моля, опитайте отново или пишете ни на ${VETCARE_CONTACT.toEmail}.`;
      } finally {
        this.contactLoading = false;
      }
    },
  }));
});
