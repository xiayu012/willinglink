"use client";

import { Mic } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import styles from "./home.module.css";

const states =
  "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia".split(
    "|"
  );
const providers = [
  "Gmail",
  "Outlook / Hotmail",
  "Yahoo Mail",
  "iCloud Mail",
  "AOL Mail",
  "Proton Mail",
  "Other",
];

type Recognition = {
  start(): void;
  stop(): void;
  abort(): void;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
};

export function IdrIntakePreview() {
  const input = useRef<HTMLTextAreaElement>(null);
  const recognition = useRef<Recognition | null>(null);
  const [description, setDescription] = useState("");
  const [listening, setListening] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    function cancel() {
      if (location.hash === "#idr-preview") return;
      const active = recognition.current;
      recognition.current = null;
      active?.abort();
      setListening(false);
      setNotice("");
    }
    window.addEventListener("hashchange", cancel);
    return () => {
      window.removeEventListener("hashchange", cancel);
      const active = recognition.current;
      recognition.current = null;
      active?.abort();
    };
  }, []);

  function dictate() {
    if (recognition.current) {
      recognition.current.stop();
      return;
    }
    const support = window as unknown as {
      SpeechRecognition?: new () => Recognition;
      webkitSpeechRecognition?: new () => Recognition;
    };
    const Speech = support.SpeechRecognition ?? support.webkitSpeechRecognition;
    function fallback() {
      setNotice(
        "Web dictation is unavailable. Type here or use your device’s dictation. On a phone, look for the microphone on your keyboard."
      );
      input.current?.focus();
    }
    if (!Speech) {
      fallback();
      return;
    }
    try {
      const active = new Speech();
      recognition.current = active;
      active.lang = navigator.language || "en-US";
      active.onresult = (event) => {
        if (recognition.current !== active) return;
        const words = Array.from(
          event.results,
          (result) => result[0]?.transcript ?? ""
        )
          .join(" ")
          .trim();
        if (words)
          setDescription(
            (previous) =>
              previous.trimEnd() + (previous.trim() ? " " : "") + words
          );
        setNotice("");
      };
      active.onerror = () => {
        if (recognition.current === active) fallback();
      };
      active.onend = () => {
        if (recognition.current !== active) return;
        recognition.current = null;
        setListening(false);
        setNotice((previous) => (previous === "Listening…" ? "" : previous));
      };
      active.start();
      setListening(true);
      setNotice("Listening…");
    } catch {
      recognition.current = null;
      fallback();
    }
  }

  return (
    <div className={styles.idrIntake}>
      <div className={styles.idrFields}>
        <label>
          Property state
          <select defaultValue="">
            <option value="" disabled>
              Select a state
            </option>
            {states.map((state) => (
              <option key={state}>{state}</option>
            ))}
          </select>
        </label>
        <label>
          Your email provider
          <select defaultValue="">
            <option value="" disabled>
              Select a provider
            </option>
            {providers.map((provider) => (
              <option key={provider}>{provider}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        What happened?
        <textarea
          ref={input}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Tell us what happened and what you’d like to resolve."
          rows={7}
        />
      </label>
      <button className={styles.idrVoice} type="button" onClick={dictate}>
        <Mic size={27} aria-hidden="true" />
        {listening ? "Stop dictation" : "Speak instead"}
      </button>
      <p className={styles.idrVoiceHint}>
        Dictation uses your browser’s speech service.
      </p>
      {notice && (
        <p className={styles.idrVoiceHint} role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
