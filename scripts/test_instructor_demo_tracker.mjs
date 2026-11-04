import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  "assets/js/lab-tracker.js",
  "utf8"
);

const accessTokenKey = "netec:participantAccessToken";
const originalToken = "existing-participant-token";

const sessionData = new Map([
  [accessTokenKey, originalToken]
]);

const localData = new Map();
const listeners = [];
const requests = [];

const sessionStorage = {
  getItem: key => sessionData.get(key) ?? null,
  setItem: (key, value) => sessionData.set(key, value),
  removeItem: key => sessionData.delete(key)
};

const localStorage = {
  getItem: key => localData.get(key) ?? null,
  setItem: (key, value) => localData.set(key, value),
  removeItem: key => localData.delete(key)
};

const steps = [{
  dataset: {
    taskId: "t001",
    stepId: "s001"
  }
}];

const root = {
  dataset: {
    tracking: "true",
    courseId: "cursoejemplo",
    labId: "l001",
    trackingApi: "https://example.test/api"
  },
  querySelectorAll(selector) {
    if (selector.includes("step-label")) {
      return steps;
    }
    return [];
  }
};

const document = {
  readyState: "complete",
  querySelector(selector) {
    return selector === "article.lab" ? root : null;
  },
  querySelectorAll() {
    return [];
  },
  addEventListener(name) {
    listeners.push(name);
  }
};

const context = {
  window: {
    location: {
      hash: "",
      pathname: "/labs/lab1/",
      search: ""
    },
    history: {
      replaceState() {}
    },
    LabControlDemo: {
      isActive: () => true,
      propagateNavigation: () => {},
      renderReturnLink: () => {}
    },
    addEventListener() {}
  },
  document,
  sessionStorage,
  localStorage,
  URLSearchParams,
  navigator: {
    onLine: true
  },
  fetch: async (...args) => {
    requests.push(args);
    throw new Error("No debe ejecutarse fetch en modo instructor");
  },
  console,
  setInterval() {
    throw new Error("No debe iniciarse heartbeat");
  },
  setTimeout
};

vm.runInNewContext(source, context);

await new Promise(resolve => setTimeout(resolve, 0));

assert.equal(requests.length, 0);
console.log("✓ no realiza solicitudes HTTP");

assert.equal(
  listeners.includes("lab-progress-change"),
  false
);
console.log("✓ no registra sincronización de pasos");

assert.equal(
  sessionStorage.getItem(accessTokenKey),
  originalToken
);
console.log("✓ conserva el token de participante");

assert.equal(localData.size, 0);
console.log("✓ no genera cola offline");

console.log("Tests: 4 passed, 0 failed");
