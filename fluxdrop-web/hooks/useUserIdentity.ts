import { useState, useEffect } from 'react';

export function useUserIdentity() {
  const [name, setName] = useState('');
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
    const savedName = localStorage.getItem('fluxdrop-username');
    if (savedName) {
      setName(savedName);
    } else {
      const number = Math.floor(1000 + Math.random() * 9000);
      const type = /Mobi|Android/i.test(navigator.userAgent) ? 'Mobile' : 'Desktop';
      const newName = `FluxDrop-${number} (${type})`;
      setName(newName);
      localStorage.setItem('fluxdrop-username', newName);
    }
  }, []);

  const updateName = (newName: string) => {
    setName(newName);
    localStorage.setItem('fluxdrop-username', newName);
  };

  return { name, updateName, isClient };
}
