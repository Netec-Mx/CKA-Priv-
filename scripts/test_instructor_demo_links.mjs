import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  "assets/js/lab-demo-context.js",
  "utf8"
);

function createBrowser(hash) {
  const links = [
    { href: "https://curso.example.test/labs/lab1/" },
    { href: "https://curso.example.test/" },
    { href: "https://curso.example.test/labs/lab3/" }
  ];

  const storage = new Map();

  const context = {
    window: {
      location: {
        hash,
        href: "https://curso.example.test/labs/lab2/" + hash,
        origin: "https://curso.example.test"
      }
    },
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    document: {
      querySelectorAll: selector =>
        selector === ".lab-nav a.btn" ? links : []
    },
    URLSearchParams,
    URL
  };

  vm.runInNewContext(source, context);

  return {
    links,
    demo: context.window.LabControlDemo
  };
}

const instructor = createBrowser("#lab-demo=session-157");

instructor.demo.propagateNavigation();

assert.equal(
  instructor.links.every(
    link => new URL(link.href).hash === "#lab-demo=session-157"
  ),
  true
);

console.log("✓ los tres enlaces conservan el contexto instructor");

const participant = createBrowser("#lab-access=participant-token");

const originalLinks = participant.links.map(link => link.href);

participant.demo.propagateNavigation();

assert.deepEqual(
  participant.links.map(link => link.href),
  originalLinks
);

console.log("✓ los enlaces del participante permanecen intactos");

const normal = createBrowser("");

const normalLinks = normal.links.map(link => link.href);

normal.demo.propagateNavigation();

assert.deepEqual(
  normal.links.map(link => link.href),
  normalLinks
);

console.log("✓ la navegación normal no activa demostraciones");

console.log("Tests: 3 passed, 0 failed");
