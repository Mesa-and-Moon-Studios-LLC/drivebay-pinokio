import assert from "node:assert/strict";
import test from "node:test";
import { verifyFirebaseIdToken } from "../app/src/lib/files/linked-cloud.mjs";

function jwt(payload) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(payload)}.sig`;
}

const config = { apiKey: "web-key", projectId: "mesa-demo", authEmulator: "" };

test("a Firebase ID token is checked with accounts:lookup, not oauth2 tokeninfo", async () => {
  const token = jwt({ aud: "mesa-demo", sub: "uid-1", email: "a@b.co" });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => ({ users: [{ localId: "uid-1", email: "a@b.co", displayName: "Ada" }] }) };
  };
  const result = await verifyFirebaseIdToken(token, config, fetchImpl);
  assert.deepEqual(result, { uid: "uid-1", email: "a@b.co", displayName: "Ada" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/identitytoolkit\.googleapis\.com\/v1\/accounts:lookup\?key=web-key$/);
  assert.equal(JSON.parse(calls[0].init.body).idToken, token);
  assert.equal(calls[0].url.includes("tokeninfo"), false);
});

test("a rejected, foreign-project, or mismatched token is not accepted", async () => {
  const ok = async () => ({ ok: true, json: async () => ({ users: [{ localId: "uid-1", email: "a@b.co" }] }) });
  const rejected = async () => ({ ok: false, json: async () => ({}) });
  const down = async () => {
    throw new Error("offline");
  };
  assert.equal(await verifyFirebaseIdToken(jwt({ aud: "mesa-demo", sub: "uid-1" }), config, rejected), null);
  assert.equal(await verifyFirebaseIdToken(jwt({ aud: "mesa-demo", sub: "uid-1" }), config, down), null);
  assert.equal(await verifyFirebaseIdToken(jwt({ aud: "other-project", sub: "uid-1" }), config, ok), null);
  assert.equal(await verifyFirebaseIdToken(jwt({ aud: "mesa-demo", sub: "uid-2" }), config, ok), null);
  assert.equal(await verifyFirebaseIdToken("not-a-jwt", config, ok), null);
});
