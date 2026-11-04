#!/usr/bin/env node

import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';

import {
  join,
  resolve,
} from 'node:path';

import {
  tmpdir,
} from 'node:os';

import {
  spawnSync,
} from 'node:child_process';

import process from 'node:process';

const SCRIPT =
  resolve(
    process.cwd(),
    'scripts',
    'generate_course_catalog.mjs',
  );

let passed = 0;
let failed = 0;

function assert(
  condition,
  message,
) {
  if (!condition) {
    throw new Error(
      message,
    );
  }
}

async function createRoot() {
  return mkdtemp(
    join(
      tmpdir(),
      'course-catalog-test-',
    ),
  );
}

async function writeLab(
  root,
  number,
  {
    courseId =
      'terraform-aws-essentials',
    labId =
      `l${String(
        number,
      ).padStart(
        3,
        '0',
      )}`,
    tracking =
      true,
    title =
      `Práctica ${number}: Test`,
    duration =
      '20 minutos',
    labNumber =
      number,
    position =
      number,
  } = {},
) {
  const labDir =
    join(
      root,
      'labs',
      `lab${number}`,
    );

  await mkdir(
    labDir,
    {
      recursive:
        true,
    },
  );

  const source = `---
layout: lab
course_id: ${courseId}
lab_id: ${labId}
tracking: ${tracking}
title: "${title}"
permalink: /lab${number}/lab${number}/
duration: "${duration}"
lab_number: ${labNumber}
position: ${position}
---

## Tarea 1. Test
{% assign tracking_task_id = "t001" %}

- {% include step_label.html id="s001" %} Test.
`;

  await writeFile(
    join(
      labDir,
      `lab${number}.md`,
    ),
    source,
    'utf8',
  );
}

