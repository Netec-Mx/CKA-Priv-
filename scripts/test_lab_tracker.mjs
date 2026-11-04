#!/usr/bin/env node

import {
  readFile,
} from 'node:fs/promises';

import {
  resolve,
} from 'node:path';

import vm from 'node:vm';

const TRACKER_PATH =
  resolve(
    process.cwd(),
    'assets',
    'js',
    'lab-tracker.js',
  );

const trackerSource =
  await readFile(
    TRACKER_PATH,
    'utf8',
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
        ? error.stack ??
          error.message
        : String(
            error,
          ),
    );

    failed += 1;
  }
}

class MemoryStorage {
  constructor(
    initial = {},
  ) {
    this.values =
      new Map(
        Object.entries(
          initial,
        ),
      );
  }

  getItem(
    key,
  ) {
    return this.values.has(
      key,
    )
      ? this.values.get(
          key,
        )
      : null;
  }

  setItem(
    key,
    value,
  ) {
    this.values.set(
      key,
      String(
        value,
      ),
    );
  }

  removeItem(
    key,
  ) {
    this.values.delete(
      key,
    );
  }

  clear() {
    this.values.clear();
  }
}

class FakeEventTarget {
  constructor() {
    this.listeners =
      new Map();
  }

  addEventListener(
    type,
    listener,
  ) {
    if (
      !this.listeners.has(
        type,
      )
    ) {
      this.listeners.set(
        type,
        [],
      );
    }

    this.listeners
      .get(
        type,
      )
      .push(
        listener,
      );
  }

  dispatchEvent(
    event,
  ) {
    const listeners =
      this.listeners.get(
        event.type,
      ) ?? [];

    for (
      const listener
      of listeners
    ) {
      listener.call(
        this,
        event,
      );
    }

    return true;
  }
}

class FakeCustomEvent {
  constructor(
    type,
    options = {},
  ) {
    this.type =
      type;

    this.detail =
      options.detail;
  }
}

function createStep(
  taskId,
  stepId,
) {
  return {
    dataset: {
      taskId,
      stepId,
    },
  };
}

function createResponse({
  status = 200,
  body = null,
} = {}) {
  return {
    status,

    ok:
      status >= 200 &&
      status < 300,

    async json() {
      return body;
    },
  };
}

function createBrowser({
  localStorage,
  sessionStorage,
  fetchImpl,
  online = true,
} = {}) {
  const document =
    new FakeEventTarget();

  const window =
    new FakeEventTarget();

  const navigator = {
    onLine:
      online,
  };

  const steps = [
    createStep(
      't001',
      's001',
    ),
    createStep(
      't001',
      's002',
    ),
  ];

  const root = {
    dataset: {
      tracking:
        'true',
      courseId:
        'terraform-aws-essentials',
      labId:
        'l001',
      trackingApi:
        'https://labcontrol.test/api',
    },

    querySelectorAll(
      selector,
    ) {
      if (
        selector ===
        '.step-label[data-step-id][data-task-id]'
      ) {
        return steps;
      }

      return [];
    },
  };

  document.createElement = () => ({
    setAttribute() {},
    style: {},
    textContent: '',
  });
  document.body = { appendChild() {} };

  document.readyState =
    'complete';

  document.visibilityState =
    'visible';

  document.querySelector =
    selector =>
      selector ===
      'article.lab'
        ? root
        : null;

  window.location = {
    hash:
      '',
    pathname:
      '/lab1/lab1/',
    search:
      '',
  };

  window.history = {
    replaceState() {},
  };

  /*
   * lab-tracker mantiene viva la sesión real con
   * un heartbeat periódico. En este navegador
   * simulado no ejecutamos timers reales.
   */
  window.setInterval =
    () => 1;

  window.clearInterval =
    () => {};

  const context =
    vm.createContext({
      console,

      document,
      window,
      navigator,

      localStorage,
      sessionStorage,

      fetch:
        fetchImpl,

      CustomEvent:
        FakeCustomEvent,

      URL,
      JSON,
      Date,
      Promise,
      Set,
      Map,

      setTimeout,
      clearTimeout,
    });

  vm.runInContext(
    trackerSource,
    context,
    {
      filename:
        TRACKER_PATH,
    },
  );

  return {
    document,
    window,
    navigator,
    root,
    steps,
  };
}

async function settle(
  rounds = 8,
) {
  for (
    let index = 0;
    index < rounds;
    index += 1
  ) {
    await new Promise(
      resolve => {
        setImmediate(
          resolve,
        );
      },
    );
  }
}

const ACCESS_TOKEN_KEY =
  'netec:participantAccessToken';

