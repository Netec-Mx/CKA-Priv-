#!/usr/bin/env node

import {
  readFile,
} from 'node:fs/promises';

import {
  resolve,
} from 'node:path';

import process from 'node:process';

import {
  pathToFileURL,
} from 'node:url';

const COURSE_ID_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const HASH_PATTERN =
  /^sha256:[a-f0-9]{64}$/i;

const PLACEHOLDER_PATTERN =
  /NOMBRE_DEL_CURSO|DESCRIPCI[ÓO]N_DEL_CURSO|CAMBIAR_AQUI/i;

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

export function validateAuthoringToken(
  token,
) {
  if (
    !token ||
    !token.startsWith(
      'lcat_',
    )
  ) {
    throw new Error(
      'LABCONTROL_AUTHORING_SYNC_TOKEN no está configurado o no tiene formato válido.',
    );
  }
}

function validateCourseId(
  courseId,
) {
  if (
    !courseId ||
    !COURSE_ID_PATTERN.test(
      courseId,
    )
  ) {
    throw new Error(
      'course_id debe usar kebab-case.',
    );
  }
}

function derivedCourseName(
  courseId,
) {
  return courseId
    .split('-')
    .map(
      part =>
        part
          .charAt(0)
          .toUpperCase() +
        part.slice(1),
    )
    .join(' ');
}

function stripYamlValue(
  value,
) {
  let result =
    value.trim();

  const commentIndex =
    result.indexOf(
      ' #',
    );

  if (
    commentIndex >=
    0
  ) {
    result =
      result.slice(
        0,
        commentIndex,
      );
  }

  result =
    result.trim();

  if (
    (
      result.startsWith('"') &&
      result.endsWith('"')
    ) ||
    (
      result.startsWith("'") &&
      result.endsWith("'")
    )
  ) {
    result =
      result.slice(
        1,
        -1,
      );
  }

  return result.trim();
}

export function parseCourseMetadata(
  source,
  courseId,
) {
  const lines =
    source.replace(
      /\r\n/g,
      '\n',
    ).split(
      '\n',
    );

  let inCourse =
    false;

  let title =
    null;

  let intro =
    null;

  for (
    const line of
      lines
  ) {
    if (
      !inCourse
    ) {
      if (
        line ===
        `${courseId}:`
      ) {
        inCourse =
          true;
      }

      continue;
    }

    if (
      /^[^\s#][^:]*:/.test(
        line,
      )
    ) {
      break;
    }

    const titleMatch =
      line.match(
        /^\s{2}title:\s*(.*?)\s*$/,
      );

    if (
      titleMatch
    ) {
      title =
        stripYamlValue(
          titleMatch[1],
        );

      continue;
    }

    const introMatch =
      line.match(
        /^\s{2}intro:\s*(.*?)\s*$/,
      );

    if (
      introMatch
    ) {
      intro =
        stripYamlValue(
          introMatch[1],
        );
    }
  }

  return {
    title:
      title &&
      !PLACEHOLDER_PATTERN.test(
        title,
      )
        ? title
        : null,
    intro:
      intro &&
      !PLACEHOLDER_PATTERN.test(
        intro,
      )
        ? intro
        : null,
  };
}

async function loadOptionalCourseMetadata(
  rootDir,
  courseId,
) {
  const file =
    resolve(
      rootDir,
      '_data',
      'courses.yml',
    );

  try {
    const source =
      await readFile(
        file,
        'utf8',
      );

    return parseCourseMetadata(
      source,
      courseId,
    );
  } catch (
    error
  ) {
    if (
      error &&
      typeof error ===
        'object' &&
      'code' in error &&
      error.code ===
        'ENOENT'
    ) {
      return {
        title:
          null,
        intro:
          null,
      };
    }

    throw error;
  }
}

async function loadJson(
  file,
  label,
) {
  let source;

  try {
    source =
      await readFile(
        file,
        'utf8',
      );
  } catch {
    throw new Error(
      `No se pudo leer ${label}: ${file}`,
    );
  }

  try {
    return JSON.parse(
      source,
    );
  } catch {
    throw new Error(
      `${label} no contiene JSON válido: ${file}`,
    );
  }
}

