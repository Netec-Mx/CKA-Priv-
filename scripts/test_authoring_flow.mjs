#!/usr/bin/env node

import {
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';

import {
  tmpdir,
} from 'node:os';

import {
  join,
  resolve,
} from 'node:path';

import {
  spawn,
  spawnSync,
} from 'node:child_process';

import {
  createServer,
} from 'node:http';

import process from 'node:process';

const REPO_ROOT =
  process.cwd();

const CREATE_SCRIPT =
  resolve(
    REPO_ROOT,
    'scripts',
    'create_labs.sh',
  );

const INSERT_SCRIPT =
  resolve(
    REPO_ROOT,
    'scripts',
    'insert_lab.sh',
  );

const NORMALIZER =
  resolve(
    REPO_ROOT,
    'scripts',
    'normalize_course_labs.mjs',
  );

const CATALOG_GENERATOR =
  resolve(
    REPO_ROOT,
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

function run(
  root,
  command,
  args,
  env = {},
) {
  const {
    LABCONTROL_API_URL:
      _labControlApiUrl,
    LABCONTROL_AUTHORING_SYNC_TOKEN:
      _labControlAuthoringToken,
    ...baseEnv
  } =
    process.env;

  const result =
    spawnSync(
      command,
      args,
      {
        cwd:
          root,
        encoding:
          'utf8',
        env: {
          ...baseEnv,
          ...env,
        },
      },
    );

  if (
    result.status !==
    0
  ) {
    throw new Error(
      [
        `Comando falló: ${command} ${args.join(' ')}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  return result;
}

function runCreate(
  root,
  count,
  courseId,
) {
  return run(
    root,
    'bash',
    [
      CREATE_SCRIPT,
      String(count),
      courseId,
    ],
    {
      ROOT_DIR:
        'labs',
    },
  );
}

async function runCreateWithServer(
  root,
  count,
  courseId,
) {
  let requestBody =
    '';

  let requestMethod =
    null;

  let requestUrl =
    null;

  const server =
    createServer(
      (
        request,
        response,
      ) => {
        requestMethod =
          request.method;

        requestUrl =
          request.url;

        request.setEncoding(
          'utf8',
        );

        request.on(
          'data',
          chunk => {
            requestBody +=
              chunk;
          },
        );

        request.on(
          'end',
          () => {
            response.writeHead(
              200,
              {
                'Content-Type':
                  'application/json',
              },
            );

            response.end(
              JSON.stringify({
                synchronized:
                  true,
                catalog: {
                  created:
                    1,
                  updated:
                    0,
                  manifestSynced:
                    1,
                  deactivated:
                    0,
                  unchanged:
                    0,
                },
              }),
            );
          },
        );
      },
    );

  await new Promise(
    (
      resolveListen,
      rejectListen,
    ) => {
      server.once(
        'error',
        rejectListen,
      );

      server.listen(
        0,
        '127.0.0.1',
        resolveListen,
      );
    },
  );

  const address =
    server.address();

  if (
    !address ||
    typeof address ===
      'string'
  ) {
    server.close();

    throw new Error(
      'No se pudo obtener el puerto del servidor de prueba.',
    );
  }

  try {
    const result =
      await new Promise(
        (
          resolveProcess,
          rejectProcess,
        ) => {
          const child =
            spawn(
              'bash',
              [
                CREATE_SCRIPT,
                String(count),
                courseId,
              ],
              {
                cwd:
                  root,
                env: {
                  ...process.env,
                  ROOT_DIR:
                    'labs',
                  LABCONTROL_API_URL:
                    `http://127.0.0.1:${address.port}`,
                  LABCONTROL_AUTHORING_SYNC_TOKEN:
                    'lcat_test-authoring-token',
                },
              },
            );

          let stdout =
            '';

          let stderr =
            '';

          child.stdout.setEncoding(
            'utf8',
          );

          child.stderr.setEncoding(
            'utf8',
          );

          child.stdout.on(
            'data',
            chunk => {
              stdout +=
                chunk;
            },
          );

          child.stderr.on(
            'data',
            chunk => {
              stderr +=
                chunk;
            },
          );

          child.once(
            'error',
            rejectProcess,
          );

          child.once(
            'close',
            code => {
              resolveProcess({
                status:
                  code,
                stdout,
                stderr,
              });
            },
          );
        },
      );

    if (
      result.status !==
        0
    ) {
      throw new Error(
        [
          'create_labs.sh falló durante el test HTTP.',
          result.stdout,
          result.stderr,
        ]
          .filter(Boolean)
          .join(
            '\n',
          ),
      );
    }

    return {
      result,
      requestBody,
      requestMethod,
      requestUrl,
    };
  } finally {
    await new Promise(
      resolveClose => {
        server.close(
          resolveClose,
        );
      },
    );
  }
}