const QUEUE_KEY =
  'netec:trackingQueue:' +
  'terraform-aws-essentials:' +
  'l001';


await test(
  '403 bloquea y descarta cambios rechazados sin reenvío posterior',
  async () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage({
      [ACCESS_TOKEN_KEY]: 'participant-access-token',
    });
    const methods = [];
    let serverStatus = 403;
    const browser = createBrowser({
      localStorage, sessionStorage,
      fetchImpl: async (url, options = {}) => {
        methods.push(options.method || 'GET');
        if (url.endsWith('/tracking/step')) {
          return createResponse({ status: serverStatus });
        }
        if (url.endsWith('/tracking/progress')) {
          return createResponse({ body: { labs: [] } });
        }
        throw new Error('Unexpected URL: ' + url);
      },
    });
    browser.document.dispatchEvent(new FakeCustomEvent('lab-progress-change', {
      detail: { labId: 'l001', changes: [
        { taskId: 't001', stepId: 's001', isCompleted: true },
      ] },
    }));
    await settle();
    assert(methods.filter(x => x === 'PATCH').length === 1,
      'Debe intentar un solo PATCH que devuelve 403.');
    assert(JSON.parse(localStorage.getItem(QUEUE_KEY)).items.length === 0,
      'El 403 debe descartar cambios no autorizados.');
    serverStatus = 200;
    browser.window.dispatchEvent({ type: 'online' });
    browser.document.dispatchEvent(new FakeCustomEvent('lab-progress-change', {
      detail: { labId: 'l001', changes: [
        { taskId: 't001', stepId: 's002', isCompleted: true },
      ] },
    }));
    await settle();
    assert(methods.filter(x => x === 'PATCH').length === 1,
      'Un desbloqueo posterior no debe reenviar los cambios rechazados de la pestaña.');
  },
);

await test(
  'conserva cambios offline, reintenta y converge con la API',
  async () => {
    const localStorage =
      new MemoryStorage();

    const sessionStorage =
      new MemoryStorage({
        [ACCESS_TOKEN_KEY]:
          'participant-access-token',
      });

    const requests = [];

    let failNextPatch =
      true;

    const fetchImpl =
      async (
        url,
        options = {},
      ) => {
        requests.push({
          url,
          method:
            options.method ??
            'GET',
          body:
            options.body ??
            null,
        });

        if (
          url.endsWith(
            '/tracking/step',
          )
        ) {
          if (
            failNextPatch
          ) {
            failNextPatch =
              false;

            throw new Error(
              'offline',
            );
          }

          return createResponse({
            status:
              200,
          });
        }

        if (
          url.endsWith(
            '/tracking/progress',
          )
        ) {
          return createResponse({
            body: {
              labs: [
                {
                  labTrackingId:
                    'l001',
                  steps: [
                    {
                      taskId:
                        't001',
                      stepId:
                        's001',
                      isCompleted:
                        true,
                    },
                    {
                      taskId:
                        't001',
                      stepId:
                        's002',
                      isCompleted:
                        false,
                    },
                  ],
                },
              ],
            },
          });
        }

        throw new Error(
          `Unexpected URL: ${url}`,
        );
      };

    const browser =
      createBrowser({
        localStorage,
        sessionStorage,
        fetchImpl,
        online:
          false,
      });

    const appliedStates =
      [];

    browser.document.addEventListener(
      'lab-progress-apply',
      event => {
        appliedStates.push(
          event.detail,
        );
      },
    );

    browser.document.dispatchEvent(
      new FakeCustomEvent(
        'lab-progress-change',
        {
          detail: {
            labId:
              'l001',
            changes: [
              {
                taskId:
                  't001',
                stepId:
                  's001',
                isCompleted:
                  true,
              },
            ],
          },
        },
      ),
    );

    await settle();

    const offlineQueue =
      JSON.parse(
        localStorage.getItem(
          QUEUE_KEY,
        ),
      );

    assert(
      offlineQueue.items.length ===
        1,
      'El cambio offline no quedó en la cola.',
    );

    assert(
      requests.length ===
        0,
      'No debe intentar requests mientras navigator.onLine=false.',
    );

    /*
     * Primera reconexión:
     * el PATCH falla y la cola debe permanecer intacta.
     */
    browser.navigator.onLine =
      true;

    browser.window.dispatchEvent({
      type:
        'online',
    });

    await settle();

    const failedQueue =
      JSON.parse(
        localStorage.getItem(
          QUEUE_KEY,
        ),
      );

    assert(
      failedQueue.items.length ===
        1,
      'Un error de red eliminó incorrectamente la cola.',
    );

    assert(
      requests.filter(
        request =>
          request.method ===
          'PATCH',
      ).length ===
        1,
      'Se esperaba un único PATCH fallido.',
    );

    assert(
      requests.filter(
        request =>
          request.method ===
          'GET',
      ).length ===
        0,
      'No debe hacer pull del servidor mientras exista cola pendiente.',
    );

    /*
     * Segunda reconexión:
     * el PATCH funciona; después puede hacer GET.
     */
    browser.window.dispatchEvent({
      type:
        'online',
    });

    await settle();

    const finalQueue =
      JSON.parse(
        localStorage.getItem(
          QUEUE_KEY,
        ),
      );

    assert(
      finalQueue.items.length ===
        0,
      'La cola no quedó vacía después del retry exitoso.',
    );

    const patchRequests =
      requests.filter(
        request =>
          request.method ===
          'PATCH',
      );

    const getRequests =
      requests.filter(
        request =>
          request.method ===
          'GET',
      );

    assert(
      patchRequests.length ===
        2,
      'El retry debe producir exactamente dos intentos de PATCH.',
    );

    assert(
      getRequests.length ===
        1,
      'Después de vaciar la cola debe recuperar el estado del servidor.',
    );

    const patchBody =
      JSON.parse(
        patchRequests[1].body,
      );

    assert(
      patchBody.courseTrackingId ===
        'terraform-aws-essentials',
      'courseTrackingId incorrecto.',
    );

    assert(
      patchBody.labTrackingId ===
        'l001',
      'labTrackingId incorrecto.',
    );

    assert(
      patchBody.taskId ===
        't001' &&
        patchBody.stepId ===
          's001',
      'taskId/stepId incorrectos.',
    );

    assert(
      patchBody.isCompleted ===
        true,
      'isCompleted incorrecto.',
    );

    assert(
      appliedStates.length ===
        1,
      'El estado confirmado no fue aplicado exactamente una vez.',
    );

    assert(
      appliedStates[0].labId ===
        'l001',
      'labId incorrecto en lab-progress-apply.',
    );

    assert(
      appliedStates[0]
        .completedStepIds
        .length ===
        1 &&
        appliedStates[0]
          .completedStepIds[0] ===
          's001',
      'completedStepIds incorrectos.',
    );

    await settle();

    assert(
      requests.filter(
        request =>
          request.method ===
          'PATCH',
      ).length ===
        2,
      'Aplicar estado del servidor generó un PATCH duplicado.',
    );
  },
);

