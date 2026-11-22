import assert from "node:assert/strict";

import {
  parsePubSubNotification,
  receiptFromMetadata,
} from "../lib/fretgone/gmail-receipts";

const envelope = {
  message: {
    data: Buffer.from(
      JSON.stringify({ emailAddress: "CONTACT@FRETGONE.COM", historyId: "987" })
    ).toString("base64url"),
  },
};
assert.deepEqual(parsePubSubNotification(envelope), {
  emailAddress: "contact@fretgone.com",
  historyId: "987",
});

assert.throws(() => parsePubSubNotification({ message: { data: "not-json" } }));

const receipt = receiptFromMetadata(
  {
    id: "gmail-1",
    threadId: "thread-1",
    historyId: "988",
    internalDate: "1735689600000",
    payload: {
      mimeType: "text/plain",
      body: { data: Buffer.from("Please help begin HOA IDR.").toString("base64url") },
      headers: [
        { name: "From", value: "owner@example.com" },
        { name: "Cc", value: "contact@fretgone.com" },
        { name: "Subject", value: "A subject the homeowner rewrote" },
      ],
    },
  },
  "contact@fretgone.com"
);
assert.equal(receipt?.subject, "A subject the homeowner rewrote");
assert.equal(receipt?.body, "Please help begin HOA IDR.");

assert.equal(
  receiptFromMetadata(
    {
      id: "gmail-2",
      historyId: "989",
      payload: { headers: [{ name: "Subject", value: "Unrelated email" }] },
    },
    "contact@fretgone.com"
  ),
  null
);

console.log("fretgone Gmail receipt self-test: passed");
