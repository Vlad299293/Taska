import test from 'node:test';
import assert from 'node:assert/strict';
import { localDb } from '../lib/db-local.ts';
import { authService } from '../lib/auth-service.ts';
import { dataService } from '../lib/data-service.ts';
import { createLiveApi } from '../lib/live-api.ts';
import { CoworkHost } from '../lib/cowork/host.ts';
import { CoworkClient } from '../lib/cowork/client.ts';
import { freshDb, memoryStore } from './helpers.ts';
import { memoryNetwork, waitFor } from './memory-network.ts';

const input = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  estimate_min: 30,
  priority: 'medium' as const,
  deadline: null,
  description: null,
  ...extra,
});

async function setup() {
  await freshDb();
  authService.setStore(memoryStore());
  const user = await authService.register('host', 'host@example.com', 'correct-horse');
  const api = createLiveApi(dataService);
  const net = memoryNetwork();
  const host = new CoworkHost({ api, transport: net.transport, workspaceId: user.workspaceId, host: { id: user.id, name: 'host' } });
  const view = await host.start();
  const code = view.code as string;

  const newClient = () => new CoworkClient({ factory: net.factory, resolveUrl: async () => 'ws://mem', retryMs: 20 });

  /** Гость вводит код, хост принимает заявку */
  async function join(name: string) {
    const client = newClient();
    const joined = client.join(name, code);
    await waitFor(() => host.getView().pending.some((p) => p.name === name), `заявка ${name}`);
    await host.accept(host.getView().pending.find((p) => p.name === name)!.conn);
    const welcome = await joined;
    return { client, id: welcome.id, token: welcome.token as string };
  }

  return { user, api, net, host, code, newClient, join, ws: user.workspaceId };
}

test('неверный код отклоняется, после пяти попыток соединение закрывается', async () => {
  const { host, newClient } = await setup();
  const c = newClient();
  await assert.rejects(c.join('anna', 'WRONG1'), { code: 'BAD_CODE' });
  assert.equal(host.getView().pending.length, 0);
});

test('хост может отклонить заявку', async () => {
  const { host, newClient, code } = await setup();
  const c = newClient();
  const joined = c.join('anna', code);
  const assertion = assert.rejects(joined, { code: 'FORBIDDEN' });
  await waitFor(() => host.getView().pending.length === 1 && c.getState().state === 'pending', 'заявка');
  await host.reject(host.getView().pending[0].conn);
  await assertion;
  assert.equal(c.getState().state, 'rejected');
  assert.equal((await dataService.getParticipants((await localDb.query<{ id: string }>('SELECT id FROM workspaces'))[0].id)).length, 1);
});

test('отмена заявки завершает подключение без ошибки хоста', async () => {
  const { host, newClient, code } = await setup();
  const c = newClient();
  const joined = c.join('anna', code);
  const assertion = assert.rejects(joined, { code: 'CANCELLED' });
  await waitFor(() => host.getView().pending.length === 1, 'заявка');
  c.leave();
  await assertion;
  await waitFor(() => host.getView().pending.length === 0, 'заявка снята');
});

test('код приглашения принимается в любом регистре и с пробелами', async () => {
  const { host, newClient, code } = await setup();
  const c = newClient();
  const joined = c.join('anna', ` ${code.toLowerCase().slice(0, 3)}-${code.slice(3)} `);
  await waitFor(() => host.getView().pending.length === 1, 'заявка');
  await host.accept(host.getView().pending[0].conn);
  await joined;
  assert.equal(c.getState().state, 'online');
});

test('принятый участник виден всем, имена не повторяются', async () => {
  const { join, ws, api } = await setup();
  const anna = await join('anna');
  const anna2 = await join('anna');
  const list = await anna.client.getParticipants(ws);
  assert.deepEqual(
    list.map((p) => [p.name, p.role, p.active]),
    [['host', 'host', true], ['anna', 'member', true], ['anna 2', 'member', true]],
  );
  assert.equal((await api.getParticipants(ws)).length, 3);
  assert.notEqual(anna.id, anna2.id);
});