await test(
  'recupera la sesión después de recargar y hace pull sin duplicar PATCH',
  async () => {
    const localStorage =
      new MemoryStorage();

    const sessionStorage =
      new MemoryStorage({
        [ACCESS_TOKEN_KEY]:
          'participant-access-token',
      });

    const requests = [];

    const fetchImpl =
      async (
        url,
        options = {},
      ) => {
        requests.push({
          url,
          method:
            options.method ??
            'GET',
          body:
            options.body ??
            null,
        });

        if (
          url.endsWith(
            '/tracking/progress',
          )
        ) {
          return createResponse({
            body: {
              labs: [
                {
                  labTrackingId:
                    'l001',
                  steps: [
                    {
                      taskId:
                        't001',
                      stepId:
                        's001',
                      isCompleted:
                        true,
                    },
                  ],
                },
              ],
            },
          });
        }

        if (
          url.endsWith(
            '/tracking/step',
          )
        ) {
          return createResponse({
            status:
              200,
          });
        }

        throw new Error(
          `Unexpected URL: ${url}`,
        );
      };

    const browser =
      createBrowser({
        localStorage,
        sessionStorage,
        fetchImpl,
        online:
          true,
      });

    const appliedStates =
      [];

    browser.document.addEventListener(
      'lab-progress-apply',
      event => {
        appliedStates.push(
          event.detail,
        );
      },
    );

    await settle();

    assert(
      sessionStorage.getItem(
        ACCESS_TOKEN_KEY,
      ) ===
        'participant-access-token',
      'El accessToken no sobrevivió a la recarga simulada.',
    );

    assert(
      requests.filter(
        request =>
          request.method ===
          'GET',
      ).length ===
        1,
      'La recarga debe recuperar progreso desde la API.',
    );

    assert(
      requests.filter(
        request =>
          request.method ===
          'PATCH',
      ).length ===
        0,
      'La recarga sin cambios locales no debe producir PATCH.',
    );

    assert(
      appliedStates.length ===
        1,
      'La recarga no aplicó el progreso confirmado.',
    );
  },
);


