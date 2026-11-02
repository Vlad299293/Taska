import React, { useEffect, useState } from 'react';

export default function SyncIndicator() {
  const [status, setStatus] = useState<'online' | 'offline' | 'syncing'>('online');

  useEffect(() => {
    const updateStatus = () => {
      if (navigator.onLine) {
        setStatus('online');
      } else {
        setStatus('offline');
      }
    };

    window.addEventListener('online', updateStatus);
    window.addEventListener('offline', updateStatus);
    updateStatus();

    return () => {
      window.removeEventListener('online', updateStatus);
      window.removeEventListener('offline', updateStatus);
    };
  }, []);

  if (status === 'online') return null;

  return (
    <div className={`sync-status ${status}`}>
      <span className="status-dot" />
      {status === 'offline' ? 'Работа в офлайне' : 'Синхронизация...'}
    </div>
  );
}
