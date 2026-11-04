import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  "assets/js/lab-demo-context.js",
  "utf8"
);

function createBrowser() {
  const data = new Map();

  let hash = "#lab-demo=session-157";
  let referrer = "";
  let navigationType = "navigate";

  const location = {
    origin: "https://curso.example.test",
    get hash() { return hash; }
  };

  const context = {
    window: {
      location,
      performance: {
        getEntriesByType() {
          return [{ type: navigationType }];
        }
      }
    },
    document: {
      get referrer() { return referrer; }
    },
    sessionStorage: {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
      removeItem: key => data.delete(key)
    },
    URLSearchParams,
    URL
  };

  vm.runInNewContext(source, context);

  return {
    demo: context.window.LabControlDemo,
    setHash: value => { hash = value; },
    setReferrer: value => { referrer = value; },
    setNavigationType: value => { navigationType = value; }
  };
}

const browser = createBrowser();

assert.equal(browser.demo.isActive(), true);
console.log("✓ entrada explícita activa la demostración");

browser.setHash("#lab-demo=session-157");

assert.equal(browser.demo.isActive(), true);
console.log("✓ navegación explícita conserva la demostración");

browser.setHash("");

assert.equal(browser.demo.isActive(), false);
console.log("✓ navegación sin lab-demo no hereda una demostración");

browser.setHash("#lab-access=participant-token");
assert.equal(browser.demo.isActive(), false);
console.log("✓ acceso oficial desactiva la demostración");

browser.setHash("");
browser.setReferrer("");

assert.equal(browser.demo.isActive(), false);
console.log("✓ acceso normal no hereda el contexto anterior");

console.log("Tests: 5 passed, 0 failed");
