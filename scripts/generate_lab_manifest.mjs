#!/usr/bin/env node

import {
  createHash,
} from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import process from 'node:process';

const MANIFEST_VERSION = 1;

const COURSE_ID_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const LAB_ID_PATTERN =
  /^l\d{3}$/;

const TASK_ID_PATTERN =
  /^t\d{3}$/;

const STEP_ID_PATTERN =
  /^s\d{3}$/;

const FRONT_MATTER_PATTERN =
  /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

const TASK_ASSIGN_PATTERN =
  /\{%\s*assign\s+tracking_task_id\s*=\s*["']([^"']+)["']\s*%\}/;

const STEP_INCLUDE_PATTERN =
  /\{%\s*include\s+step_label\.html\b([^%]*)%\}/;

const ATTRIBUTE_PATTERN =
  /([a-zA-Z0-9_-]+)\s*=\s*["']([^"']*)["']/g;

const TASK_HEADING_PATTERN =
  /^##\s+(.+)$/;

function fail(
  message,
) {
  console.error(
    `Error: ${message}`,
  );

  process.exitCode =
    1;
}

function normalizeLineEndings(
  value,
) {
  return value.replace(
    /\r\n/g,
    '\n',
  );
}

/*
 * Ignora comentarios HTML sin alterar la cantidad
 * de líneas del documento.
 *
 * create_labs.sh incluye una guía extensa dentro de:
 *
 *   <!--
 *   ...
 *   -->
 *
 * Esa guía contiene ejemplos de step_label.html que
 * no forman parte de la estructura real del laboratorio.
 *
 * Sustituimos todo el contenido del comentario por
 * espacios, conservando únicamente los saltos de línea.
 * Así los números de línea de los errores siguen
 * correspondiendo con el archivo original.
 */
function stripHtmlComments(
  value,
) {
  return value.replace(
    /<!--[\s\S]*?-->/g,
    match =>
      match.replace(
        /[^\n]/g,
        ' ',
      ),
  );
}

function parseSimpleFrontMatter(
  source,
) {
  const match =
    source.match(
      FRONT_MATTER_PATTERN,
    );

  if (!match) {
    throw new Error(
      'No se encontró front matter YAML válido.',
    );
  }

  const values = {};

  for (
    const line
    of normalizeLineEndings(
      match[1],
    ).split('\n')
  ) {
    const simple =
      line.match(
        /^([a-zA-Z0-9_-]+):\s*(.*?)\s*$/,
      );

    if (!simple) {
      continue;
    }

    let value =
      simple[2].trim();

    if (
      (
        value.startsWith(
          '"',
        ) &&
        value.endsWith(
          '"',
        )
      ) ||
      (
        value.startsWith(
          "'",
        ) &&
        value.endsWith(
          "'",
        )
      )
    ) {
      value =
        value.slice(
          1,
          -1,
        );
    }

    values[
      simple[1]
    ] =
      value;
  }

  return values;
}

function parseBoolean(
  value,
) {
  return (
    String(
      value,
    ).toLowerCase() ===
    'true'
  );
}

function validateTrackingId(
  value,
  label,
) {
  const patterns = {
    course_id:
      COURSE_ID_PATTERN,
    lab_id:
      LAB_ID_PATTERN,
    task_id:
      TASK_ID_PATTERN,
    step_id:
      STEP_ID_PATTERN,
  };

  const pattern =
    patterns[label];

  if (
    !value ||
    !pattern ||
    !pattern.test(
      value,
    )
  ) {
    const expected = {
      course_id:
        'kebab-case, por ejemplo terraform-aws-essentials',
      lab_id:
        'lNNN, por ejemplo l001',
      task_id:
        'tNNN, por ejemplo t001',
      step_id:
        'sNNN, por ejemplo s001',
    };

    throw new Error(
      `${label} inválido: "${value ?? ''}". Formato esperado: ${expected[label]}.`,
    );
  }
}

function cleanTaskTitle(
  heading,
) {
  let value =
    heading.trim();

  value =
    value.replace(
      /^[^\p{L}\p{N}]*/u,
      '',
    );

  value =
    value.replace(
      /^Tarea\s+\d+(?:\.\d+)?\.\s*/i,
      '',
    );

  value =
    value.replace(
      /\s+[—-]\s+\d+\s*min(?:utos?)?\s*$/i,
      '',
    );

  value =
    value.replace(
      /\s+[—-]\s+##\s*min(?:utos?)?\s*$/i,
      '',
    );

  return (
    value.trim() ||
    null
  );
}

function parseAttributes(
  value,
) {
  const attributes =
    {};

  ATTRIBUTE_PATTERN.lastIndex =
    0;

  let match;

  while (
    (
      match =
        ATTRIBUTE_PATTERN.exec(
          value,
        )
    ) !==
    null
  ) {
    attributes[
      match[1]
    ] =
      match[2];
  }

  return attributes;
}

