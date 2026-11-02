# 03-architecture.md

## Общая схема
Приложение построено по архитектуре **Client-Server (Serverless)** с использованием Next.js и Supabase.

## Компоненты системы

### 1. Frontend (Next.js)
- **UI**: React 19, Tailwind CSS (через globals.css).
- **State Management**: React Hooks (`useState`, `useEffect`).
- **Auth**: Интеграция с Supabase Auth.
- **API**: Прямые вызовы к Supabase Client (с использованием RLS).

### 2. Backend (Supabase/PostgreSQL)
- **Database**: PostgreSQL.
- **RLS (Row Level Security)**: Основной механизм безопасности. Доступ к данным определяется членством пользователя в воркспейсе (`private.is_member`).
- **Database Functions (PL/pgSQL)**:
    - `complete_block`: Логика списания времени и автоматического перевода задачи в `done`.
    - `finish_session`: Логика очистки активных задач сессии.
    - `handle_new_user`: Автоматическое создание личного воркспейса при регистрации.

### 3. Модель данных (ER-диаграмма упрощенно)
`Workspaces` $\leftarrow$ `WorkspaceMembers` $\leftarrow$ `Users`
`Workspaces` $\rightarrow$ `Tasks`
`Workspaces` $\rightarrow$ `Sessions` $\rightarrow$ `SessionBlocks` $\rightarrow$ `Tasks` (опционально)

## Потоки данных
- **Авторизация**: Пользователь $\rightarrow$ Supabase Auth $\rightarrow$ JWT $\rightarrow$ Frontend.
- **Управление задачами**: Frontend $\rightarrow$ Supabase Client $\rightarrow$ PostgreSQL (RLS check) $\rightarrow$ Data.
- **Таймер сессии**: Frontend $\rightarrow$ `complete_block()` RPC $\rightarrow$ Update `Tasks` & `SessionBlocks`.
