import test from 'node:test';
import assert from 'node:assert/strict';
import { isExplicitConfirmation } from '../src/tools/calendar.js';

test('acepta confirmaciones explícitas', () => {
  for (const text of ['Sí, confirmo esa fecha y hora', 'Dale', 'Correcto', 'Listo, agéndala']) {
    assert.equal(isExplicitConfirmation(text), true, text);
  }
});

test('rechaza selección, negación y cambios', () => {
  for (const text of ['La primera opción me sirve', 'No, mejor otra', 'Cambia la hora', 'Después te confirmo']) {
    assert.equal(isExplicitConfirmation(text), false, text);
  }
});
