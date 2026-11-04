import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  "assets/js/lab-demo-context.js",
  "utf8"
);

function createBrowser(hash, existing = []) {
  const storage = new Map(existing);

  const root = {
    dataset: {
      trackingApi: "https://labcontrol.superwebapp.com/api"
    }
  };

  const context = {
    window: {
      location: {
        hash,
        origin: "https://netec-mx.github.io"
      }
    },
    document: {
      querySelector(selector) {
        return selector === "article.lab[data-tracking-api]"
          ? root
          : null;
      }
    },
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    URL,
    URLSearchParams,
    console
  };

  vm.runInNewContext(source, context);

  return {
    demo: context.window.LabControlDemo,
    storage
  };
}

const destination =
  "https://labcontrol.superwebapp.com/participant" +
  "?instructorSession=session-157";

function testReturn(label, url, expected) {
  const hash =
    "#lab-demo=session-157&lab-return=" +
    encodeURIComponent(url);

  const browser = createBrowser(hash);

  assert.equal(
    browser.demo.getReturnUrl(),
    expected
  );

  console.log("✓ " + label);
}

testReturn(
  "acepta la sesión y origen autorizados",
  destination,
  destination
);

testReturn(
  "rechaza dominios externos",
  "https://evil.example/participant?instructorSession=session-157",
  null
);

testReturn(
  "rechaza otra sesión",
  "https://labcontrol.superwebapp.com/participant?instructorSession=session-999",
  null
);

testReturn(
  "rechaza HTTP",
  "http://labcontrol.superwebapp.com/participant?instructorSession=session-157",
  null
);

testReturn(
  "rechaza credenciales en la URL",
  "https://user:pass@labcontrol.superwebapp.com/participant?instructorSession=session-157",
  null
);

const previous = createBrowser(
  "#lab-demo=session-999&lab-return=" +
  encodeURIComponent(
    "https://labcontrol.superwebapp.com/participant?instructorSession=session-999"
  )
);

const next = createBrowser(
  "#lab-demo=session-157",
  [...previous.storage]
);

assert.equal(next.demo.getReturnUrl(), null);
console.log("✓ no reutiliza el retorno de otra sesión");

console.log("Tests: 6 passed, 0 failed");
