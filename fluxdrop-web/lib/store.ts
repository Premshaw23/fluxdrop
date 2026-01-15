import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface UserState {
  name: string;
  setName: (name: string) => void;
  ensureName: () => void;
}

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      name: '',
      setName: (name) => set({ name }),
      ensureName: () => {
        if (!get().name) {
          const number = Math.floor(1000 + Math.random() * 9000);
          const type = typeof navigator !== 'undefined' && /Mobi|Android/i.test(navigator.userAgent) ? 'Mobile' : 'Desktop';
          set({ name: `FluxDrop-${number} (${type})` });
        }
      },
    }),
    {
      name: 'fluxdrop-user-storage',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
