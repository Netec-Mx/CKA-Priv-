#!/usr/bin/env node

import {
  readFile,
  readdir,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import process from 'node:process';
import {
  pathToFileURL,
} from 'node:url';

const COURSE_ID_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const LAB_ID_PATTERN =
  /^l\d{3}$/;

const HASH_PATTERN =
  /^sha256:[a-f0-9]{64}$/i;

function validateTrackingId(
  value,
  label,
) {
  const pattern =
    label === 'lab_id'
      ? LAB_ID_PATTERN
      : COURSE_ID_PATTERN;

  if (
    !value ||
    !pattern.test(
      value,
    )
  ) {
    const expected =
      label === 'lab_id'
        ? 'lNNN, por ejemplo l001'
        : 'kebab-case';

    throw new Error(
      `${label} inválido: "${value ?? ''}". Formato esperado: ${expected}.`,
    );
  }
}

export function normalizeApiUrl(
  value,
) {
  if (!value) {
    throw new Error(
      'LABCONTROL_API_URL no está configurado.',
    );
  }

  let parsed;

  try {
    parsed =
      new URL(
        value,
      );
  } catch {
    throw new Error(
      'LABCONTROL_API_URL no es una URL válida.',
    );
  }

  if (
    parsed.protocol !==
      'http:' &&
    parsed.protocol !==
      'https:'
  ) {
    throw new Error(
      'LABCONTROL_API_URL debe usar http o https.',
    );
  }

  return value.replace(
    /\/+$/,
    '',
  );
}

export function validateToken(
  token,
) {
  if (
    !token ||
    !token.startsWith(
      'lcst_',
    )
  ) {
    throw new Error(
      'LABCONTROL_SYNC_TOKEN no está configurado o no tiene formato válido.',
    );
  }
}

export async function loadManifest(
  manifestFile,
) {
  const source =
    await readFile(
      manifestFile,
      'utf8',
    );

  let manifest;

  try {
    manifest =
      JSON.parse(
        source,
      );
  } catch {
    throw new Error(
      `Manifest JSON inválido: ${manifestFile}`,
    );
  }

  if (
    !Number.isInteger(
      manifest.version,
    ) ||
    manifest.version <
      1
  ) {
    throw new Error(
      `Manifest version inválido: ${manifestFile}`,
    );
  }

  if (
    typeof manifest.hash !==
      'string' ||
    !HASH_PATTERN.test(
      manifest.hash,
    )
  ) {
    throw new Error(
      `Manifest hash inválido: ${manifestFile}`,
    );
  }

  if (
    !Array.isArray(
      manifest.tasks,
    ) ||
    manifest.tasks.length ===
      0
  ) {
    throw new Error(
      `Manifest sin Tasks: ${manifestFile}`,
    );
  }

  return manifest;
}

export function manifestIdentity(
  manifestFile,
) {
  const labId =
    basename(
      manifestFile,
      '.json',
    );

  const courseId =
    basename(
      dirname(
        manifestFile,
      ),
    );

  validateTrackingId(
    courseId,
    'course_id',
  );

  validateTrackingId(
    labId,
    'lab_id',
  );

  return {
    courseId,
    labId,
  };
}

export async function syncManifestFile({
  manifestFile,
  apiUrl,
  token,
  fetchImpl =
    fetch,
}) {
  const {
    courseId,
    labId,
  } =
    manifestIdentity(
      manifestFile,
    );

  const manifest =
    await loadManifest(
      manifestFile,
    );

  const endpoint =
    `${normalizeApiUrl(
      apiUrl,
    )}/manifest-sync/courses/` +
    `${encodeURIComponent(
      courseId,
    )}/labs/` +
    `${encodeURIComponent(
      labId,
    )}`;

  validateToken(
    token,
  );

  const response =
    await fetchImpl(
      endpoint,
      {
        method:
          'PUT',
        headers: {
          Authorization:
            `Bearer ${token}`,
          'Content-Type':
            'application/json',
        },
        body:
          JSON.stringify(
            manifest,
          ),
      },
    );

  const responseText =
    await response.text();

  let body =
    responseText;

  if (
    responseText
  ) {
    try {
      body =
        JSON.parse(
          responseText,
        );
    } catch {
      // Conserva texto plano.
    }
  }

  if (
    !response.ok
  ) {
    const detail =
      typeof body ===
        'object' &&
      body &&
      'message' in body
        ? body.message
        : responseText ||
          response.statusText;

    throw new Error(
      `LabControl rechazó ${courseId}/${labId}: ` +
      `${response.status} ${detail}`,
    );
  }

  return {
    courseId,
    labId,
    endpoint,
    response:
      body,
  };
}

export async function findManifestFiles(
  rootDir,
) {
  const manifestsRoot =
    resolve(
      rootDir,
      '.labcontrol',
      'manifests',
    );

  const courses =
    await readdir(
      manifestsRoot,
      {
        withFileTypes:
          true,
      },
    );

  const files =
    [];

  for (
    const course
    of courses
  ) {
    if (
      !course.isDirectory()
    ) {
      continue;
    }

    validateTrackingId(
      course.name,
      'course_id',
    );

    const courseDir =
      join(
        manifestsRoot,
        course.name,
      );

    const entries =
      await readdir(
        courseDir,
        {
          withFileTypes:
            true,
        },
      );

    for (
      const entry
      of entries
    ) {
      if (
        entry.isFile() &&
        entry.name.endsWith(
          '.json',
        )
      ) {
        files.push(
          join(
            courseDir,
            entry.name,
          ),
        );
      }
    }
  }

  return files.sort();
}

function printResult(
  result,
) {
  const response =
    result.response;

  console.log(
    `Sincronizado: ${result.courseId}/${result.labId}`,
  );

  if (
    response &&
    typeof response ===
      'object'
  ) {
    console.log(
      `  Tasks: ${response.totalTasks ?? '?'}`,
    );

    console.log(
      `  Steps: ${response.totalSteps ?? '?'}`,
    );

    console.log(
      `  Hash: ${response.manifestHash ?? '?'}`,
    );
  }
}

async function main() {
  const argument =
    process.argv[
      2
    ];

  if (!argument) {
    console.error(
      'Uso:',
    );

    console.error(
      '  node scripts/sync_lab_manifests.mjs --all',
    );

    console.error(
      '  node scripts/sync_lab_manifests.mjs .labcontrol/manifests/<course_id>/<lab_id>.json',
    );

    process.exitCode =
      1;

    return;
  }

  const apiUrl =
    process.env
      .LABCONTROL_API_URL;

  const token =
    process.env
      .LABCONTROL_SYNC_TOKEN;

  normalizeApiUrl(
    apiUrl,
  );

  validateToken(
    token,
  );

  let files;

  if (
    argument ===
    '--all'
  ) {
    files =
      await findManifestFiles(
        process.cwd(),
      );
  } else {
    files = [
      resolve(
        process.cwd(),
        argument,
      ),
    ];
  }

  if (
    files.length ===
    0
  ) {
    throw new Error(
      'No se encontraron manifests para sincronizar.',
    );
  }

  console.log(
    `Manifests a sincronizar: ${files.length}`,
  );

  let synced =
    0;

  for (
    const manifestFile
    of files
  ) {
    const result =
      await syncManifestFile({
        manifestFile,
        apiUrl,
        token,
      });

    printResult(
      result,
    );

    synced +=
      1;
  }

  console.log('');
  console.log(
    `Manifests sincronizados: ${synced}`,
  );
}

const isMain =
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(
      process.argv[1],
    ).href;

if (
  isMain
) {
  main().catch(
    error => {
      console.error(
        `Error: ${
          error instanceof Error
            ? error.message
            : String(
                error,
              )
        }`,
      );

      process.exitCode =
        1;
    },
  );
}
