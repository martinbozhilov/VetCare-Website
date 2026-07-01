document.addEventListener('alpine:init', () => {
  Alpine.data('vetcare', () => ({
    menuOpen: false,
    scrolled: false,
    faqOpen: null,

    demoEmail: '', demoDone: false, demoErr: false,
    waitEmail: '', waitDone: false, waitErr: false,
    contactName: '', contactEmail: '', contactMessage: '',
    contactHoney: '', contactDone: false, contactErr: '',

    init() {
      window.addEventListener('scroll', () => {
        this.scrolled = window.scrollY > 12;
      }, { passive: true });
    },

    isEmailValid(v) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim());
    },
    submitDemo(e) {
      e.preventDefault();
      if (!this.isEmailValid(this.demoEmail)) { this.demoErr = true; return; }
      this.demoErr = false;
      this.demoDone = true;
    },
    submitWait(e) {
      e.preventDefault();
      if (!this.isEmailValid(this.waitEmail)) { this.waitErr = true; return; }
      this.waitErr = false;
      this.waitDone = true;
    },
    submitContact(e) {
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
      this.contactDone = true;
    },
  }));
});
