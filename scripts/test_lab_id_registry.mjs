#!/usr/bin/env node

import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';

import {
  tmpdir,
} from 'node:os';

import {
  join,
  resolve,
} from 'node:path';

import {
  spawnSync,
} from 'node:child_process';

import process from 'node:process';

const SCRIPT =
  resolve(
    process.cwd(),
    'scripts',
    'lab_id_registry.mjs',
  );

let passed =
  0;

let failed =
  0;

function assert(
  condition,
  message,
) {
  if (
    !condition
  ) {
    throw new Error(
      message,
    );
  }
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

    passed +=
      1;
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

    failed +=
      1;
  }
}

async function createRoot() {
  const root =
    await mkdtemp(
      join(
        tmpdir(),
        'lab-id-registry-',
      ),
    );

  await mkdir(
    join(
      root,
      '_data',
    ),
    {
      recursive:
        true,
    },
  );

  return root;
}

function run(
  root,
  args,
) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      ...args,
    ],
    {
      cwd:
        root,
      encoding:
        'utf8',
    },
  );
}

await test(
  'asigna l001 en un curso nuevo',
  async () => {
    const root =
      await createRoot();

    try {
      const result =
        run(
          root,
          [
            'next',
            'curso-demo',
          ],
        );

      assert(
        result.status ===
          0,
        result.stderr,
      );

      assert(
        result.stdout.trim() ===
          'l001',
        'Se esperaba l001.',
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
  'asigna IDs consecutivos sin reutilizar',
  async () => {
    const root =
      await createRoot();

    try {
      const first =
        run(
          root,
          [
            'next',
            'curso-demo',
          ],
        );

      const second =
        run(
          root,
          [
            'next',
            'curso-demo',
          ],
        );

      assert(
        first.stdout.trim() ===
          'l001',
        'Primer ID incorrecto.',
      );

      assert(
        second.stdout.trim() ===
          'l002',
        'Segundo ID incorrecto.',
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
  'no reutiliza un ID histórico registrado',
  async () => {
    const root =
      await createRoot();

    try {
      await writeFile(
        join(
          root,
          '_data',
          'labcontrol-identities.yml',
        ),
        `curso-demo:
  next_lab_id: 4
  used_lab_ids:
    - l001
    - l002
    - l003
`,
        'utf8',
      );

      const result =
        run(
          root,
          [
            'next',
            'curso-demo',
          ],
        );

      assert(
        result.status ===
          0,
        result.stderr,
      );

      assert(
        result.stdout.trim() ===
          'l004',
        'Se esperaba l004.',
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
  'register avanza next_lab_id',
  async () => {
    const root =
      await createRoot();

    try {
      const registered =
        run(
          root,
          [
            'register',
            'curso-demo',
            'l009',
          ],
        );

      assert(
        registered.status ===
          0,
        registered.stderr,
      );

      const next =
        run(
          root,
          [
            'next',
            'curso-demo',
          ],
        );

      assert(
        next.stdout.trim() ===
          'l010',
        'Se esperaba l010 después de registrar l009.',
      );

      const registry =
        await readFile(
          join(
            root,
            '_data',
            'labcontrol-identities.yml',
          ),
          'utf8',
        );

      assert(
        registry.includes(
          'next_lab_id: 11',
        ),
        'next_lab_id no avanzó correctamente.',
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

console.log();

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