await test(
  'conserva el cambio más reciente mientras un PATCH está en vuelo',
  async () => {
    const localStorage =
      new MemoryStorage();

    const sessionStorage =
      new MemoryStorage({
        [ACCESS_TOKEN_KEY]:
          'participant-access-token',
      });

    const requests = [];

    let resolveFirstPatch;

    const firstPatch =
      new Promise(
        resolve => {
          resolveFirstPatch =
            resolve;
        },
      );

    let patchCount =
      0;

    const fetchImpl =
      async (
        url,
        options = {},
      ) => {
        requests.push({
          url,
          method:
            options.method ??
            'GET',
          body:
            options.body ??
            null,
        });

        if (
          url.endsWith(
            '/tracking/step',
          )
        ) {
          patchCount +=
            1;

          if (
            patchCount ===
            1
          ) {
            await firstPatch;
          }

          return createResponse({
            status:
              200,
          });
        }

        if (
          url.endsWith(
            '/tracking/progress',
          )
        ) {
          return createResponse({
            body: {
              labs: [
                {
                  labTrackingId:
                    'l001',
                  steps:
                    [],
                },
              ],
            },
          });
        }

        throw new Error(
          `Unexpected URL: ${url}`,
        );
      };

    const browser =
      createBrowser({
        localStorage,
        sessionStorage,
        fetchImpl,
        online:
          false,
      });

    /*
     * Esperar a que initLabTracker termine y registre
     * también los listeners de reconexión.
     */
    await settle();

    browser.navigator.onLine =
      true;

    /*
     * Primer cambio: s001 = true.
     *
     * Esto inicia el primer PATCH, que dejamos
     * deliberadamente pendiente.
     */
    browser.document.dispatchEvent(
      new FakeCustomEvent(
        'lab-progress-change',
        {
          detail: {
            labId:
              'l001',
            changes: [
              {
                taskId:
                  't001',
                stepId:
                  's001',
                isCompleted:
                  true,
              },
            ],
          },
        },
      ),
    );

    await settle(
      2,
    );

    assert(
      requests.filter(
        request =>
          request.method ===
          'PATCH',
      ).length ===
        1,
      'El primer cambio debe iniciar exactamente un PATCH.',
    );

    /*
     * Mientras ese PATCH sigue en vuelo, el participante
     * revierte el mismo Step.
     */
    browser.document.dispatchEvent(
      new FakeCustomEvent(
        'lab-progress-change',
        {
          detail: {
            labId:
              'l001',
            changes: [
              {
                taskId:
                  't001',
                stepId:
                  's001',
                isCompleted:
                  false,
              },
            ],
          },
        },
      ),
    );

    await settle(
      2,
    );

    const queueWhilePending =
      JSON.parse(
        localStorage.getItem(
          QUEUE_KEY,
        ),
      );

    assert(
      queueWhilePending.items.length ===
        1,
      'La cola debe contener solamente el estado más reciente.',
    );

    assert(
      queueWhilePending.items[0]
        .isCompleted ===
        false,
      'El cambio más reciente false fue sobrescrito por el PATCH en vuelo.',
    );

    /*
     * Confirmar ahora el primer PATCH (true).
     *
     * flushQueue debe recargar localStorage y detectar
     * que existe un estado más reciente (false).
     */
    resolveFirstPatch();

    await settle();

    const patchRequests =
      requests.filter(
        request =>
          request.method ===
          'PATCH',
      );

    assert(
      patchRequests.length ===
        2,
      'Se esperaban exactamente dos PATCH: true y luego false.',
    );

    const firstBody =
      JSON.parse(
        patchRequests[0].body,
      );

    const secondBody =
      JSON.parse(
        patchRequests[1].body,
      );

    assert(
      firstBody.taskId ===
        't001' &&
        firstBody.stepId ===
          's001' &&
        firstBody.isCompleted ===
          true,
      'El primer PATCH no representa el estado true inicial.',
    );

    assert(
      secondBody.taskId ===
        't001' &&
        secondBody.stepId ===
          's001' &&
        secondBody.isCompleted ===
          false,
      'El segundo PATCH no conserva el estado false más reciente.',
    );

    const finalQueue =
      JSON.parse(
        localStorage.getItem(
          QUEUE_KEY,
        ),
      );

    assert(
      finalQueue.items.length ===
        0,
      'La cola debe quedar vacía después de confirmar ambos estados.',
    );
  },
);

console.log(
  `\nTests: ${passed} passed, ${failed} failed`,
);

if (
  failed > 0
) {
  process.exitCode =
    1;
}