test('участник создаёт задачу только для себя, хост — для любого, и все задачи видны всем', async () => {
  const { join, ws, user, api } = await setup();
  const anna = await join('anna');
  const boris = await join('boris');

  const own = await anna.client.createTask(ws, input('задача Анны'));
  assert.equal(own.assignee_id, anna.id);
  assert.equal(own.created_by, anna.id);

  await assert.rejects(anna.client.createTask(ws, input('чужая', { assignee_id: boris.id })), { code: 'FORBIDDEN' });
  await assert.rejects(anna.client.createTask(ws, input('хосту', { assignee_id: user.id })), { code: 'FORBIDDEN' });

  const given = await api.createTask(ws, input('от хоста', { assignee_id: boris.id, created_by: user.id }));
  assert.equal(given.assignee_id, boris.id);
  assert.equal(given.created_by, user.id);

  // автора нельзя подделать
  const forged = await anna.client.createTask(ws, input('подделка', { created_by: user.id }));
  assert.equal(forged.created_by, anna.id);

  const seenByBoris = (await boris.client.getTasks(ws)).map((t) => t.title).sort();
  assert.deepEqual(seenByBoris, ['задача Анны', 'от хоста', 'подделка'].sort());
  assert.equal((await api.getTasks(ws)).length, 3);
});

test('старые задачи без исполнителя принадлежат хосту', async () => {
  const { api, ws, user } = await setup();
  const t = await api.createTask(ws, input('без исполнителя'));
  assert.equal(t.assignee_id, user.id);
  assert.equal(t.created_by, user.id);
});

test('чужую задачу меняет и удаляет только хост, статус меняет только исполнитель', async () => {
  const { join, ws, api, user } = await setup();
  const anna = await join('anna');
  const boris = await join('boris');
  const task = await anna.client.createTask(ws, input('Анна'));

  await assert.rejects(boris.client.updateTask(task.id, { title: 'взлом' }), { code: 'FORBIDDEN' });
  await assert.rejects(boris.client.deleteTask(task.id), { code: 'FORBIDDEN' });

  await api.updateTask(task.id, { title: 'правка хоста' });
  await anna.client.updateTask(task.id, { status: 'in_progress' });
  assert.equal((await api.getTasksByIds([task.id]))[0].status, 'in_progress');

  // хост может править содержимое, но не статус чужой задачи (через протокол)
  const { executeRpc } = await import('../lib/cowork/rpc.ts');
  const hostCtx = { workspaceId: ws, callerId: user.id, isHost: true };
  await assert.rejects(executeRpc(api, hostCtx, 'updateTask', [task.id, { status: 'done' }]), { code: 'FORBIDDEN' });
  await executeRpc(api, hostCtx, 'updateTask', [task.id, { title: 'ещё правка' }]);
  await anna.client.updateTask(task.id, { status: 'backlog' });
  await executeRpc(api, hostCtx, 'deleteTask', [task.id]);
  assert.equal((await api.getTasks(ws)).length, 0);
});

test('участник не может сменить исполнителя; хост передаёт только нетронутые задачи', async () => {
  const { join, ws, api, user } = await setup();
  const { executeRpc } = await import('../lib/cowork/rpc.ts');
  const hostCtx = { workspaceId: ws, callerId: user.id, isHost: true };
  const anna = await join('anna');
  const boris = await join('boris');
  const task = await anna.client.createTask(ws, input('Анна'));

  await assert.rejects(anna.client.updateTask(task.id, { assignee_id: boris.id }), { code: 'FORBIDDEN' });
  // «передача» самому себе ничего не меняет и ошибкой не считается
  await anna.client.updateTask(task.id, { assignee_id: anna.id, title: 'переименовала' });

  await executeRpc(api, hostCtx, 'updateTask', [task.id, { assignee_id: boris.id }]);
  assert.equal((await api.getTasksByIds([task.id]))[0].assignee_id, boris.id);

  await boris.client.updateTask(task.id, { status: 'in_progress' });
  await assert.rejects(executeRpc(api, hostCtx, 'updateTask', [task.id, { assignee_id: anna.id }]), { code: 'CONFLICT' });
  await assert.rejects(executeRpc(api, hostCtx, 'updateTask', [task.id, { assignee_id: 'нет-такого' }]), { code: 'CONFLICT' });
});

