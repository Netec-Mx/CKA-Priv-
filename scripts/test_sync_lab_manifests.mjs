#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  join,
} from 'node:path';
import {
  tmpdir,
} from 'node:os';
import {
  findManifestFiles,
  manifestIdentity,
  normalizeApiUrl,
  syncManifestFile,
  validateToken,
} from './sync_lab_manifests.mjs';

let passed =
  0;

async function test(
  name,
  fn,
) {
  try {
    await fn();

    passed +=
      1;

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

const manifest = {
  version: 1,
  hash:
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  tasks: [
    {
      taskId:
        't001',
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
};

const root =
  await mkdtemp(
    join(
      tmpdir(),
      'labcontrol-sync-',
    ),
  );

try {
  const manifestDir =
    join(
      root,
      '.labcontrol',
      'manifests',
      'course-one',
    );

  await mkdir(
    manifestDir,
    {
      recursive:
        true,
    },
  );

  const manifestFile =
    join(
      manifestDir,
      'l001.json',
    );

  await writeFile(
    manifestFile,
    JSON.stringify(
      manifest,
    ),
    'utf8',
  );

  await test(
    'normaliza URL de API',
    async () => {
      assert.equal(
        normalizeApiUrl(
          'http://localhost:3101/',
        ),
        'http://localhost:3101',
      );
    },
  );

  await test(
    'rechaza URL inválida',
    async () => {
      assert.throws(
        () =>
          normalizeApiUrl(
            'not-a-url',
          ),
      );
    },
  );

  await test(
    'rechaza token inválido',
    async () => {
      assert.throws(
        () =>
          validateToken(
            'bad-token',
          ),
      );
    },
  );

  await test(
    'obtiene identidad desde la ruta',
    async () => {
      assert.deepEqual(
        manifestIdentity(
          manifestFile,
        ),
        {
          courseId:
            'course-one',
          labId:
            'l001',
        },
      );
    },
  );

  await test(
    'encuentra manifests generados',
    async () => {
      const files =
        await findManifestFiles(
          root,
        );

      assert.deepEqual(
        files,
        [
          manifestFile,
        ],
      );
    },
  );

  await test(
    'sincroniza con Bearer token',
    async () => {
      let captured;

      const result =
        await syncManifestFile({
          manifestFile,
          apiUrl:
            'https://labs.example.test',
          token:
            'lcst_test-token',
          fetchImpl:
            async (
              url,
              options,
            ) => {
              captured = {
                url,
                options,
              };

              return new Response(
                JSON.stringify({
                  totalTasks:
                    1,
                  totalSteps:
                    1,
                  manifestHash:
                    manifest.hash,
                }),
                {
                  status:
                    200,
                  headers: {
                    'Content-Type':
                      'application/json',
                  },
                },
              );
            },
        });

      assert.equal(
        captured.url,
        'https://labs.example.test/manifest-sync/courses/course-one/labs/l001',
      );

      assert.equal(
        captured.options.headers.Authorization,
        'Bearer lcst_test-token',
      );

      assert.equal(
        result.courseId,
        'course-one',
      );

      assert.equal(
        result.labId,
        'l001',
      );
    },
  );

  await test(
    'propaga error HTTP sin revelar token',
    async () => {
      await assert.rejects(
        () =>
          syncManifestFile({
            manifestFile,
            apiUrl:
              'https://labs.example.test',
            token:
              'lcst_secret-value',
            fetchImpl:
              async () =>
                new Response(
                  JSON.stringify({
                    message:
                      'Invalid manifest sync token',
                  }),
                  {
                    status:
                      401,
                    headers: {
                      'Content-Type':
                        'application/json',
                    },
                  },
                ),
          }),
        error => {
          assert.match(
            error.message,
            /401/,
          );

          assert.doesNotMatch(
            error.message,
            /lcst_secret-value/,
          );

          return true;
        },
      );
    },
  );

  console.log('');
  console.log(
    `Tests aprobados: ${passed}`,
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
