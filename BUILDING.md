# Инструкция по сборке десктопного приложения Taska

Этот документ содержит пошаговое руководство по сборке финального дистрибутива приложения Taska с использованием Tauri.

## 🛠 Требования к системе

Перед сборкой убедитесь, что в системе установлены:
- **Node.js** (LTS версия)
- **Linux**: пакеты WebKitGTK, см. https://tauri.app/start/prerequisites/
- **Rust** (устанавливается через [rustup.rs](https://rustup.rs/))
- **C++ Build Tools** (для Windows: Visual Studio Build Tools с компонентом "Desktop development with C++")

## 🚀 Процесс сборки

### 1. Сборка фронтенда (Static Export)
Tauri упаковывает статически сгенерированный фронтенд. Сначала необходимо собрать Next.js проект:

```bash
npm run build
```

> **Важно**: Убедитесь, что в `next.config.mjs` установлен параметр `output: 'export'`. Результат сборки должен появиться в папке `/out`.

### 2. Сборка бинарного файла Tauri
Запустите процесс компиляции Rust-бэкенда и упаковки приложения:

```bash
npm run tauri build
```

Если команда выше не определена в `package.json`, используйте:
```bash
npx tauri build
```

## 📦 Результаты сборки (Artifacts)

После успешного завершения сборки готовые файлы будут находиться в директории `src-tauri/target/release/bundle/`.

### Windows
- **Установщик (.msi):** `src-tauri/target/release/bundle/msi/taska_*.msi`
- **Исполняемый файл (.exe):** `src-tauri/target/release/taska.exe`

### macOS
- **Образ диска (.dmg):** `src-tauri/target/release/bundle/dmg/taska_*.dmg`
- **Приложение (.app):** `src-tauri/target/release/bundle/macos/taska.app`

## ⚙️ Настройки перед релизом

Перед выпуском версии проверьте следующие параметры:

1. **Версионирование**:
   - Обновите поле `version` в `package.json`.
   - Обновите поле `version` в `src-tauri/tauri.conf.json`.

2. **Иконки**:
   - Проверьте наличие всех размеров иконок в `src-tauri/icons/`.

3. **Безопасность (CSP)**:
   - CSP уже задана в `src-tauri/tauri.conf.json` и запрещает любые внешние запросы: приложению сеть не нужна.
     Если добавите сетевую функцию, расширяйте `connect-src` точечно.

4. **Шрифты**:
   - Шрифты (IBM Plex Sans, Unbounded) скачиваются с Google Fonts один раз во время `npm run build` и встраиваются в
     приложение, поэтому на машине сборки нужен интернет, а у пользователей нет.

## 🛠 Устранение ошибок

- **Ошибка компиляции Rust**: Попробуйте обновить Rust через `rustup update`.
- **Пустая страница после запуска**: Проверьте, что папка `/out` создана после `npm run build` и путь к ней верно указан в `tauri.conf.json` (`frontendDist: "../out"`).
- **Проблемы с иконками**: Используйте команду `npx tauri icon /путь/к/исходнику.png` для автоматической генерации всех размеров.
