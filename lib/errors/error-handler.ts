import { AppError } from './app-error';
import { ErrorMapper } from './error-mapper';

/**
 * Глобальный обработчик ошибок.
 * Ответственен за окончательную обработку ошибки и ее передачу в интерфейс.
 */
export const ErrorHandler = {
  /**
   * Основной метод для обработки любой ошибки в приложении.
   * Его следует вызывать в блоках catch.
   */
  handle(error: any): void {
    // 1. Приводим ошибку к типу AppError через маппер
    const appError = ErrorMapper.map(error);

    // 2. Логируем ошибку для разработчика
    this.log(appError);

    // 3. Передаем ошибку в UI
    this.notifyUI(appError);
  },

  /**
   * Логирование ошибки. В будущем здесь может быть интеграция с Sentry или другим сервисом.
   */
  log(error: AppError): void {
    const timestamp = new Date().toISOString();
    console.group(`[ErrorHandler] ${timestamp} - ${error.code}`);
    console.error(`Message: ${error.message}`);
    console.error(`Severity: ${error.severity}`);
    console.error(`Stack: ${error.stack}`);
    console.groupEnd();
  },

  /**
   * Отправка уведомления пользователю.
   * Сейчас использует window.dispatchEvent, чтобы UI-провайдер мог перехватить событие.
   */
  notifyUI(error: AppError): void {
    const event = new CustomEvent('app-error', { 
      detail: { 
        message: error.message, 
        code: error.code, 
        severity: error.severity 
      } 
    });
    window.dispatchEvent(event);
  }
};
