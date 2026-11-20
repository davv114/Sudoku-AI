/**
 * Tutor vocale basato sulla Web Speech API (funzionalità bonus).
 * Legge ad alta voce la spiegazione della mossa, scegliendo una voce italiana.
 */

export class SpeechEngine {
  constructor() {
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.enabled = false;
    this.voices = [];
    this.voice = null;
    this.utterance = null;
    this.loadVoices();
    if (this.supported) {
      window.speechSynthesis.addEventListener?.('voiceschanged', () => {
        this.loadVoices();
      });
    }
  }

  loadVoices() {
    if (!this.supported) return;
    this.voices = window.speechSynthesis.getVoices() ?? [];
    if (!this.voices.length) return;
    const italian = this.voices.filter((voice) => /^it(-|_)/i.test(voice.lang));
    const preferred =
      italian.find((voice) => /^(it[-_]IT)/i.test(voice.lang) && /google|microsoft|elsa|alice/i.test(voice.name)) ??
      italian[0] ??
      this.voices.find((voice) => /italian|italiano/i.test(voice.name)) ??
      null;
    this.voice = preferred;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.stop();
  }

  speak(text, force = false) {
    if (!this.supported || (!this.enabled && !force) || !text) return false;
    try {
      this.stop();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'it-IT';
      utterance.rate = 0.98;
      utterance.pitch = 1.02;
      if (this.voice) utterance.voice = this.voice;
      this.utterance = utterance;
      window.speechSynthesis.speak(utterance);
      return true;
    } catch {
      return false;
    }
  }

  stop() {
    if (!this.supported) return;
    window.speechSynthesis.cancel();
    this.utterance = null;
  }
}
