import { AppError, NetworkError, AuthError, ValidationError, SyncError } from './app-error';

/**
 * Словарь соответствий технических кодов ошибок и понятных сообщений для пользователя.
 */
const ERROR_MESSAGES: Record<string, string> = {
  // Сетевые ошибки
  'NETWORK_ERROR': 'Проблема с сетевым соединением. Пожалуйста, проверьте интернет.',
  'TIMEOUT': 'Сервер слишком долго не отвечает. Попробуйте позже.',
  
  // Ошибки аутентификации (Supabase/PostgREST)
  'AUTH_ERROR': 'Ошибка доступа. Пожалуйста, войдите в систему снова.',
  'JWT_EXPIRED': 'Ваша сессия истекла. Пожалуйста, авторизуйтесь повторно.',
  'RLS_VIOLATION': 'У вас нет прав для выполнения этого действия.',
  
  // Ошибки валидации
  'VALIDATION_ERROR': 'Пожалуйста, проверьте введенные данные.',
  'INVALID_TIME_BLOCK': 'Время должно быть кратно 5 минутам.',
  
  // Ошибки синхронизации
  'SYNC_ERROR': 'Не удалось синхронизировать данные с облаком.',
  'CONFLICT_DETECTED': 'Обнаружен конфликт версий данных. Пожалуйста, обновите страницу.',
  
  // Общие ошибки
  'INTERNAL_ERROR': 'Произошла непредвиденная ошибка. Мы уже работаем над исправлением.',
  'NOT_FOUND': 'Запрашиваемый ресурс не найден.',
};

/**
 * Сервис для преобразования любой ошибки в типизированный AppError с понятным сообщением.
 */
export const ErrorMapper = {
  map(error: any): AppError {
    console.error('[ErrorMapper] mapping error:', error);

    // 1. Если это уже AppError, просто возвращаем его
    if (error instanceof AppError) {
      return error;
    }

    // 2. Обработка ошибок Supabase (PostgrestError)
    if (error?.code) {
      const code = error.code;
      
      // Поиск по кодам Supabase/PostgREST
      if (code === '42501') return new AuthError(ERROR_MESSAGES['RLS_VIOLATION'], 'RLS_VIOLATION');
      if (code === '401') return new AuthError(ERROR_MESSAGES['AUTH_ERROR'], 'AUTH_ERROR');
      if (code === '23505') return new ValidationError('Такая запись уже существует', 'DUPLICATE_ENTRY');
    }

    // 3. Обработка стандартных JS ошибок
    if (error instanceof TypeError || error instanceof ReferenceError) {
      return new AppError('Произошла техническая ошибка в приложении', 'INTERNAL_ERROR');
    }

    // 4. Обработка сетевых ошибок (Fetch/Axios)
    if (error?.message?.toLowerCase().includes('network') || error?.message?.toLowerCase().includes('fetch')) {
      return new NetworkError();
    }

    // 5. Если сообщение ошибки есть в нашем словаре
    if (error?.message && ERROR_MESSAGES[error.message]) {
      return new AppError(ERROR_MESSAGES[error.message], error.message);
    }

    // 6. Fallback: общая ошибка
    return new AppError(
      error?.message || ERROR_MESSAGES['INTERNAL_ERROR'],
      'INTERNAL_ERROR'
    );
  }
};
