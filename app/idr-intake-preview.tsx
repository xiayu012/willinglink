"use client";

import { useState } from "react";
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

const openingByState: Partial<Record<string, string>> = {
  // California Civil Code §§5900–5915, https://dre.ca.gov/files/pdf/relaw/excerpts.pdf
  California:
    "I'm formally requesting Internal Dispute Resolution (IDR) under California Civil Code §5910.",
  // Virginia uses an association complaint procedure, with its own scope and forms.
  // https://law.lis.virginia.gov/vacode/title54.1/chapter23.3/section54.1-2354.4/
  Virginia:
    "I'd like to raise a concern with the association. Could you share your written complaint procedure under Virginia Code §54.1-2354.4 and let me know which form to use?",
};

const generalOpening =
  "I'd like to resolve a concern through the HOA's internal process. Could you let me know how to submit a written request?";

export function IdrIntakePreview() {
  const [state, setState] = useState("");
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({});
  const draft =
    drafts[state] ??
    (state ? `Dear HOA,\n\n${openingByState[state] ?? generalOpening}` : "");

  return (
    <div className={styles.idrFields}>
      <label>
        <span className="sr-only">Property state</span>
        <select
          value={state}
          onChange={(event) => setState(event.target.value)}
        >
          <option value="" disabled>
            Select a state
          </option>
          {states.map((state) => (
            <option key={state}>{state}</option>
          ))}
        </select>
      </label>
      <fieldset className={styles.idrProviders}>
        <legend>Which email provider do you use?</legend>
        <div>
          {providers.map((provider) => (
            <label key={provider}>
              <input type="radio" name="idr-email-provider" value={provider} />
              {provider}
            </label>
          ))}
        </div>
      </fieldset>
      <textarea
        className={styles.idrDraft}
        aria-label="Email draft to your HOA"
        rows={8}
        value={draft}
        onChange={(event) => {
          const value = event.target.value;
          setDrafts((previous) => ({ ...previous, [state]: value }));
        }}
      />
    </div>
  );
}
