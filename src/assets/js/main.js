const VETCARE_CONTACT = {
  toEmail: 'hello@vetcare.bg',
  web3formsEndpoint: 'https://api.web3forms.com/submit',
  web3formsAccessKey: 'e18d1f2a-aad9-4407-bb36-ef1fe85f6e8a', // get at https://web3forms.com — tied to hello@vetcare.bg
};

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

    demoEmail: '', demoDone: false, demoErr: '', demoLoading: false,
    waitEmail: '', waitDone: false, waitErr: '', waitLoading: false,
    contactName: '', contactEmail: '', contactMessage: '',
    contactHoney: '', contactDone: false, contactErr: '', contactLoading: false,

    init() {
      this.scrolled = window.scrollY > 12;
      window.addEventListener('scroll', () => {
        this.scrolled = window.scrollY > 12;
      }, { passive: true });
    },

    isEmailValid(v) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim());
    },
    async submitDemo(e) {
      e.preventDefault();
      if (this.demoLoading) return;
      if (!this.isEmailValid(this.demoEmail)) { this.demoErr = 'Моля, въведете валиден имейл адрес.'; return; }
      this.demoErr = '';
      this.demoLoading = true;
      try {
        await sendToWeb3Forms({ subject: 'Заявка за демо – VetCare', form_name: 'Демо форма', email: this.demoEmail });
        this.demoDone = true;
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
      } catch {
        this.contactErr = `Възникна грешка. Моля, опитайте отново или пишете ни на ${VETCARE_CONTACT.toEmail}.`;
      } finally {
        this.contactLoading = false;
      }
    },
  }));
});