function findPreviousTaskHeading(
  lines,
  lineIndex,
) {
  for (
    let index =
      lineIndex - 1;
    index >= 0;
    index -= 1
  ) {
    const heading =
      lines[
        index
      ].match(
        TASK_HEADING_PATTERN,
      );

    if (!heading) {
      continue;
    }

    if (
      /^###/.test(
        lines[
          index
        ],
      )
    ) {
      continue;
    }

    return cleanTaskTitle(
      heading[1],
    );
  }

  return null;
}

function parseLabStructure(
  source,
) {
  const normalized =
    normalizeLineEndings(
      source,
    );

  /*
   * El front matter se obtiene del documento original.
   * Después eliminamos comentarios HTML únicamente para
   * analizar Tasks y Steps reales.
   */
  const frontMatter =
    parseSimpleFrontMatter(
      normalized,
    );

  const trackingEnabled =
    parseBoolean(
      frontMatter.tracking,
    );

  if (!trackingEnabled) {
    throw new Error(
      'El Lab no tiene tracking: true.',
    );
  }

  const courseId =
    frontMatter.course_id;

  const labId =
    frontMatter.lab_id;

  validateTrackingId(
    courseId,
    'course_id',
  );

  validateTrackingId(
    labId,
    'lab_id',
  );

  const structureSource =
    stripHtmlComments(
      normalized,
    );

  const lines =
    structureSource.split(
      '\n',
    );

  const tasks =
    [];

  const taskById =
    new Map();

  const globalStepIds =
    new Set();

  let currentTask =
    null;

  for (
    let lineIndex =
      0;
    lineIndex <
    lines.length;
    lineIndex += 1
  ) {
    const line =
      lines[
        lineIndex
      ];

    const taskMatch =
      line.match(
        TASK_ASSIGN_PATTERN,
      );

    if (taskMatch) {
      const taskId =
        taskMatch[1].trim();

      validateTrackingId(
        taskId,
        'task_id',
      );

      if (
        taskById.has(
          taskId,
        )
      ) {
        throw new Error(
          `task_id duplicado: "${taskId}".`,
        );
      }

      const task = {
        taskId,
        title:
          findPreviousTaskHeading(
            lines,
            lineIndex,
          ),
        position:
          tasks.length +
          1,
        steps:
          [],
      };

      tasks.push(
        task,
      );

      taskById.set(
        taskId,
        task,
      );

      currentTask =
        task;

      continue;
    }

    const stepMatch =
      line.match(
        STEP_INCLUDE_PATTERN,
      );

    if (!stepMatch) {
      continue;
    }

    const attributes =
      parseAttributes(
        stepMatch[1],
      );

    const stepId =
      attributes.id?.trim();

    if (!stepId) {
      throw new Error(
        `Se encontró step_label.html sin id explícito en la línea ${lineIndex + 1}.`,
      );
    }

    validateTrackingId(
      stepId,
      'step_id',
    );

    const explicitTaskId =
      attributes.task_id?.trim();

    const taskId =
      explicitTaskId ||
      currentTask?.taskId;

    if (!taskId) {
      throw new Error(
        `El Step "${stepId}" no tiene task_id asociado en la línea ${lineIndex + 1}.`,
      );
    }

    validateTrackingId(
      taskId,
      'task_id',
    );

    const task =
      taskById.get(
        taskId,
      );

    if (!task) {
      throw new Error(
        `El Step "${stepId}" referencia task_id "${taskId}", pero esa Task no fue declarada previamente.`,
      );
    }

    if (
      globalStepIds.has(
        stepId,
      )
    ) {
      throw new Error(
        `step_id duplicado dentro del Lab: "${stepId}". Los step_id deben ser únicos en todo el Lab.`,
      );
    }

    globalStepIds.add(
      stepId,
    );

    task.steps.push({
      stepId,
      position:
        task.steps.length +
        1,
    });
  }

  if (
    tasks.length ===
    0
  ) {
    throw new Error(
      'No se encontraron Tasks rastreables.',
    );
  }

  for (
    const task
    of tasks
  ) {
    if (
      task.steps.length ===
      0
    ) {
      throw new Error(
        `La Task "${task.taskId}" no contiene Steps rastreables.`,
      );
    }
  }

  return {
    courseId,
    labId,
    tasks,
  };
}

function canonicalManifestContent(
  tasks,
) {
  return JSON.stringify({
    version:
      MANIFEST_VERSION,
    tasks,
  });
}

