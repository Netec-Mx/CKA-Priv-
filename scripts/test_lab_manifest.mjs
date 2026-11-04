#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  execFileSync,
} from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  tmpdir,
} from 'node:os';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  fileURLToPath,
} from 'node:url';

const SCRIPT_DIR =
  dirname(
    fileURLToPath(
      import.meta.url,
    ),
  );

const GENERATOR =
  resolve(
    SCRIPT_DIR,
    'generate_lab_manifest.mjs',
  );

function createTempRoot() {
  return mkdtempSync(
    join(
      tmpdir(),
      'lab-manifest-test-',
    ),
  );
}

function writeLab(
  root,
  relativePath,
  content,
) {
  const target =
    join(
      root,
      relativePath,
    );

  mkdirSync(
    dirname(
      target,
    ),
    {
      recursive:
        true,
    },
  );

  writeFileSync(
    target,
    content,
    'utf8',
  );

  return target;
}

function runGenerator(
  cwd,
  argument,
) {
  return execFileSync(
    process.execPath,
    [
      GENERATOR,
      argument,
    ],
    {
      cwd,
      encoding:
        'utf8',
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
    },
  );
}

function runGeneratorExpectFailure(
  cwd,
  argument,
) {
  try {
    runGenerator(
      cwd,
      argument,
    );

    assert.fail(
      'El generador debía fallar.',
    );
  } catch (
    error
  ) {
    return String(
      error.stderr ??
      error.message,
    );
  }
}

function buildLab({
  courseId =
    'terraform-aws-essentials',
  labId =
    'l001',
  tracking =
    'true',
  body,
}) {
  return `---
layout: lab
course_id: ${courseId}
lab_id: ${labId}
tracking: ${tracking}
title: "Lab de prueba"
---

${body}
`;
}

function readManifest(
  root,
  courseId =
    'terraform-aws-essentials',
  labId =
    'l001',
) {
  const file =
    join(
      root,
      '.labcontrol',
      'manifests',
      courseId,
      `${labId}.json`,
    );

  return JSON.parse(
    readFileSync(
      file,
      'utf8',
    ),
  );
}

function test(
  name,
  callback,
) {
  try {
    callback();

    console.log(
      `✓ ${name}`,
    );
  } catch (
    error
  ) {
    console.error(
      `✗ ${name}`,
    );

    throw error;
  }
}

const tempRoots =
  [];

function withTempRoot(
  callback,
) {
  const root =
    createTempRoot();

  tempRoots.push(
    root,
  );

  return callback(
    root,
  );
}

