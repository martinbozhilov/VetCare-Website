const VETCARE_CONTACT = {
  toEmail: 'hello@vetcare.bg',
  web3formsEndpoint: 'https://api.web3forms.com/submit',
  web3formsAccessKey: 'e18d1f2a-aad9-4407-bb36-ef1fe85f6e8a', // get at https://web3forms.com — tied to hello@vetcare.bg
};

// Backend demo-provisioning endpoint (app domain). Override per environment.
const VETCARE_DEMO_API = 'https://dev.vetcare.bg/api/demo/request';

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

    demoEmail: '', demoHoney: '', demoDone: false, demoErr: '', demoLoading: false,
    waitEmail: '', waitDone: false, waitErr: '', waitLoading: false,
    contactName: '', contactEmail: '', contactMessage: '',
    contactHoney: '', contactDone: false, contactErr: '', contactLoading: false,

    init() {
      window.addEventListener('scroll', () => {
        this.scrolled = window.scrollY > 12;
      }, { passive: true });
    },

    isEmailValid(v) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim());
    },
    async submitDemo(e) {
      e.preventDefault();
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
        } else if (res.status === 409) {
          this.demoErr = 'Вече съществува демо с този имейл — проверете пощата си или влезте.';
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
      if (!this.isEmailValid(this.waitEmail)) { this.waitErr = 'Моля, въведете валиден имейл адрес.'; return; }
      this.waitErr = '';
      this.waitLoading = true;
      try {
        await sendToWeb3Forms({ subject: 'Ранна покана – VetCare', form_name: 'Ранна покана', email: this.waitEmail });
        this.waitDone = true;
      } catch {
        this.waitErr = `Възникна грешка. Моля, опитайте отново или пишете ни на ${VETCARE_CONTACT.toEmail}.`;
      } finally {
        this.waitLoading = false;
      }
    },
    async submitContact(e) {
      e.preventDefault();
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
      } catch {
        this.contactErr = `Възникна грешка. Моля, опитайте отново или пишете ни на ${VETCARE_CONTACT.toEmail}.`;
      } finally {
        this.contactLoading = false;
      }
    },
  }));
});