function validateCatalog(
  catalog,
  courseId,
) {
  if (
    !catalog ||
    typeof catalog !==
      'object' ||
    Array.isArray(
      catalog,
    )
  ) {
    throw new Error(
      'course.json no contiene un objeto válido.',
    );
  }

  if (
    catalog.courseId !==
      courseId
  ) {
    throw new Error(
      `course.json pertenece a "${catalog.courseId ?? ''}" y no a "${courseId}".`,
    );
  }

  if (
    !Number.isInteger(
      catalog.version,
    ) ||
    catalog.version <
      1
  ) {
    throw new Error(
      'course.json tiene version inválida.',
    );
  }

  if (
    !Array.isArray(
      catalog.labs,
    ) ||
    catalog.labs.length ===
      0
  ) {
    throw new Error(
      'course.json no contiene Labs.',
    );
  }
}

async function loadSnapshots(
  rootDir,
  catalog,
) {
  const snapshots =
    [];

  for (
    const lab of
      catalog.labs
  ) {
    if (
      !lab.content ||
      typeof lab.content.path !==
        'string' ||
      typeof lab.content.hash !==
        'string' ||
      !HASH_PATTERN.test(
        lab.content.hash,
      )
    ) {
      throw new Error(
        `El Lab ${lab.labId ?? '?'} no tiene metadata de contenido válida.`,
      );
    }

    const relativePath =
      lab.content.path
        .replace(
          /^\/+/,
          '',
        );

    const snapshotFile =
      resolve(
        rootDir,
        'labcontrol',
        catalog.courseId,
        relativePath,
      );

    const snapshot =
      await loadJson(
        snapshotFile,
        `snapshot ${lab.labId}`,
      );

    if (
      snapshot.labId !==
        lab.labId
    ) {
      throw new Error(
        `Snapshot labId mismatch para ${lab.labId}.`,
      );
    }

    if (
      snapshot.hash
        ?.toLowerCase() !==
      lab.content.hash
        .toLowerCase()
    ) {
      throw new Error(
        `Snapshot hash mismatch para ${lab.labId}.`,
      );
    }

    snapshots.push(
      snapshot,
    );
  }

  return snapshots;
}

export async function buildAuthoringPayload({
  rootDir,
  courseId,
}) {
  validateCourseId(
    courseId,
  );

  const catalogFile =
    resolve(
      rootDir,
      'labcontrol',
      courseId,
      'course.json',
    );

  const catalog =
    await loadJson(
      catalogFile,
      'catálogo',
    );

  validateCatalog(
    catalog,
    courseId,
  );

  const snapshots =
    await loadSnapshots(
      rootDir,
      catalog,
    );

  const metadata =
    await loadOptionalCourseMetadata(
      rootDir,
      courseId,
    );

  const code =
    (
      process.env
        .LABCONTROL_COURSE_CODE ??
      courseId
    ).trim();

  if (
    !code ||
    code.length >
      50
  ) {
    throw new Error(
      'El código del Course debe tener entre 1 y 50 caracteres. Usa LABCONTROL_COURSE_CODE para sobrescribirlo.',
    );
  }

  const name =
    (
      process.env
        .LABCONTROL_COURSE_NAME ??
      metadata.title ??
      derivedCourseName(
        courseId,
      )
    ).trim();

  if (
    !name ||
    name.length >
      200
  ) {
    throw new Error(
      'El nombre del Course debe tener entre 1 y 200 caracteres.',
    );
  }

  const description =
    (
      process.env
        .LABCONTROL_COURSE_DESCRIPTION ??
      metadata.intro ??
      ''
    ).trim();

  const contentBaseUrl =
    process.env
      .LABCONTROL_CONTENT_BASE_URL
      ?.trim()
      .replace(
        /\/+$/,
        '',
      );

  const course = {
    code,
    name,
    isActive:
      true,
  };

  if (
    description
  ) {
    course.description =
      description;
  }

  if (
    contentBaseUrl
  ) {
    course.contentBaseUrl =
      contentBaseUrl;
  }

  return {
    course,
    catalog,
    snapshots,
  };
}

