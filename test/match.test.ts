import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GIVEAWAYS } from "../src/instagram/giveaways.ts";
import { captionKeywords, exactKeyword, keywordFromPayload, mentions, parseTime, payloadFor } from "../src/instagram/match.ts";
import { validSignature } from "../src/instagram/signature.ts";
import { createHmac } from "node:crypto";

const known = new Set(["GUIDE", "TEST", "UI", "KEY"]);

describe("captionKeywords", () => {
  it("reads the keyword a caption asks for", () => {
    assert.deepEqual(captionKeywords("Comment GUIDE and I'll send you the guide 👇", known), ["GUIDE"]);
  });
  it("takes quotes and any case", () => {
    assert.deepEqual(captionKeywords("comment “guide” below", known), ["GUIDE"]);
  });
  it("ignores words that aren't keywords", () => {
    assert.deepEqual(captionKeywords("Comment below if you tried it. Comment your stack!", known), []);
  });
  it("finds every keyword asked for", () => {
    assert.deepEqual(captionKeywords("Comment UI for the links. Comment KEY for the prompt.", known), ["UI", "KEY"]);
  });
});

describe("mentions", () => {
  it("matches the keyword as a word, in any case, next to emoji or punctuation", () => {
    assert.equal(mentions("Guide 🙏", "GUIDE"), true);
    assert.equal(mentions("guide!", "GUIDE"), true);
    assert.equal(mentions("send me the guide one please", "GUIDE"), true);
  });
  it("doesn't match inside other words", () => {
    assert.equal(mentions("guides", "GUIDE"), false);
    assert.equal(mentions("contest", "TEST"), false);
    assert.equal(mentions("build", "UI"), false);
  });
});

describe("exactKeyword", () => {
  it("accepts a DM that is only the keyword", () => {
    assert.equal(exactKeyword("guide 🙏", known), "GUIDE");
    assert.equal(exactKeyword("  KEY. ", known), "KEY");
    assert.equal(exactKeyword("ＧＵＩＤＥ", known), "GUIDE");
  });
  it("leaves any longer message for a human", () => {
    assert.equal(exactKeyword("guide please", known), null);
    assert.equal(exactKeyword("I'll test it later", known), null);
    assert.equal(exactKeyword("", known), null);
  });
});

describe("payloads", () => {
  it("round-trips a known keyword and rejects anything else", () => {
    assert.equal(keywordFromPayload(payloadFor("GUIDE"), known), "GUIDE");
    assert.equal(keywordFromPayload("GIVE:NOPE", known), null);
    assert.equal(keywordFromPayload("something else", known), null);
    assert.equal(keywordFromPayload(undefined, known), null);
  });
});

describe("parseTime", () => {
  it("reads Instagram's +0000 timestamps", () => {
    assert.equal(parseTime("2026-11-17T10:00:00+0000"), Date.UTC(2026, 10, 17, 10, 0, 0));
  });
});

describe("validSignature", () => {
  const body = Buffer.from('{"object":"instagram"}');
  const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("accepts a signature made with either configured secret", () => {
    assert.equal(validSignature(body, sign("ig-secret"), ["ig-secret", "meta-secret"]), true);
    assert.equal(validSignature(body, sign("meta-secret"), ["ig-secret", "meta-secret"]), true);
  });
  it("rejects a wrong, missing or malformed signature", () => {
    assert.equal(validSignature(body, sign("other"), ["ig-secret"]), false);
    assert.equal(validSignature(body, null, ["ig-secret"]), false);
    assert.equal(validSignature(body, "md5=abc", ["ig-secret"]), false);
    assert.equal(validSignature(body, sign("ig-secret"), []), false);
  });
});

describe("data/giveaways.json", () => {
  it("has every giveaway as one DM within Instagram's 1,000 bytes", () => {
    assert.ok(Object.keys(GIVEAWAYS).length > 0);
    for (const [keyword, g] of Object.entries(GIVEAWAYS)) {
      assert.ok(g.promise, keyword);
      assert.equal(g.messages.length, 1, `${keyword} is ${g.messages.length} messages: trim ${g.source}`);
      const size = Buffer.byteLength(g.messages[0], "utf8");
      assert.ok(size <= 1000, `${keyword}: ${size} bytes`);
    }
  });
});