async function writeManifest(
  root,
  courseId,
  labId,
) {
  const manifestDir =
    join(
      root,
      '.labcontrol',
      'manifests',
      courseId,
    );

  await mkdir(
    manifestDir,
    {
      recursive:
        true,
    },
  );

  await writeFile(
    join(
      manifestDir,
      `${labId}.json`,
    ),
    JSON.stringify(
      {
        version:
          1,
        hash:
          'sha256:' +
          'a'.repeat(
            64,
          ),
        tasks: [
          {
            taskId:
              't001',
            title:
              'Test',
            position:
              1,
            steps: [
              {
                stepId:
                  's001',
                position:
                  1,
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
}

function runGenerator(
  root,
  env = {},
) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
    ],
    {
      cwd:
        root,
      encoding:
        'utf8',
      env: {
        ...process.env,
        ...env,
      },
    },
  );
}

async function test(
  name,
  callback,
) {
  try {
    await callback();

    console.log(
      `✓ ${name}`,
    );

    passed += 1;
  } catch (
    error
  ) {
    console.error(
      `✗ ${name}`,
    );

    console.error(
      error instanceof Error
        ? error.message
        : String(
            error,
          ),
    );

    failed += 1;
  }
}

await test(
  'genera un catálogo con metadata y manifests de varios Labs',
  async () => {
    const root =
      await createRoot();

    try {
      await writeLab(
        root,
        1,
        {
          duration:
            '25 minutos',
        },
      );

      await writeLab(
        root,
        2,
        {
          duration:
            '35 minutos',
        },
      );

      await writeManifest(
        root,
        'terraform-aws-essentials',
        'l001',
      );

      await writeManifest(
        root,
        'terraform-aws-essentials',
        'l002',
      );

      const sourceCommitSha =
        '0123456789abcdef0123456789abcdef01234567';

      const result =
        runGenerator(
          root,
          {
            SOURCE_COMMIT_SHA:
              sourceCommitSha,
          },
        );

      assert(
        result.status ===
          0,
        result.stderr ||
          result.stdout,
      );

      const catalog =
        JSON.parse(
          await readFile(
            join(
              root,
              'labcontrol',
              'terraform-aws-essentials',
              'course.json',
            ),
            'utf8',
          ),
        );

      assert(
        catalog.version ===
          1,
        'Catalog version incorrecta.',
      );

      assert(
        catalog.courseId ===
          'terraform-aws-essentials',
        'courseId incorrecto.',
      );

      assert(
        catalog.sourceCommitSha ===
          sourceCommitSha,
        'sourceCommitSha incorrecto.',
      );

      assert(
        catalog.labs.length ===
          2,
        'Se esperaban 2 Labs.',
      );

      assert(
        catalog.labs[0]
          .labId ===
          'l001',
        'El primer labId es incorrecto.',
      );

      assert(
        catalog.labs[0]
          .durationMinutes ===
          25,
        'La duración del Lab 1 es incorrecta.',
      );

      assert(
        catalog.labs[1]
          .durationMinutes ===
          35,
        'La duración del Lab 2 es incorrecta.',
      );

      assert(
        catalog.labs[0]
          .contentPath ===
          '/lab1/lab1/',
        'contentPath incorrecto.',
      );

      assert(
        catalog.labs[0]
          .manifest.tasks[0]
          .steps.length ===
          1,
        'El manifest no fue incorporado.',
      );

      assert(
        catalog.labs[0]
          .content
          .path ===
          'content/l001.json',
        'La ruta del snapshot de contenido es incorrecta.',
      );

      assert(
        /^sha256:[a-f0-9]{64}$/.test(
          catalog.labs[0]
            .content
            .hash,
        ),
        'El hash de contenido es inválido.',
      );

      const contentArtifact =
        JSON.parse(
          await readFile(
            join(
              root,
              'labcontrol',
              'terraform-aws-essentials',
              'content',
              'l001.json',
            ),
            'utf8',
          ),
        );

      assert(
        contentArtifact.version ===
          1,
        'La versión del snapshot es incorrecta.',
      );

      assert(
        contentArtifact.labId ===
          'l001',
        'El labId del snapshot es incorrecto.',
      );

      assert(
        contentArtifact.format ===
          'markdown',
        'El formato del snapshot debe ser markdown.',
      );

      assert(
        contentArtifact.sourcePath ===
          'labs/lab1/lab1.md',
        'sourcePath del snapshot es incorrecto.',
      );

      assert(
        contentArtifact.hash ===
          catalog.labs[0]
            .content
            .hash,
        'El hash del snapshot no coincide con el catálogo.',
      );

      assert(
        contentArtifact.markdown.includes(
          '## Tarea 1. Test',
        ),
        'El Markdown fuente no fue conservado.',
      );

    } finally {
      await rm(
        root,
        {
          recursive:
            true,
          force:
            true,
        },
      );
    }
  },
);

await test(
  'ignora Labs sin tracking habilitado',
  async () => {
    const root =
      await createRoot();

    try {
      await writeLab(
        root,
        1,
      );

      await writeLab(
        root,
        2,
        {
          tracking:
            false,
        },
      );

      await writeManifest(
        root,
        'terraform-aws-essentials',
        'l001',
      );

      const result =
        runGenerator(
          root,
        );

      assert(
        result.status ===
          0,
        result.stderr ||
          result.stdout,
      );

      const catalog =
        JSON.parse(
          await readFile(
            join(
              root,
              'labcontrol',
              'terraform-aws-essentials',
              'course.json',
            ),
            'utf8',
          ),
        );

      assert(
        catalog.labs.length ===
          1,
        'El Lab sin tracking no fue ignorado.',
      );
    } finally {
      await rm(
        root,
        {
          recursive:
            true,
          force:
            true,
        },
      );
    }
  },
);

await test(
  'restaura un Lab retirado sin perder snapshots ni manifiestos',
  async () => {
    const root = await createRoot();
    try {
      await writeLab(root, 1);
      await writeLab(root, 2);
      await writeManifest(root, 'terraform-aws-essentials', 'l001');
      await writeManifest(root, 'terraform-aws-essentials', 'l002');

      const readCatalog = async () => JSON.parse(
        await readFile(
          join(root, 'labcontrol', 'terraform-aws-essentials', 'course.json'),
          'utf8',
        ),
      );
      let run = runGenerator(root);
      assert(run.status === 0, run.stderr || run.stdout);
      assert((await readCatalog()).labs.length === 2, 'Estado A incorrecto.');

      await writeLab(root, 2, { tracking: false });
      run = runGenerator(root);
      assert(run.status === 0, run.stderr || run.stdout);
      const retired = await readCatalog();
      assert(
        retired.labs.length === 1 &&
          !retired.labs.some(lab => lab.labId === 'l002'),
        'Retiro B incorrecto.',
      );

      await writeLab(root, 2, { tracking: true });
      run = runGenerator(root);
      assert(run.status === 0, run.stderr || run.stdout);
      const restored = await readCatalog();
      assert(
        restored.labs.length === 2 &&
          restored.labs.some(lab => lab.labId === 'l002'),
        'Restauración A incorrecta.',
      );
      const snapshot = JSON.parse(await readFile(
        join(root, 'labcontrol', 'terraform-aws-essentials', 'content', 'l002.json'),
        'utf8',
      ));
      assert(snapshot.labId === 'l002', 'Falta snapshot reactivado.');
      assert(restored.labs[1].content.path === 'content/l002.json',
        'La ruta no es relativa a course.json.');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

await test(
  'rechaza números de Lab duplicados dentro del mismo curso',
  async () => {
    const root =
      await createRoot();

    try {
      await writeLab(
        root,
        1,
        {
          labNumber:
            1,
        },
      );

      await writeLab(
        root,
        2,
        {
          labNumber:
            1,
        },
      );

      await writeManifest(
        root,
        'terraform-aws-essentials',
        'l001',
      );

      await writeManifest(
        root,
        'terraform-aws-essentials',
        'l002',
      );

      const result =
        runGenerator(
          root,
        );

      assert(
        result.status !==
          0,
        'El generador aceptó lab_number duplicado.',
      );

      assert(
        result.stderr.includes(
          'lab_number duplicado',
        ),
        'No reportó el error esperado.',
      );
    } finally {
      await rm(
        root,
        {
          recursive:
            true,
          force:
            true,
        },
      );
    }
  },
);

await test(
  'falla cuando falta el manifest oficial del Lab',
  async () => {
    const root =
      await createRoot();

    try {
      await writeLab(
        root,
        1,
      );

      const result =
        runGenerator(
          root,
        );

      assert(
        result.status !==
          0,
        'El generador aceptó un Lab sin manifest.',
      );

      assert(
        result.stderr.includes(
          'no existe un manifest generado',
        ),
        'No reportó el manifest faltante.',
      );
    } finally {
      await rm(
        root,
        {
          recursive:
            true,
          force:
            true,
        },
      );
    }
  },
);


await test(
  'rechaza lab_id con formato legacy',
  async () => {
    const root =
      await createRoot();

    try {
      await writeLab(
        root,
        1,
        {
          labId:
            'lab-01',
        },
      );

      const result =
        runGenerator(
          root,
        );

      assert(
        result.status !==
          0,
        'El catálogo aceptó un lab_id legacy.',
      );

      assert(
        result.stderr.includes(
          'lab_id inválido',
        ),
        'No reportó el formato inválido de lab_id.',
      );
    } finally {
      await rm(
        root,
        {
          recursive:
            true,
          force:
            true,
        },
      );
    }
  },
);


await test(
  'rechaza huecos en lab_number',
  async () => {
    const root =
      await createRoot();

    try {
      await writeLab(
        root,
        1,
        {
          labNumber:
            1,
          position:
            1,
        },
      );

      await writeLab(
        root,
        2,
        {
          labNumber:
            3,
          position:
            3,
        },
      );

      await writeManifest(
        root,
        'terraform-aws-essentials',
        'l001',
      );

      await writeManifest(
        root,
        'terraform-aws-essentials',
        'l002',
      );

      const result =
        runGenerator(
          root,
        );

      assert(
        result.status !==
          0,
        'El generador aceptó un hueco en lab_number.',
      );

      assert(
        result.stderr.includes(
          'lab_number debe ser consecutivo',
        ),
        'No reportó el hueco de lab_number.',
      );
    } finally {
      await rm(
        root,
        {
          recursive:
            true,
          force:
            true,
        },
      );
    }
  },
);

await test(
  'rechaza posiciones duplicadas',
  async () => {
    const root =
      await createRoot();

    try {
      await writeLab(
        root,
        1,
        {
          position:
            1,
        },
      );

      await writeLab(
        root,
        2,
        {
          position:
            1,
        },
      );

      await writeManifest(
        root,
        'terraform-aws-essentials',
        'l001',
      );

      await writeManifest(
        root,
        'terraform-aws-essentials',
        'l002',
      );

      const result =
        runGenerator(
          root,
        );

      assert(
        result.status !==
          0,
        'El generador aceptó position duplicada.',
      );

      assert(
        result.stderr.includes(
          'position duplicada',
        ),
        'No reportó position duplicada.',
      );
    } finally {
      await rm(
        root,
        {
          recursive:
            true,
          force:
            true,
        },
      );
    }
  },
);

await test(
  'rechaza lab_number y position desalineados',
  async () => {
    const root =
      await createRoot();

    try {
      await writeLab(
        root,
        1,
        {
          labNumber:
            1,
          position:
            2,
        },
      );

      await writeManifest(
        root,
        'terraform-aws-essentials',
        'l001',
      );

      const result =
        runGenerator(
          root,
        );

      assert(
        result.status !==
          0,
        'El generador aceptó number y position distintos.',
      );

      assert(
        result.stderr.includes(
          'Ambos deben coincidir',
        ),
        'No reportó la desalineación.',
      );
    } finally {
      await rm(
        root,
        {
          recursive:
            true,
          force:
            true,
        },
      );
    }
  },
);

console.log('');
console.log(
  `Tests: ${passed} passed, ${failed} failed`,
);

if (
  failed >
  0
) {
  process.exitCode =
    1;
}