try {
  test(
    'genera un manifiesto válido',
    () => {
      withTempRoot(
        root => {
          const lab =
            writeLab(
              root,
              'labs/lab1/lab1.md',
              buildLab({
                body: `
## Tarea 1. Preparar entorno — 10 min

{% assign tracking_task_id = "t001" %}

- {% include step_label.html id="s001" %} Primer paso.
- {% include step_label.html id="s002" %} Segundo paso.
`,
              }),
            );

          runGenerator(
            root,
            lab,
          );

          const manifest =
            readManifest(
              root,
            );

          assert.equal(
            manifest.version,
            1,
          );

          assert.match(
            manifest.hash,
            /^sha256:[a-f0-9]{64}$/,
          );

          assert.equal(
            manifest.tasks.length,
            1,
          );

          assert.equal(
            manifest.tasks[0].taskId,
            't001',
          );

          assert.equal(
            manifest.tasks[0].title,
            'Preparar entorno',
          );

          assert.deepEqual(
            manifest.tasks[0].steps,
            [
              {
                stepId:
                  's001',
                position:
                  1,
              },
              {
                stepId:
                  's002',
                position:
                  2,
              },
            ],
          );
        },
      );
    },
  );

  test(
    'genera el mismo hash si la estructura no cambia',
    () => {
      withTempRoot(
        root => {
          const lab =
            writeLab(
              root,
              'labs/lab1/lab1.md',
              buildLab({
                body: `
## Tarea 1. Preparar entorno

{% assign tracking_task_id = "t001" %}

- {% include step_label.html id="s001" %} Primer paso.
`,
              }),
            );

          runGenerator(
            root,
            lab,
          );

          const first =
            readManifest(
              root,
            );

          runGenerator(
            root,
            lab,
          );

          const second =
            readManifest(
              root,
            );

          assert.equal(
            first.hash,
            second.hash,
          );
        },
      );
    },
  );

  test(
    'cambia el hash cuando cambia la estructura',
    () => {
      withTempRoot(
        root => {
          const lab =
            writeLab(
              root,
              'labs/lab1/lab1.md',
              buildLab({
                body: `
## Tarea 1. Preparar entorno

{% assign tracking_task_id = "t001" %}

- {% include step_label.html id="s001" %} Primer paso.
`,
              }),
            );

          runGenerator(
            root,
            lab,
          );

          const first =
            readManifest(
              root,
            );

          writeFileSync(
            lab,
            buildLab({
              body: `
## Tarea 1. Preparar entorno

{% assign tracking_task_id = "t001" %}

- {% include step_label.html id="s001" %} Primer paso.
- {% include step_label.html id="s002" %} Segundo paso.
`,
            }),
            'utf8',
          );

          runGenerator(
            root,
            lab,
          );

          const second =
            readManifest(
              root,
            );

          assert.notEqual(
            first.hash,
            second.hash,
          );
        },
      );
    },
  );

  test(
    'rechaza step_id duplicado dentro del Lab',
    () => {
      withTempRoot(
        root => {
          const lab =
            writeLab(
              root,
              'labs/lab1/lab1.md',
              buildLab({
                body: `
## Tarea 1. Primera

{% assign tracking_task_id = "t001" %}

- {% include step_label.html id="s001" %} Primer paso.

## Tarea 2. Segunda

{% assign tracking_task_id = "t002" %}

- {% include step_label.html id="s001" %} Paso duplicado.
`,
              }),
            );

          const stderr =
            runGeneratorExpectFailure(
              root,
              lab,
            );

          assert.match(
            stderr,
            /step_id duplicado dentro del Lab/,
          );
        },
      );
    },
  );

  test(
    'rechaza task_id duplicado',
    () => {
      withTempRoot(
        root => {
          const lab =
            writeLab(
              root,
              'labs/lab1/lab1.md',
              buildLab({
                body: `
## Tarea 1. Primera

{% assign tracking_task_id = "t001" %}

- {% include step_label.html id="s001" %} Primer paso.

## Tarea 2. Segunda

{% assign tracking_task_id = "t001" %}

- {% include step_label.html id="s002" %} Segundo paso.
`,
              }),
            );

          const stderr =
            runGeneratorExpectFailure(
              root,
              lab,
            );

          assert.match(
            stderr,
            /task_id duplicado/,
          );
        },
      );
    },
  );

  test(
    'rechaza Step sin id explícito',
    () => {
      withTempRoot(
        root => {
          const lab =
            writeLab(
              root,
              'labs/lab1/lab1.md',
              buildLab({
                body: `
## Tarea 1. Preparar entorno

{% assign tracking_task_id = "t001" %}

- {% include step_label.html %} Paso legacy.
`,
              }),
            );

          const stderr =
            runGeneratorExpectFailure(
              root,
              lab,
            );

          assert.match(
            stderr,
            /sin id explícito/,
          );
        },
      );
    },
  );

  test(
    'rechaza un Lab sin tracking habilitado',
    () => {
      withTempRoot(
        root => {
          const lab =
            writeLab(
              root,
              'labs/lab1/lab1.md',
              buildLab({
                tracking:
                  'false',
                body: `
## Tarea 1. Preparar entorno

{% assign tracking_task_id = "t001" %}

- {% include step_label.html id="s001" %} Paso.
`,
              }),
            );

          const stderr =
            runGeneratorExpectFailure(
              root,
              lab,
            );

          assert.match(
            stderr,
            /tracking: true/,
          );
        },
      );
    },
  );

  test(
    '--all procesa labN e ignora labx',
    () => {
      withTempRoot(
        root => {
          writeLab(
            root,
            'labs/lab1/lab1.md',
            buildLab({
              body: `
## Tarea 1. Preparar entorno

{% assign tracking_task_id = "t001" %}

- {% include step_label.html id="s001" %} Paso.
`,
            }),
          );

          writeLab(
            root,
            'labs/labx/lab1.md',
            buildLab({
              labId:
                'l099',
              body: `
## Tarea 1. Ignorada

{% assign tracking_task_id = "t099" %}

- {% include step_label.html id="s099" %} Paso.
`,
            }),
          );

          const output =
            runGenerator(
              root,
              '--all',
            );

          assert.match(
            output,
            /Manifests generados: 1/,
          );

          const manifest =
            readManifest(
              root,
            );

          assert.equal(
            manifest.tasks[0].taskId,
            't001',
          );
        },
      );
    },
  );

  test(
    'ignora ejemplos de tracking dentro de comentarios HTML',
    () => {
      withTempRoot(
        root => {
          const lab =
            writeLab(
              root,
              'labs/lab1/lab1.md',
              buildLab({
                body: `
## Tarea 1. Preparar entorno

{% assign tracking_task_id = "t001" %}

- {% include step_label.html id="s001" %} Paso real.

<!--
Este bloque es documentación y no forma parte del Lab.

{% assign tracking_task_id = "t099" %}

- {% include step_label.html %} Ejemplo legacy.
- {% include step_label.html id="s099" %} Ejemplo documentado.
-->
`,
              }),
            );

          runGenerator(
            root,
            lab,
          );

          const manifest =
            readManifest(
              root,
            );

          assert.equal(
            manifest.tasks.length,
            1,
          );

          assert.equal(
            manifest.tasks[0].taskId,
            't001',
          );

          assert.deepEqual(
            manifest.tasks[0].steps,
            [
              {
                stepId:
                  's001',
                position:
                  1,
              },
            ],
          );
        },
      );
    },
  );


  test(
    'rechaza lab_id legacy',
    () => {
      withTempRoot(
        root => {
          const lab =
            writeLab(
              root,
              'labs/lab1/lab1.md',
              buildLab({
                labId:
                  'lab-01',
                body: `
## Tarea 1. Preparar entorno

{% assign tracking_task_id = "t001" %}

- {% include step_label.html id="s001" %} Paso.
`,
              }),
            );

          const stderr =
            runGeneratorExpectFailure(
              root,
              lab,
            );

          assert.match(
            stderr,
            /lab_id inválido/,
          );
        },
      );
    },
  );

  test(
    'rechaza task_id legacy',
    () => {
      withTempRoot(
        root => {
          const lab =
            writeLab(
              root,
              'labs/lab1/lab1.md',
              buildLab({
                body: `
## Tarea 1. Preparar entorno

{% assign tracking_task_id = "task-01" %}

- {% include step_label.html id="s001" %} Paso.
`,
              }),
            );

          const stderr =
            runGeneratorExpectFailure(
              root,
              lab,
            );

          assert.match(
            stderr,
            /task_id inválido/,
          );
        },
      );
    },
  );

  test(
    'rechaza step_id legacy',
    () => {
      withTempRoot(
        root => {
          const lab =
            writeLab(
              root,
              'labs/lab1/lab1.md',
              buildLab({
                body: `
## Tarea 1. Preparar entorno

{% assign tracking_task_id = "t001" %}

- {% include step_label.html id="step-01" %} Paso.
`,
              }),
            );

          const stderr =
            runGeneratorExpectFailure(
              root,
              lab,
            );

          assert.match(
            stderr,
            /step_id inválido/,
          );
        },
      );
    },
  );

  console.log('');
  console.log(
    'Todas las pruebas del generador de manifiestos pasaron.',
  );
} finally {
  for (
    const root
    of tempRoots
  ) {
    rmSync(
      root,
      {
        recursive:
          true,
        force:
          true,
      },
    );
  }
}