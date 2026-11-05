import { AppError, ValidationError } from './app-error';

/**
 * Словарь соответствий технических кодов ошибок и понятных сообщений для пользователя.
 */
const ERROR_MESSAGES: Record<string, string> = {
  // Ошибки аутентификации
  'AUTH_ERROR': 'Ошибка доступа. Пожалуйста, войдите в систему снова.',
  
  // Ошибки валидации
  'VALIDATION_ERROR': 'Пожалуйста, проверьте введенные данные.',
  'INVALID_TIME_BLOCK': 'Время должно быть кратно 5 минутам.',
  
  // Общие ошибки
  'INTERNAL_ERROR': 'Произошла непредвиденная ошибка. Попробуйте ещё раз.',
  'NOT_FOUND': 'Запрашиваемый ресурс не найден.',
};

/**
 * Сервис для преобразования любой ошибки в типизированный AppError с понятным сообщением.
 */
export const ErrorMapper = {
  map(error: any): AppError {
    // 1. Если это уже AppError, просто возвращаем его
    if (error instanceof AppError) {
      return error;
    }

    // 2. Ошибки локальной базы SQLite (tauri-plugin-sql отдаёт их строкой)
    const text = typeof error === 'string' ? error : String(error?.message ?? '');
    if (/UNIQUE constraint failed/i.test(text)) {
      return new ValidationError('Такая запись уже существует', 'DUPLICATE_ENTRY');
    }
    if (/CHECK constraint failed/i.test(text)) {
      return new ValidationError('Значение вне допустимого диапазона. Проверьте введённые данные.', 'CHECK_FAILED');
    }
    if (/database is locked|SQLITE_BUSY/i.test(text)) {
      return new AppError('База данных занята. Повторите действие через секунду.', 'DB_BUSY');
    }

    // 3. Обработка стандартных JS ошибок
    if (error instanceof TypeError || error instanceof ReferenceError) {
      return new AppError('Произошла техническая ошибка в приложении', 'INTERNAL_ERROR');
    }

    // 4. Если сообщение ошибки есть в нашем словаре
    if (error?.message && ERROR_MESSAGES[error.message]) {
      return new AppError(ERROR_MESSAGES[error.message], error.message);
    }

    // 5. Fallback: общая ошибка (строку от плагина показываем как есть)
    return new AppError(text || ERROR_MESSAGES['INTERNAL_ERROR'], 'INTERNAL_ERROR');
  }
};
