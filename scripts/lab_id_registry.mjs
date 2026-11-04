#!/usr/bin/env node

import {
  readFile,
  writeFile,
  mkdir,
} from 'node:fs/promises';

import {
  dirname,
  resolve,
} from 'node:path';

import process from 'node:process';

const COURSE_ID_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const LAB_ID_PATTERN =
  /^l\d{3}$/;

const registryFile =
  resolve(
    process.cwd(),
    '_data',
    'labcontrol-identities.yml',
  );

function fail(
  message,
) {
  console.error(
    `Error: ${message}`,
  );

  process.exit(
    1,
  );
}

function parseArgs() {
  const [
    command,
    courseId,
  ] =
    process.argv.slice(
      2,
    );

  if (
    !command ||
    !courseId
  ) {
    fail(
      'Uso: node scripts/lab_id_registry.mjs <next|register> <course_id> [lab_id]',
    );
  }

  if (
    !COURSE_ID_PATTERN.test(
      courseId,
    )
  ) {
    fail(
      `course_id inválido: ${courseId}`,
    );
  }

  return {
    command,
    courseId,
    labId:
      process.argv[4] ??
      null,
  };
}

async function loadRegistry() {
  try {
    const source =
      await readFile(
        registryFile,
        'utf8',
      );

    return parseRegistry(
      source,
    );
  } catch (
    error
  ) {
    if (
      error?.code ===
      'ENOENT'
    ) {
      return new Map();
    }

    throw error;
  }
}

function parseRegistry(
  source,
) {
  const courses =
    new Map();

  let currentCourse =
    null;

  for (
    const rawLine of
    source.replace(
      /\r\n/g,
      '\n',
    ).split('\n')
  ) {
    const line =
      rawLine.trimEnd();

    const courseMatch =
      line.match(
        /^([a-z0-9]+(?:-[a-z0-9]+)*):$/,
      );

    if (
      courseMatch &&
      !rawLine.startsWith(
        ' ',
      )
    ) {
      currentCourse =
        courseMatch[1];

      courses.set(
        currentCourse,
        {
          nextLabId:
            1,
          usedLabIds:
            [],
        },
      );

      continue;
    }

    if (
      !currentCourse
    ) {
      continue;
    }

    const nextMatch =
      line.match(
        /^\s*next_lab_id:\s*(\d+)\s*$/,
      );

    if (
      nextMatch
    ) {
      courses.get(
        currentCourse,
      ).nextLabId =
        Number(
          nextMatch[1],
        );

      continue;
    }

    const usedMatch =
      line.match(
        /^\s*-\s*(l\d{3})\s*$/,
      );

    if (
      usedMatch
    ) {
      courses.get(
        currentCourse,
      ).usedLabIds.push(
        usedMatch[1],
      );
    }
  }

  return courses;
}

function serializeRegistry(
  courses,
) {
  const lines = [
    '# Registro persistente de identidades LabControl.',
    '# No eliminar IDs históricos ni reducir next_lab_id.',
    '',
  ];

  for (
    const courseId of
    [
      ...courses.keys(),
    ].sort()
  ) {
    const course =
      courses.get(
        courseId,
      );

    const used =
      [
        ...new Set(
          course.usedLabIds,
        ),
      ].sort();

    lines.push(
      `${courseId}:`,
    );

    lines.push(
      `  next_lab_id: ${course.nextLabId}`,
    );

    lines.push(
      '  used_lab_ids:',
    );

    for (
      const labId of
      used
    ) {
      lines.push(
        `    - ${labId}`,
      );
    }

    lines.push(
      '',
    );
  }

  return (
    lines.join(
      '\n',
    ) + '\n'
  );
}

function ensureCourse(
  courses,
  courseId,
) {
  if (
    !courses.has(
      courseId,
    )
  ) {
    courses.set(
      courseId,
      {
        nextLabId:
          1,
        usedLabIds:
          [],
      },
    );
  }

  return courses.get(
    courseId,
  );
}

function formatLabId(
  value,
) {
  if (
    value >
    999
  ) {
    fail(
      'Se agotó el rango l001..l999.',
    );
  }

  return `l${String(
    value,
  ).padStart(
    3,
    '0',
  )}`;
}

async function saveRegistry(
  courses,
) {
  await mkdir(
    dirname(
      registryFile,
    ),
    {
      recursive:
        true,
    },
  );

  await writeFile(
    registryFile,
    serializeRegistry(
      courses,
    ),
    'utf8',
  );
}

async function main() {
  const {
    command,
    courseId,
    labId,
  } =
    parseArgs();

  const courses =
    await loadRegistry();

  const course =
    ensureCourse(
      courses,
      courseId,
    );

  if (
    command ===
    'next'
  ) {
    let candidate =
      course.nextLabId;

    while (
      course.usedLabIds.includes(
        formatLabId(
          candidate,
        ),
      )
    ) {
      candidate +=
        1;
    }

    const nextLabId =
      formatLabId(
        candidate,
      );

    course.usedLabIds.push(
      nextLabId,
    );

    course.nextLabId =
      candidate + 1;

    await saveRegistry(
      courses,
    );

    process.stdout.write(
      `${nextLabId}\n`,
    );

    return;
  }

  if (
    command ===
    'register'
  ) {
    if (
      !labId ||
      !LAB_ID_PATTERN.test(
        labId,
      )
    ) {
      fail(
        'register requiere un lab_id válido con formato lNNN.',
      );
    }

    if (
      !course.usedLabIds.includes(
        labId,
      )
    ) {
      course.usedLabIds.push(
        labId,
      );
    }

    const numeric =
      Number(
        labId.slice(
          1,
        ),
      );

    course.nextLabId =
      Math.max(
        course.nextLabId,
        numeric + 1,
      );

    await saveRegistry(
      courses,
    );

    process.stdout.write(
      `${labId}\n`,
    );

    return;
  }

  fail(
    `Comando desconocido: ${command}`,
  );
}

await main();
