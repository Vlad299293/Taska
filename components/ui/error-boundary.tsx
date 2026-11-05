'use client';

import React from 'react';
import { ErrorHandler } from '../../lib/errors/error-handler';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export class AppErrorBoundary extends React.Component<ErrorBoundaryProps, { hasError: boolean }> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_: Error): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: any, errorInfo: React.ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
    ErrorHandler.handle(error);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className='crash' role='alert'>
          <h1>Что-то пошло не так</h1>
          <p className='muted'>Произошла непредвиденная ошибка. Ваши данные в безопасности, они хранятся на этом компьютере.</p>
          <button type='button' className='btn primary' onClick={() => window.location.reload()}>
            Перезапустить
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