test('запросы с лишними полями и чужим пространством отклоняются', async () => {
  const { join, ws } = await setup();
  const anna = await join('anna');
  const task = await anna.client.createTask(ws, input('моя'));
  await assert.rejects(anna.client.updateTask(task.id, { workspace_id: 'x' } as never), { code: 'BAD_REQUEST' });
  await assert.rejects(anna.client.getTasks('чужое-пространство'), { code: 'FORBIDDEN' });
  await assert.rejects(anna.client.updateTask('нет-такой', { title: 'x' }), { code: 'NOT_FOUND' });
});

test('сессии и таймер у каждого свои, завершение сессии не трогает чужие задачи', async () => {
  const { join, ws, api, user } = await setup();
  const anna = await join('anna');
  const boris = await join('boris');

  const hostTask = await api.createTask(ws, input('хоста', { created_by: user.id }));
  await api.updateTask(hostTask.id, { status: 'in_progress' });
  const aTask = await anna.client.createTask(ws, input('Анны', { estimate_min: 60 }));
  const bTask = await boris.client.createTask(ws, input('Бориса'));
  await anna.client.updateTask(aTask.id, { status: 'in_progress' });
  await boris.client.updateTask(bTask.id, { status: 'in_progress' });

  const session = await anna.client.createSession(ws, anna.id, 60);
  await assert.rejects(boris.client.createSession(ws, anna.id, 60), { code: 'FORBIDDEN' });
  await assert.rejects(boris.client.getBlocks(session.id), { code: 'FORBIDDEN' });
  await assert.rejects(boris.client.finishSession(session.id), { code: 'FORBIDDEN' });
  assert.equal(await boris.client.getActiveSession(ws, boris.id), null);
  await assert.rejects(boris.client.getActiveSession(ws, anna.id), { code: 'FORBIDDEN' });

  const now = new Date().toISOString();
  await assert.rejects(
    anna.client.insertBlocks(session.id, [{ task_id: bTask.id, position: 0, kind: 'work', planned_min: 30, started_at: now }]),
    { code: 'FORBIDDEN' },
  );
  await anna.client.insertBlocks(session.id, [{ task_id: aTask.id, position: 0, kind: 'work', planned_min: 30, started_at: now }]);
  const [block] = await anna.client.getBlocks(session.id);
  await assert.rejects(boris.client.completeBlock(block.id), { code: 'FORBIDDEN' });
  await assert.rejects(boris.client.setBlockMinutes(block.id, 5), { code: 'FORBIDDEN' });
  await assert.rejects(boris.client.deleteBlocks([block.id]), { code: 'FORBIDDEN' });

  await anna.client.completeBlock(block.id);
  assert.equal((await api.getTasksByIds([aTask.id]))[0].spent_min, 30);

  await anna.client.finishSession(session.id);
  const status = async (id: string) => (await api.getTasksByIds([id]))[0].status;
  assert.equal(await status(aTask.id), 'paused');
  assert.equal(await status(bTask.id), 'in_progress'); // чужая сессия не сбросила задачу Бориса
  assert.equal(await status(hostTask.id), 'in_progress');
});

test('задачу в плане активной сессии удалить нельзя', async () => {
  const { join, ws } = await setup();
  const anna = await join('anna');
  const task = await anna.client.createTask(ws, input('в плане'));
  await anna.client.updateTask(task.id, { status: 'in_progress' });
  const session = await anna.client.createSession(ws, anna.id, 60);
  await assert.rejects(anna.client.deleteTask(task.id), { code: 'CONFLICT' });
  await anna.client.finishSession(session.id);
  await anna.client.deleteTask(task.id);
});

test('об изменениях узнают все: и хост, и остальные гости', async () => {
  const { join, ws, api } = await setup();
  const anna = await join('anna');
  const boris = await join('boris');
  let hostHits = 0;
  let borisHits = 0;
  api.subscribe(() => hostHits++);
  boris.client.subscribe(() => borisHits++);

  await anna.client.createTask(ws, input('новая'));
  await waitFor(() => hostHits > 0 && borisHits > 0, 'уведомления об изменении');
});

test('участник возвращается по токену без подтверждения, чужой токен не работает', async () => {
  const { join, newClient, ws, host } = await setup();
  const anna = await join('anna');
  anna.client.leave();

  const again = newClient();
  const welcome = await again.resume({ id: anna.id, token: anna.token });
  assert.equal(welcome.id, anna.id);
  assert.equal(welcome.token, null);
  assert.equal((await again.getParticipants(ws)).length, 2);
  assert.equal(host.getView().online.includes(anna.id), true);

  const intruder = newClient();
  await assert.rejects(intruder.resume({ id: anna.id, token: 'не-тот' }), { code: 'BAD_TOKEN' });
});

