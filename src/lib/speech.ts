// Lecture à voix haute via la synthèse vocale du navigateur (Web Speech API).
// Sert de source audio tant que de vrais enregistrements ne sont pas fournis.

export function canSpeak(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

export interface SpeechStep {
  text: string;
  /** Silence après cette phrase, en ms. */
  pauseMs: number;
}

/**
 * Lit les phrases l'une après l'autre. Renvoie une fonction d'arrêt. `onEnd` est
 * appelé à la fin (jamais après un arrêt volontaire), `onError` si la lecture échoue.
 */
export function speakSequence(steps: SpeechStep[], onEnd: () => void, onError: () => void): () => void {
  const synth = window.speechSynthesis;
  synth.cancel();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const pickVoice = () => {
    const voices = synth.getVoices();
    return voices.find((v) => v.lang === "en-US") ?? voices.find((v) => v.lang.startsWith("en"));
  };

  const play = (i: number) => {
    if (stopped) return;
    if (i >= steps.length) {
      onEnd();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(steps[i].text);
    utterance.lang = "en-US";
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = 0.95;
    utterance.onend = () => {
      timer = setTimeout(() => play(i + 1), steps[i].pauseMs);
    };
    utterance.onerror = (event) => {
      // « canceled » / « interrupted » : arrêt volontaire, pas une panne.
      if (stopped || event.error === "canceled" || event.error === "interrupted") return;
      stopped = true;
      onError();
    };
    synth.speak(utterance);
  };

  play(0);
  return () => {
    stopped = true;
    clearTimeout(timer);
    synth.cancel();
  };
}
