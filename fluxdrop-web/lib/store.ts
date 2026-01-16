import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface UserState {
  name: string;
  deviceId: string;
  setName: (name: string) => void;
  ensureName: () => void;
}

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      name: '',
      deviceId: '',
      setName: (name) => set({ name }),
      ensureName: () => {
        const state = get();
        const updates: Partial<UserState> = {};
        
        if (!state.name) {
          const number = Math.floor(1000 + Math.random() * 9000);
          const type = typeof navigator !== 'undefined' && /Mobi|Android/i.test(navigator.userAgent) ? 'Mobile' : 'Desktop';
          updates.name = `FluxDrop-${number} (${type})`;
        }

        if (!state.deviceId) {
          updates.deviceId = crypto.randomUUID();
        }

        if (Object.keys(updates).length > 0) {
          set(updates);
        }
      },
    }),
    {
      name: 'fluxdrop-user-storage',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