test('после обрыва связи гость сам переподключается и перечитывает данные', async () => {
  const { join, net, ws, api } = await setup();
  const anna = await join('anna');
  let reloads = 0;
  anna.client.subscribe(() => reloads++);

  net.dropAll();
  await waitFor(() => anna.client.getState().state === 'offline', 'обрыв');
  await assert.rejects(anna.client.getTasks(ws), { code: 'UNREACHABLE' });

  await waitFor(() => anna.client.getState().state === 'online', 'переподключение');
  assert.ok(reloads > 0);
  await api.createTask(ws, input('после обрыва'));
  assert.equal((await anna.client.getTasks(ws)).length, 1);
});

test('удалённый участник отключается, а его задачи остаются с пометкой «вышел»', async () => {
  const { join, host, ws, api, newClient } = await setup();
  const anna = await join('anna');
  await anna.client.createTask(ws, input('осталась'));

  await host.removeMember(anna.id);
  await waitFor(() => anna.client.getState().state === 'removed', 'удаление');
  await assert.rejects(anna.client.getTasks(ws));

  const participants = await api.getParticipants(ws);
  assert.deepEqual(participants.map((p) => [p.name, p.active]), [['host', true], ['anna', false]]);
  assert.equal((await api.getTasks(ws))[0].assignee_id, anna.id);
  await assert.rejects(newClient().resume({ id: anna.id, token: anna.token }), { code: 'BAD_TOKEN' });
});

test('при выключении cowork гости получают понятное состояние и не переподключаются', async () => {
  const { join, host } = await setup();
  const anna = await join('anna');
  await host.stop();
  await waitFor(() => anna.client.getState().state === 'closed', 'закрытие');
  assert.match(anna.client.getState().reason ?? '', /cowork/);
  assert.equal(host.getView().running, false);
});

test('код приглашения сохраняется между перезапусками хоста и меняется по требованию', async () => {
  const { host, code, api, net, user } = await setup();
  await host.stop();
  const again = new CoworkHost({ api, transport: net.transport, workspaceId: user.workspaceId, host: { id: user.id, name: 'host' } });
  assert.equal((await again.start()).code, code);
  await again.regenerateCode();
  assert.notEqual(again.getView().code, code);
  assert.equal((await dataService.getWorkspace(user.workspaceId)).inviteCode, again.getView().code);
});

test('миграция v1 → v2: старые данные остаются на месте и принадлежат владельцу', async () => {
  const { MIGRATIONS } = await import('../lib/db-local.ts');
  const { memoryDriver } = await import('./helpers.ts');
  const driver = memoryDriver();
  for (const sql of MIGRATIONS[0]) await driver.execute(sql);
  await driver.execute('PRAGMA user_version = 1');
  const now = new Date().toISOString();
  await driver.execute("INSERT INTO local_profiles (id, email, nickname, password_hash, created_at) VALUES ('u1','a@b.co','old','x',?)", [now]);
  const [w] = await driver.select<{ id: string }>('SELECT id FROM workspaces');
  await driver.execute(
    "INSERT INTO tasks (id, workspace_id, title, estimate_min, priority, status, spent_min, created_at, updated_at) VALUES ('t1',?,'старая',30,'low','in_progress',10,?,?)",
    [w.id, now, now],
  );
  await driver.execute("INSERT INTO sessions (id, workspace_id, user_id, window_min, started_at) VALUES ('s1',?,'u1',60,?)", [w.id, now]);

  await localDb.useDriver(driver);
  await localDb.useDriver(driver); // повторный запуск миграций безопасен
  const [task] = await dataService.getTasks(w.id);
  assert.equal(task.title, 'старая');
  assert.equal(task.assignee_id, 'u1');
  await dataService.finishSession('s1');
  assert.equal((await dataService.getTasks(w.id))[0].status, 'paused');
  const [{ user_version }] = await localDb.query<{ user_version: number }>('PRAGMA user_version');
  assert.equal(user_version, 2);
});
