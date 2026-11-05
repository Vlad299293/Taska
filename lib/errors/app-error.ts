/**
 * Базовый класс для всех ошибок приложения Taska.
 * Позволяет отличать ожидаемые ошибки приложения от непредвиденных системных сбоев.
 */
export class AppError extends Error {
  public readonly isAppError = true;
  public readonly code: string;
  public readonly severity: 'info' | 'warning' | 'error' | 'critical';

  constructor(message: string, code = 'INTERNAL_ERROR', severity: 'info' | 'warning' | 'error' | 'critical' = 'error') {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.severity = severity;
    
    // Исправление для корректной работы prototype в TypeScript при наследовании Error
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Ошибки, связанные с сетевым соединением и доступностью сервера.
 */
export class NetworkError extends AppError {
  constructor(message = 'Проблема с сетевым соединением', code = 'NETWORK_ERROR') {
    super(message, code, 'error');
  }
}

/**
 * Ошибки аутентификации и авторизации (права доступа).
 */
export class AuthError extends AppError {
  constructor(message = 'Ошибка доступа', code = 'AUTH_ERROR', severity: 'error' | 'critical' = 'error') {
    super(message, code, severity);
  }
}

/**
 * Ошибки валидации данных и бизнес-логики.
 */
export class ValidationError extends AppError {
  constructor(message = 'Некорректные данные', code = 'VALIDATION_ERROR') {
    super(message, code, 'warning');
  }
}

/**
 * Ошибки, возникающие при синхронизации локальных и облачных данных.
 */
export class SyncError extends AppError {
  constructor(message = 'Ошибка синхронизации данных', code = 'SYNC_ERROR') {
    super(message, code, 'warning');
  }
}
