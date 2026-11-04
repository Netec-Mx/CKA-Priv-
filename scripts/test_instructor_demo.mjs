import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  "assets/js/lab-demo-context.js",
  "utf8"
);

const storage = new Map();

let hash = "#lab-demo=session-157";

const context = {
  window: {
    location: {
      get hash() {
        return hash;
      }
    }
  },
  sessionStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
  },
  URLSearchParams
};

vm.runInNewContext(source, context);

const demo = context.window.LabControlDemo;

assert.equal(demo.isActive(), true);

assert.equal(
  demo.getProgressKey("cursoejemplo", "l001"),
  "netec:instructorDemoProgress:session-157:cursoejemplo:l001"
);

console.log("✓ progreso del instructor usa una clave independiente");

hash = "";

assert.equal(demo.isActive(), false);

console.log("✓ una navegación normal no hereda el modo instructor");

hash = "#lab-demo=session-157";

assert.equal(demo.isActive(), true);

console.log("✓ la navegación explícita conserva el modo instructor");

hash = "#lab-access=participant-token";

assert.equal(demo.isActive(), false);
assert.equal(
  storage.has("netec:instructorDemoSession"),
  false
);

console.log("✓ el acceso normal desactiva el contexto de demostración");

console.log("Tests: 4 passed, 0 failed");