function runInsert(
  root,
  position,
  courseId,
) {
  return run(
    root,
    'bash',
    [
      INSERT_SCRIPT,
      String(position),
      courseId,
    ],
    {
      ROOT_DIR:
        'labs',
    },
  );
}

async function readLab(
  root,
  folderNumber,
) {
  return readFile(
    join(
      root,
      'labs',
      `lab${folderNumber}`,
      `lab${folderNumber}.md`,
    ),
    'utf8',
  );
}

function scalar(
  source,
  key,
) {
  const match =
    source.match(
      new RegExp(
        `^${key}:\\s*(.*?)\\s*$`,
        'm',
      ),
    );

  return match?.[1] ??
    null;
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
  } catch (error) {
    console.error(
      `✗ ${name}`,
    );

    console.error(
      error instanceof Error
        ? error.message
        : String(error),
    );

    failed += 1;
  }
}

async function createRoot() {
  return mkdtemp(
    join(
      tmpdir(),
      'jekyll-authoring-',
    ),
  );
}

await test(
  'crea Labs iniciales con identidades estables consecutivas',
  async () => {
    const root =
      await createRoot();

    try {
      runCreate(
        root,
        3,
        'curso-demo',
      );

      const lab1 =
        await readLab(
          root,
          1,
        );

      const lab2 =
        await readLab(
          root,
          2,
        );

      const lab3 =
        await readLab(
          root,
          3,
        );

      assert(
        scalar(
          lab1,
          'lab_id',
        ) === 'l001',
        'lab1 debía usar l001.',
      );

      assert(
        scalar(
          lab2,
          'lab_id',
        ) === 'l002',
        'lab2 debía usar l002.',
      );

      assert(
        scalar(
          lab3,
          'lab_id',
        ) === 'l003',
        'lab3 debía usar l003.',
      );

      const catalog =
        JSON.parse(
          await readFile(
            join(
              root,
              'labcontrol',
              'curso-demo',
              'course.json',
            ),
            'utf8',
          ),
        );

      assert(
        catalog.labs.length === 3,
        'create_labs.sh debía generar un catálogo con 3 Labs.',
      );

      assert(
        catalog.labs
          .map(
            lab =>
              lab.labId,
          )
          .join(',') ===
          'l001,l002,l003',
        'El catálogo inicial no conserva el orden esperado.',
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
  'create_labs soporta authoring sync --dry-run sin hacer HTTP',
  async () => {
    const root =
      await createRoot();

    try {
      const result =
        run(
          root,
          'bash',
          [
            CREATE_SCRIPT,
            '1',
            'curso-demo',
            '--dry-run',
          ],
          {
            ROOT_DIR:
              'labs',
          },
        );

      assert(
        result.stdout.includes(
          'LabControl authoring sync: DRY RUN',
        ),
        'create_labs.sh debía ejecutar el dry-run de LabControl.',
      );

      assert(
        result.stdout.includes(
          'Course ID: curso-demo',
        ),
        'El dry-run debía identificar curso-demo.',
      );

      assert(
        result.stdout.includes(
          'Labs: 1',
        ),
        'El dry-run debía detectar 1 Lab.',
      );

      assert(
        result.stdout.includes(
          'Snapshots: 1',
        ),
        'El dry-run debía detectar 1 snapshot.',
      );

      assert(
        result.stdout.includes(
          'HTTP PUT: omitido por --dry-run',
        ),
        'El dry-run no debía ejecutar el PUT.',
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
  'create_labs sincroniza automáticamente cuando LabControl está configurado',
  async () => {
    const root =
      await createRoot();

    try {
      const {
        result,
        requestBody,
        requestMethod,
        requestUrl,
      } =
        await runCreateWithServer(
          root,
          1,
          'curso-demo',
        );

      assert(
        requestMethod ===
          'PUT',
        `Se esperaba PUT y se recibió ${requestMethod}.`,
      );

      assert(
        requestUrl ===
          '/authoring-sync/courses/curso-demo',
        `Endpoint inesperado: ${requestUrl}.`,
      );

      const payload =
        JSON.parse(
          requestBody,
        );

      assert(
        payload.catalog.courseId ===
          'curso-demo',
        'El payload debía pertenecer a curso-demo.',
      );

      assert(
        payload.catalog.labs.length ===
          1,
        'El payload debía contener 1 Lab.',
      );

      assert(
        payload.snapshots.length ===
          1,
        'El payload debía contener 1 snapshot.',
      );

      assert(
        result.stdout.includes(
          'Sincronizado: curso-demo',
        ),
        'create_labs.sh debía completar el sync automático.',
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
  'create_labs rechaza configuración parcial de LabControl',
  async () => {
    const root =
      await createRoot();

    try {
      const result =
        spawnSync(
          'bash',
          [
            CREATE_SCRIPT,
            '1',
            'curso-demo',
          ],
          {
            cwd:
              root,
            encoding:
              'utf8',
            env: {
              ...process.env,
              ROOT_DIR:
                'labs',
              LABCONTROL_API_URL:
                'http://127.0.0.1:3101',
              LABCONTROL_AUTHORING_SYNC_TOKEN:
                '',
            },
          },
        );

      assert(
        result.status !==
          0,
        'La configuración parcial debía fallar.',
      );

      assert(
        (
          result.stdout +
          result.stderr
        ).includes(
          'configuración incompleta de LabControl',
        ),
        'Debía explicar que faltan variables de LabControl.',
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
  'no reutiliza un lab_id retirado',
  async () => {
    const root =
      await createRoot();

    try {
      runCreate(
        root,
        4,
        'curso-demo',
      );

      await rm(
        join(
          root,
          'labs',
          'lab3',
        ),
        {
          recursive:
            true,
          force:
            true,
        },
      );

      runCreate(
        root,
        4,
        'curso-demo',
      );

      const recreated =
        await readLab(
          root,
          3,
        );

      assert(
        scalar(
          recreated,
          'lab_id',
        ) === 'l005',
        'El Lab recreado debía recibir l005 y no reutilizar l003.',
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
          'next_lab_id: 6',
        ),
        'El registro debía avanzar a next_lab_id 6.',
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
  'inserta un Lab al inicio sin cambiar identidades existentes',
  async () => {
    const root =
      await createRoot();

    try {
      runCreate(
        root,
        3,
        'curso-demo',
      );

      runInsert(
        root,
        1,
        'curso-demo',
      );

      const lab1 =
        await readLab(
          root,
          1,
        );

      const lab2 =
        await readLab(
          root,
          2,
        );

      const lab3 =
        await readLab(
          root,
          3,
        );

      const lab4 =
        await readLab(
          root,
          4,
        );

      assert(
        scalar(
          lab1,
          'lab_id',
        ) === 'l001',
        'l001 cambió de identidad.',
      );

      assert(
        scalar(
          lab2,
          'lab_id',
        ) === 'l002',
        'l002 cambió de identidad.',
      );

      assert(
        scalar(
          lab3,
          'lab_id',
        ) === 'l003',
        'l003 cambió de identidad.',
      );

      assert(
        scalar(
          lab4,
          'lab_id',
        ) === 'l004',
        'El nuevo Lab debía recibir l004.',
      );

      assert(
        scalar(
          lab4,
          'position',
        ) === '1',
        'El nuevo Lab debía quedar en position 1.',
      );

      assert(
        scalar(
          lab1,
          'position',
        ) === '2',
        'l001 debía desplazarse a position 2.',
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
  'inserta un Lab en medio y normaliza navegación',
  async () => {
    const root =
      await createRoot();

    try {
      runCreate(
        root,
        3,
        'curso-demo',
      );

      runInsert(
        root,
        2,
        'curso-demo',
      );

      const lab1 =
        await readLab(
          root,
          1,
        );

      const lab2 =
        await readLab(
          root,
          2,
        );

      const lab3 =
        await readLab(
          root,
          3,
        );

      const lab4 =
        await readLab(
          root,
          4,
        );

      assert(
        scalar(
          lab4,
          'lab_id',
        ) === 'l004',
        'El nuevo Lab debía usar l004.',
      );

      assert(
        scalar(
          lab4,
          'position',
        ) === '2',
        'l004 debía quedar en position 2.',
      );

      assert(
        scalar(
          lab1,
          'next',
        ) === '/lab4/lab4/',
        'next de l001 incorrecto.',
      );

      assert(
        scalar(
          lab4,
          'prev',
        ) === '/lab1/lab1/',
        'prev de l004 incorrecto.',
      );

      assert(
        scalar(
          lab4,
          'next',
        ) === '/lab2/lab2/',
        'next de l004 incorrecto.',
      );

      assert(
        scalar(
          lab2,
          'prev',
        ) === '/lab4/lab4/',
        'prev de l002 incorrecto.',
      );

      assert(
        scalar(
          lab3,
          'next',
        ) === '/',
        'El último Lab debía terminar en "/".',
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
  'inserta un Lab al final',
  async () => {
    const root =
      await createRoot();

    try {
      runCreate(
        root,
        3,
        'curso-demo',
      );

      runInsert(
        root,
        4,
        'curso-demo',
      );

      const lab4 =
        await readLab(
          root,
          4,
        );

      assert(
        scalar(
          lab4,
          'lab_id',
        ) === 'l004',
        'El nuevo Lab debía usar l004.',
      );

      assert(
        scalar(
          lab4,
          'position',
        ) === '4',
        'El nuevo Lab debía quedar al final.',
      );

      assert(
        scalar(
          lab4,
          'next',
        ) === '/',
        'El Lab final debía tener next "/".',
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
  'genera course.json respetando el orden lógico',
  async () => {
    const root =
      await createRoot();

    try {
      runCreate(
        root,
        3,
        'curso-demo',
      );

      runInsert(
        root,
        2,
        'curso-demo',
      );

      run(
        root,
        process.execPath,
        [
          CATALOG_GENERATOR,
        ],
        {
          ROOT_DIR:
            'labs',
        },
      );

      const catalog =
        JSON.parse(
          await readFile(
            join(
              root,
              'labcontrol',
              'curso-demo',
              'course.json',
            ),
            'utf8',
          ),
        );

      assert(
        catalog.labs.length ===
          4,
        'El catálogo debía contener 4 Labs.',
      );

      const order =
        catalog.labs.map(
          lab =>
            lab.labId,
        );

      assert(
        JSON.stringify(
          order,
        ) ===
          JSON.stringify(
            [
              'l001',
              'l004',
              'l002',
              'l003',
            ],
          ),
        `Orden de catálogo incorrecto: ${order.join(', ')}`,
      );

      assert(
        catalog.labs.every(
          (
            lab,
            index,
          ) =>
            lab.number ===
              index + 1 &&
            lab.position ===
              index + 1,
        ),
        'number/position del catálogo no son consecutivos.',
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
