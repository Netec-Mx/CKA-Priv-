import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  "assets/js/lab-demo-context.js",
  "utf8"
);

const origin = "https://labcontrol.superwebapp.com";
const sessionId = "session-157";
const returnUrl =
  `${origin}/participant?instructorSession=${sessionId}`;

function createBrowser(hash) {
  const storage = new Map();
  const elements = [];

  const root = {
    dataset: {
      trackingApi: `${origin}/api`
    },
    prepend(element) {
      elements.unshift(element);
    }
  };

  const document = {
    querySelector(selector) {
      if (
        selector === "article.lab" ||
        selector === "article.lab[data-tracking-api]"
      ) {
        return root;
      }
      return null;
    },
    getElementById(id) {
      return elements.find(element => element.id === id) ?? null;
    },
    createElement(tag) {
      return {
        tag,
        style: {},
        children: [],
        append(...children) {
          this.children.push(...children);
        }
      };
    }
  };

  const context = {
    window: {
      location: {
        hash,
        origin: "https://netec-mx.github.io"
      }
    },
    document,
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
    elements,
    storage
  };
}

const instructor = createBrowser(
  `#lab-demo=${sessionId}&lab-return=${encodeURIComponent(returnUrl)}`
);

instructor.demo.renderReturnLink();

assert.equal(instructor.elements.length, 1);
assert.equal(instructor.elements[0].id, "instructor-demo-return");
assert.equal(instructor.elements[0].children[1].href, returnUrl);
console.log("✓ muestra el regreso a la sesión correcta");

instructor.demo.renderReturnLink();
assert.equal(instructor.elements.length, 1);
console.log("✓ no duplica el enlace");

const participant = createBrowser(
  "#lab-access=participant-token"
);

participant.demo.renderReturnLink();
assert.equal(participant.elements.length, 0);
console.log("✓ no aparece para participantes");

const invalid = createBrowser(
  `#lab-demo=${sessionId}&lab-return=${encodeURIComponent(
    "https://otro.example/participant?instructorSession=session-157"
  )}`
);

invalid.demo.renderReturnLink();
assert.equal(invalid.elements.length, 0);
console.log("✓ no aparece con una URL no autorizada");

console.log("Tests: 4 passed, 0 failed");
