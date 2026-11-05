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
    const id = Math.random().toString(36).substring(2, 9);
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
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((toast) => (
          <div 
            key={toast.id} 
            className={`p-4 rounded-lg shadow-lg text-white transition-all duration-300 pointer-events-auto min-w-[300px] ${
              toast.severity === 'critical' ? 'bg-red-700 border-2 border-red-900' : 
              toast.severity === 'error' ? 'bg-red-500' : 
              toast.severity === 'warning' ? 'bg-yellow-500' : 'bg-blue-500'
            }`}
          >
            <div className="flex justify-between items-start">
              <p className="text-sm font-medium">{toast.message}</p>
              <button 
                onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}
                className="ml-4 text-white/70 hover:text-white"
              >
                ✕
              </button>
            </div>
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
