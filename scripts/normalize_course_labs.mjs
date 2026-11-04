#!/usr/bin/env node

import {
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';

import {
  join,
  resolve,
} from 'node:path';

import process from 'node:process';

const COURSE_ID_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const LAB_ID_PATTERN =
  /^l\d{3}$/;

const FRONT_MATTER_PATTERN =
  /^---\s*\r?\n([\s\S]*?)\r?\n---/;

function fail(message) {
  console.error(
    `Error: ${message}`,
  );

  process.exitCode =
    1;
}

function getValue(
  source,
  key,
) {
  const frontMatter =
    source.match(
      FRONT_MATTER_PATTERN,
    )?.[1];

  if (!frontMatter) {
    throw new Error(
      'No se encontró front matter válido.',
    );
  }

  const pattern =
    new RegExp(
      `^${key}:\\s*(.*?)\\s*$`,
      'm',
    );

  const match =
    frontMatter.match(
      pattern,
    );

  if (!match) {
    return null;
  }

  let value =
    match[1].trim();

  if (
    (
      value.startsWith('"') &&
      value.endsWith('"')
    ) ||
    (
      value.startsWith("'") &&
      value.endsWith("'")
    )
  ) {
    value =
      value.slice(
        1,
        -1,
      );
  }

  return value;
}

function replaceScalar(
  source,
  key,
  value,
) {
  const pattern =
    new RegExp(
      `^${key}:\\s*.*$`,
      'm',
    );

  if (!pattern.test(source)) {
    throw new Error(
      `No existe ${key} en el front matter.`,
    );
  }

  return source.replace(
    pattern,
    `${key}: ${value}`,
  );
}

async function findLabs(
  rootDir,
  courseId,
) {
  const entries =
    await readdir(
      rootDir,
      {
        withFileTypes:
          true,
      },
    );

  const labs = [];

  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !/^lab\d+$/.test(
        entry.name,
      )
    ) {
      continue;
    }

    const file =
      join(
        rootDir,
        entry.name,
        `${entry.name}.md`,
      );

    let source;

    try {
      source =
        await readFile(
          file,
          'utf8',
        );
    } catch {
      continue;
    }

    const tracking =
      getValue(
        source,
        'tracking',
      );

    const fileCourseId =
      getValue(
        source,
        'course_id',
      );

    if (
      tracking !== 'true' ||
      fileCourseId !== courseId
    ) {
      continue;
    }

    const labId =
      getValue(
        source,
        'lab_id',
      );

    const position =
      Number(
        getValue(
          source,
          'position',
        ),
      );

    const permalink =
      getValue(
        source,
        'permalink',
      );

    if (
      !labId ||
      !LAB_ID_PATTERN.test(
        labId,
      )
    ) {
      throw new Error(
        `${file}: lab_id inválido.`,
      );
    }

    if (
      !Number.isInteger(
        position,
      ) ||
      position < 1
    ) {
      throw new Error(
        `${file}: position inválida.`,
      );
    }

    if (
      !permalink ||
      !permalink.startsWith('/')
    ) {
      throw new Error(
        `${file}: permalink inválido.`,
      );
    }

    labs.push({
      file,
      source,
      labId,
      position,
      permalink,
    });
  }

  return labs;
}

async function main() {
  const courseId =
    process.argv[2];

  if (
    !courseId ||
    !COURSE_ID_PATTERN.test(
      courseId,
    )
  ) {
    fail(
      'Uso: node scripts/normalize_course_labs.mjs <course_id>',
    );

    return;
  }

  const rootDir =
    resolve(
      process.cwd(),
      process.env.ROOT_DIR ??
        'labs',
    );

  let labs;

  try {
    labs =
      await findLabs(
        rootDir,
        courseId,
      );
  } catch (error) {
    fail(
      error instanceof Error
        ? error.message
        : String(error),
    );

    return;
  }

  if (
    labs.length ===
    0
  ) {
    fail(
      `No se encontraron Labs rastreables para ${courseId}.`,
    );

    return;
  }

  labs.sort(
    (
      a,
      b,
    ) =>
      a.position -
      b.position,
  );

  const positions =
    new Set();

  const labIds =
    new Set();

  for (
    let index =
      0;
    index <
    labs.length;
    index +=
    1
  ) {
    const lab =
      labs[index];

    if (
      positions.has(
        lab.position,
      )
    ) {
      fail(
        `position duplicada: ${lab.position}`,
      );

      return;
    }

    positions.add(
      lab.position,
    );

    if (
      labIds.has(
        lab.labId,
      )
    ) {
      fail(
        `lab_id duplicado: ${lab.labId}`,
      );

      return;
    }

    labIds.add(
      lab.labId,
    );

    const expected =
      index + 1;

    if (
      lab.position !==
      expected
    ) {
      fail(
        `Las posiciones deben formar una secuencia 1..N. Falta position ${expected}.`,
      );

      return;
    }
  }

  for (
    let index =
      0;
    index <
    labs.length;
    index +=
    1
  ) {
    const lab =
      labs[index];

    const number =
      index + 1;

    const prev =
      index === 0
        ? '/'
        : labs[
            index - 1
          ].permalink;

    const next =
      index ===
      labs.length - 1
        ? '/'
        : labs[
            index + 1
          ].permalink;

    let source =
      lab.source;

    source =
      replaceScalar(
        source,
        'lab_number',
        String(number),
      );

    source =
      replaceScalar(
        source,
        'position',
        String(number),
      );

    source =
      replaceScalar(
        source,
        'prev',
        prev,
      );

    source =
      replaceScalar(
        source,
        'next',
        next,
      );

    await writeFile(
      lab.file,
      source,
      'utf8',
    );

    console.log(
      `${lab.labId}: position ${number} | prev ${prev} | next ${next}`,
    );
  }

  console.log();
  console.log(
    `Labs normalizados: ${labs.length}`,
  );
}

await main();
