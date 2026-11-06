import test from 'node:test';
import assert from 'node:assert/strict';
import { localDb } from '../lib/db-local.ts';
import { authService } from '../lib/auth-service.ts';
import { dataService } from '../lib/data-service.ts';
import { freshDb, memoryStore } from './helpers.ts';

async function setup() {
  await freshDb();
  authService.setStore(memoryStore());
  const user = await authService.register('vlad', 'vlad@example.com', 'correct-horse');
  return user;
}

const task = (title: string, estimate_min: number) => ({
  title,
  estimate_min,
  priority: 'medium' as const,
  deadline: null,
  description: null,
});

test('регистрация создаёт личное рабочее пространство и хранит хеш, а не пароль', async () => {
  const user = await setup();
  assert.ok(user.workspaceId);
  const [row] = await localDb.query<{ password_hash: string }>('SELECT password_hash FROM local_profiles');
  assert.ok(row.password_hash.startsWith('pbkdf2$'));
  assert.ok(!row.password_hash.includes('correct-horse'));
});

test('вход по почте и по никнейму, неверный пароль отклоняется', async () => {
  await setup();
  authService.logout();
  assert.equal((await authService.login('vlad@example.com', 'correct-horse')).nickname, 'vlad');
  assert.equal((await authService.login('VLAD', 'correct-horse')).nickname, 'vlad');
  await assert.rejects(authService.login('vlad', 'wrong-password'), { code: 'BAD_CREDENTIALS' });
  await assert.rejects(authService.login('nobody', 'correct-horse'), { code: 'BAD_CREDENTIALS' });
});

test('никнейм уникален без учёта регистра, почта тоже', async () => {
  await setup();
  await assert.rejects(authService.register('VLAD', 'other@example.com', 'correct-horse'), { code: 'NICKNAME_TAKEN' });
  await assert.rejects(authService.register('other', 'VLAD@example.com', 'correct-horse'), { code: 'EMAIL_TAKEN' });
});

test('валидация регистрации', async () => {
  await freshDb();
  authService.setStore(memoryStore());
  await assert.rejects(authService.register('ab', 'a@b.co', 'correct-horse'), { code: 'INVALID_NICKNAME' });
  await assert.rejects(authService.register('valid', 'not-an-email', 'correct-horse'), { code: 'INVALID_EMAIL' });
  await assert.rejects(authService.register('valid', 'a@b.co', 'short'), { code: 'WEAK_PASSWORD' });
});

test('вход запоминается между запусками, выход сбрасывает', async () => {
  await setup();
  assert.equal((await authService.init())?.nickname, 'vlad');
  authService.logout();
  assert.equal(await authService.init(), null);
});

test('база отклоняет некорректные задачи', async () => {
  const user = await setup();
  await assert.rejects(dataService.createTask(user.workspaceId, task('', 30)));
  await assert.rejects(dataService.createTask(user.workspaceId, task('x', 32)));
  await assert.rejects(dataService.createTask(user.workspaceId, task('x', 5000)));
});

test('updateTask не принимает произвольные имена колонок', async () => {
  const user = await setup();
  const t = await dataService.createTask(user.workspaceId, task('A', 30));
  await dataService.updateTask(t.id, { title: 'B', ['id; DROP TABLE tasks' as never]: 'x' } as never);
  const [row] = await dataService.getTasks(user.workspaceId);
  assert.equal(row.title, 'B');
});

test('завершение рабочего блока списывает время, повторный вызов ничего не меняет', async () => {
  const user = await setup();
  const t = await dataService.createTask(user.workspaceId, task('A', 60));
  const s = await dataService.createSession(user.workspaceId, user.id, 120);
  const now = new Date().toISOString();
  await dataService.insertBlocks(s.id, [
    { task_id: t.id, position: 0, kind: 'work', planned_min: 30, started_at: now },
    { task_id: null, position: 1, kind: 'break', planned_min: 5, started_at: now },
    { task_id: t.id, position: 2, kind: 'work', planned_min: 30, started_at: now },
  ]);
  const [b0, b1, b2] = await dataService.getBlocks(s.id);

  await dataService.completeBlock(b0.id);
  await dataService.completeBlock(b0.id);
  await dataService.completeBlock(b1.id); // перерыв время не списывает
  let [row] = await dataService.getTasksByIds([t.id]);
  assert.equal(row.spent_min, 30);
  assert.equal(row.status, 'backlog');

  await dataService.completeBlock(b2.id);
  [row] = await dataService.getTasksByIds([t.id]);
  assert.equal(row.spent_min, 60);
  assert.equal(row.status, 'done');
});

test('завершение сессии: с прогрессом — в паузу, без — в Backlog, выполненные не трогает', async () => {
  const user = await setup();
  const worked = await dataService.createTask(user.workspaceId, task('worked', 90));
  const fresh = await dataService.createTask(user.workspaceId, task('fresh', 30));
  const finished = await dataService.createTask(user.workspaceId, task('finished', 30));
  await dataService.updateTask(worked.id, { status: 'in_progress' });
  await dataService.updateTask(fresh.id, { status: 'in_progress' });
  await dataService.updateTask(finished.id, { status: 'done' });

  const s = await dataService.createSession(user.workspaceId, user.id, 120);
  await dataService.insertBlocks(s.id, [
    { task_id: worked.id, position: 0, kind: 'work', planned_min: 30, started_at: new Date().toISOString() },
  ]);
  const [block] = await dataService.getBlocks(s.id);
  await dataService.completeBlock(block.id);
  await dataService.finishSession(s.id);

  const byId = Object.fromEntries((await dataService.getTasks(user.workspaceId)).map((t) => [t.title, t.status]));
  assert.deepEqual(byId, { worked: 'paused', fresh: 'backlog', finished: 'done' });
  assert.equal(await dataService.getActiveSession(user.workspaceId, user.id), null);
});

test('у пользователя может быть только одна активная сессия', async () => {
  const user = await setup();
  await dataService.createSession(user.workspaceId, user.id, 60);
  await assert.rejects(dataService.createSession(user.workspaceId, user.id, 60));
});

test('удаление блоков по списку, пустой список безопасен', async () => {
  const user = await setup();
  const s = await dataService.createSession(user.workspaceId, user.id, 60);
  const now = new Date().toISOString();
  await dataService.insertBlocks(s.id, [
    { task_id: null, position: 0, kind: 'break', planned_min: 5, started_at: now },
    { task_id: null, position: 1, kind: 'break', planned_min: 5, started_at: now },
  ]);
  const blocks = await dataService.getBlocks(s.id);
  await dataService.deleteBlocks([]);
  await dataService.deleteBlocks([blocks[0].id]);
  assert.equal((await dataService.getBlocks(s.id)).length, 1);
});

test('миграции идемпотентны: повторное открытие базы ничего не ломает', async () => {
  await setup();
  const [{ user_version }] = await localDb.query<{ user_version: number }>('PRAGMA user_version');
  assert.equal(user_version, 2);
});
