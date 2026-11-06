# 03-architecture.md

## Общая схема
Taska — **автономное десктопное приложение** (Standalone Desktop App): оболочка Tauri 2, интерфейс на Next.js
(статический экспорт в `out/`), данные в локальной SQLite. Сервера и облака нет.

## Компоненты

### 1. Frontend (Next.js / React 19)
- **UI**: React, стили в `app/globals.css`.
- **State**: React Hooks (`useState`, `useEffect`), глобального стора нет.
- **Auth**: `lib/auth-service.ts` (локальные профили, хеш PBKDF2 из `lib/passwords.ts`).
- **Данные**: только через `lib/data-service.ts`; прямых SQL-запросов в компонентах быть не должно.

### 2. Слой данных (SQLite)
- `lib/sql-driver.ts` — интерфейс драйвера. В приложении это `@tauri-apps/plugin-sql`, в тестах — `node:sqlite`.
- `lib/db-local.ts` — миграции (`PRAGMA user_version`) и триггеры. Новые изменения схемы добавляются новым элементом
  массива `MIGRATIONS`, существующие не редактируются.
- Триггеры (аналог RPC из прежней облачной версии): `complete_block`, `finish_session`, `profile_creates_workspace`.

### 3. Rust (`src-tauri`)
Только оболочка и плагин `tauri-plugin-sql`. Права доступа к плагину — в `capabilities/default.json`, CSP запрещает
внешние запросы.

### 4. Модель данных
`local_profiles` → `workspaces` → `tasks`
`workspaces` → `sessions` → `session_blocks` → `tasks` (опционально)

## Потоки данных
- **Вход**: форма → `authService` → SQLite; id вошедшего пользователя хранится в `localStorage`.
- **Задачи**: компонент → `dataService` → SQLite (ограничения `CHECK` в схеме).
- **Таймер сессии**: `dataService.completeBlock()` → `UPDATE session_blocks` → триггер списывает время с задачи.

## Cowork (режим совместной работы по локальной сети)
Два режима: обычный (всё как раньше) и cowork. Хост включает cowork, показывает 6-символьный код, гости находят его в сети
и подключаются; каждого хост подтверждает вручную.
- **Хост авторитетен**: правда лежит в SQLite хоста. Гость отправляет RPC (JSON поверх WebSocket), хост проверяет права
  (`lib/cowork/rpc.ts`), выполняет и рассылает `changed`, клиенты перечитывают данные.
- **Слой данных** скрыт за `DataApi` (`lib/data-api.ts`): локальная реализация (`localApi`) и удалённая (`CoworkClient`).
- **Права**: все видят все задачи и участников; хост создаёт задачи кому угодно, участник — только себе; чужую задачу
  меняет и удаляет только хост; статус меняет только исполнитель; сессии и блоки строго у владельца.
- **Rust** (`src-tauri/cowork-net`): WebSocket-сервер и UDP-поиск хостов; команды Tauri отдают события `cowork-event`.
- **Гости на хосте** хранятся как теневые профили `local_profiles.kind='member'`; членство — в `cowork_members`
  (в базе только sha256-хеш токена).
- Тесты: `tests/cowork.test.ts` (в памяти) и `src-tauri/cowork-net/tests/net.rs` (реальные сокеты).

## Не реализовано
Облачной синхронизации и ретрансляции через интернет нет: cowork работает только в одной локальной сети и только пока
Taska открыта у хоста. Экспорт/импорт данных не сделан.