function printPlan(
  payload,
  dryRun,
) {
  console.log(
    dryRun
      ? 'LabControl authoring sync: DRY RUN'
      : 'LabControl authoring sync',
  );

  console.log(
    `  Course ID: ${payload.catalog.courseId}`,
  );

  console.log(
    `  Code: ${payload.course.code}`,
  );

  console.log(
    `  Name: ${payload.course.name}`,
  );

  console.log(
    `  Labs: ${payload.catalog.labs.length}`,
  );

  console.log(
    `  Snapshots: ${payload.snapshots.length}`,
  );

  console.log(
    `  Source commit: ${payload.catalog.sourceCommitSha ?? 'no disponible'}`,
  );

  if (
    payload.course.contentBaseUrl
  ) {
    console.log(
      `  Content base URL: ${payload.course.contentBaseUrl}`,
    );
  }

  if (
    dryRun
  ) {
    console.log(
      '  HTTP PUT: omitido por --dry-run',
    );
  }
}

export async function syncCourseCatalog({
  rootDir,
  courseId,
  dryRun =
    false,
  apiUrl =
    process.env
      .LABCONTROL_API_URL,
  token =
    process.env
      .LABCONTROL_AUTHORING_SYNC_TOKEN,
  fetchImpl =
    fetch,
}) {
  const payload =
    await buildAuthoringPayload({
      rootDir,
      courseId,
    });

  printPlan(
    payload,
    dryRun,
  );

  if (
    dryRun
  ) {
    return {
      dryRun:
        true,
      payload,
    };
  }

  const normalizedApiUrl =
    normalizeApiUrl(
      apiUrl,
    );

  validateAuthoringToken(
    token,
  );

  const endpoint =
    `${normalizedApiUrl}/authoring-sync/courses/` +
    encodeURIComponent(
      courseId,
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
            payload,
          ),
      },
    );

  const responseText =
    await response.text();

  let responseBody =
    responseText;

  if (
    responseText
  ) {
    try {
      responseBody =
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
      typeof responseBody ===
        'object' &&
      responseBody &&
      'message' in
        responseBody
        ? responseBody.message
        : responseText ||
          response.statusText;

    throw new Error(
      `LabControl rechazó ${courseId}: ${response.status} ${detail}`,
    );
  }

  console.log(
    `Sincronizado: ${courseId}`,
  );

  if (
    responseBody &&
    typeof responseBody ===
      'object' &&
    'catalog' in
      responseBody
  ) {
    const result =
      responseBody.catalog;

    console.log(
      `  Created: ${result.created ?? '?'}`,
    );

    console.log(
      `  Updated: ${result.updated ?? '?'}`,
    );

    console.log(
      `  Manifest synced: ${result.manifestSynced ?? '?'}`,
    );

    console.log(
      `  Deactivated: ${result.deactivated ?? '?'}`,
    );

    console.log(
      `  Unchanged: ${result.unchanged ?? '?'}`,
    );
  }

  return {
    dryRun:
      false,
    endpoint,
    payload,
    response:
      responseBody,
  };
}

async function main() {
  const args =
    process.argv.slice(
      2,
    );

  const dryRun =
    args.includes(
      '--dry-run',
    );

  const positional =
    args.filter(
      argument =>
        argument !==
        '--dry-run',
    );

  const courseId =
    positional[0];

  if (
    !courseId ||
    positional.length >
      1
  ) {
    console.error(
      'Uso:',
    );

    console.error(
      '  node scripts/sync_course_catalog.mjs <course_id>',
    );

    console.error(
      '  node scripts/sync_course_catalog.mjs <course_id> --dry-run',
    );

    process.exitCode =
      1;

    return;
  }

  await syncCourseCatalog({
    rootDir:
      process.cwd(),
    courseId,
    dryRun,
  });
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