function calculateManifestHash(
  tasks,
) {
  const canonical =
    canonicalManifestContent(
      tasks,
    );

  return (
    'sha256:' +
    createHash(
      'sha256',
    )
      .update(
        canonical,
        'utf8',
      )
      .digest(
        'hex',
      )
  );
}

function buildManifest(
  tasks,
) {
  return {
    version:
      MANIFEST_VERSION,
    hash:
      calculateManifestHash(
        tasks,
      ),
    tasks,
  };
}

async function writeManifest(
  rootDir,
  labFile,
) {
  const source =
    await readFile(
      labFile,
      'utf8',
    );

  const {
    courseId,
    labId,
    tasks,
  } =
    parseLabStructure(
      source,
    );

  const manifest =
    buildManifest(
      tasks,
    );

  const outputDir =
    join(
      rootDir,
      '.labcontrol',
      'manifests',
      courseId,
    );

  await mkdir(
    outputDir,
    {
      recursive:
        true,
    },
  );

  const outputFile =
    join(
      outputDir,
      `${labId}.json`,
    );

  await writeFile(
    outputFile,
    `${JSON.stringify(
      manifest,
      null,
      2,
    )}\n`,
    'utf8',
  );

  return {
    labFile,
    outputFile,
    courseId,
    labId,
    totalTasks:
      tasks.length,
    totalSteps:
      tasks.reduce(
        (
          total,
          task,
        ) =>
          total +
          task.steps.length,
        0,
      ),
    hash:
      manifest.hash,
  };
}

async function findLabFiles(
  labsDir,
) {
  const entries =
    await readdir(
      labsDir,
      {
        withFileTypes:
          true,
      },
    );

  const files =
    [];

  for (
    const entry
    of entries
  ) {
    if (
      !entry.isDirectory() ||
      !/^lab\d+$/.test(
        entry.name,
      )
    ) {
      continue;
    }

    const labFile =
      join(
        labsDir,
        entry.name,
        `${entry.name}.md`,
      );

    try {
      await readFile(
        labFile,
        'utf8',
      );

      files.push(
        labFile,
      );
    } catch {
      // Ignora carpetas sin labN.md.
    }
  }

  return files.sort(
    (
      left,
      right,
    ) => {
      const leftNumber =
        Number(
          basename(
            dirname(
              left,
            ),
          ).replace(
            'lab',
            '',
          ),
        );

      const rightNumber =
        Number(
          basename(
            dirname(
              right,
            ),
          ).replace(
            'lab',
            '',
          ),
        );

      return (
        leftNumber -
        rightNumber
      );
    },
  );
}

function printResult(
  result,
) {
  console.log('');

  console.log(
    `Lab: ${result.courseId}/${result.labId}`,
  );

  console.log(
    `Archivo fuente: ${result.labFile}`,
  );

  console.log(
    `Manifest: ${result.outputFile}`,
  );

  console.log(
    `Tasks: ${result.totalTasks}`,
  );

  console.log(
    `Steps: ${result.totalSteps}`,
  );

  console.log(
    `Hash: ${result.hash}`,
  );
}

async function main() {
  const rootDir =
    process.cwd();

  const argument =
    process.argv[
      2
    ];

  if (!argument) {
    console.error(
      'Uso:',
    );

    console.error(
      '  node scripts/generate_lab_manifest.mjs labs/lab1/lab1.md',
    );

    console.error(
      '  node scripts/generate_lab_manifest.mjs --all',
    );

    process.exitCode =
      1;

    return;
  }

  let files;

  if (
    argument ===
    '--all'
  ) {
    files =
      await findLabFiles(
        resolve(
          rootDir,
          'labs',
        ),
      );
  } else {
    files = [
      resolve(
        rootDir,
        argument,
      ),
    ];
  }

  if (
    files.length ===
    0
  ) {
    throw new Error(
      'No se encontraron Labs para procesar.',
    );
  }

  let generated =
    0;

  for (
    const labFile
    of files
  ) {
    try {
      if (argument === '--all') {
        const source = await readFile(labFile, 'utf8');
        const metadata = parseSimpleFrontMatter(source);

        if (!parseBoolean(metadata.tracking)) {
          console.log(`Lab omitido (tracking deshabilitado): ${labFile}`);
          continue;
        }
      }

      const result =
        await writeManifest(
          rootDir,
          labFile,
        );

      printResult(
        result,
      );

      generated +=
        1;
    } catch (
      error
    ) {
      fail(
        `${labFile}: ${
          error instanceof Error
            ? error.message
            : String(
                error,
              )
        }`,
      );
    }
  }

  if (
    generated >
    0
  ) {
    console.log('');

    console.log(
      `Manifests generados: ${generated}`,
    );
  }
}

main().catch(
  error => {
    fail(
      error instanceof Error
        ? error.message
        : String(
            error,
          ),
    );
  },
);