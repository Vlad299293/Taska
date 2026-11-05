'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

type Severity = 'info' | 'warning' | 'error' | 'critical';

interface Toast {
  id: string;
  message: string;
  severity: Severity;
}

interface NotificationContextType {
  addToast: (message: string, severity?: Severity) => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, severity: Severity = 'error') => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message, severity }]);
    
    // Автоматическое удаление через 5 секунд
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  useEffect(() => {
    const handleAppError = (event: any) => {
      const { message, severity } = event.detail;
      addToast(message, severity);
    };

    window.addEventListener('app-error', handleAppError);
    return () => window.removeEventListener('app-error', handleAppError);
  }, [addToast]);

  return (
    <NotificationContext.Provider value={{ addToast }}>
      {children}
      <div className='toasts' aria-live='polite'>
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.severity}`} role={toast.severity === 'info' ? 'status' : 'alert'}>
            <p>{toast.message}</p>
            <button type='button' aria-label='Закрыть' onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </NotificationContext.Provider>
  );
};

export const useNotify = () => {
  const context = useContext(NotificationContext);
  if (!context) throw new Error('useNotify must be used within a NotificationProvider');
  return context;
};
