import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorMapper } from '../lib/errors/error-mapper.ts';
import { ValidationError } from '../lib/errors/app-error.ts';

test('SQLite: нарушение уникальности', () => {
  assert.equal(ErrorMapper.map('UNIQUE constraint failed: local_profiles.email').code, 'DUPLICATE_ENTRY');
});

test('SQLite: нарушение CHECK', () => {
  assert.equal(ErrorMapper.map(new Error('CHECK constraint failed: estimate_min')).code, 'CHECK_FAILED');
});

test('AppError возвращается без изменений', () => {
  const e = new ValidationError('x');
  assert.equal(ErrorMapper.map(e), e);
});

test('неизвестная ошибка получает общий код и читаемый текст', () => {
  const mapped = ErrorMapper.map(new Error('что-то странное'));
  assert.equal(mapped.code, 'INTERNAL_ERROR');
  assert.equal(mapped.message, 'что-то странное');
});

test('TypeError не показывает пользователю технические детали', () => {
  assert.equal(ErrorMapper.map(new TypeError('x is not a function')).message, 'Произошла техническая ошибка в приложении');
});
