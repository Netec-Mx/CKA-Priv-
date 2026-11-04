#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';

try {
  const location = process.argv[2];
  if (!location) throw Error('Ruta de identidad requerida.');
  const identity = JSON.parse(readFileSync(location, 'utf8'));
  if (!/^[A-Z0-9][A-Z0-9_]{1,49}$/.test(identity.code ?? '') ||
      !/^[a-z0-9]{2,20}$/.test(identity.trackingId ?? '') ||
      !String(identity.name ?? '').trim()) {
    throw Error('Identidad incompleta o inválida.');
  }
  process.stdout.write(identity.trackingId + '\n');
} catch (error) {
  console.error('Error al leer identidad: ' + error.message);
  process.exitCode = 1;
}
