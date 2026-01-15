"use client";

import { useState, useRef, useEffect } from 'react';
import { useUserStore } from '@/lib/store';
import { Edit2, Check, User } from 'lucide-react';

export default function UserIdentityDisplay({ className = "" }: { className?: string }) {
  const { name, setName, ensureName } = useUserStore();
  const [isEditing, setIsEditing] = useState(false);
  const [tempName, setTempName] = useState(name);
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMounted(true);
    ensureName();
  }, [ensureName]);

  useEffect(() => {
    setTempName(name);
  }, [name]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  const handleSave = () => {
    if (tempName.trim()) {
      setName(tempName.trim());
    } else {
      setTempName(name); // Revert if empty
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') {
      setTempName(name);
      setIsEditing(false);
    }
  };

  if (!mounted) return null;

  return (
    <div className={`flex items-center gap-3 bg-white/70 backdrop-blur-md px-4 py-2.5 rounded-2xl border border-white/50 shadow-sm hover:shadow-md transition-all duration-300 ${className}`}>
      <div className="p-2 bg-gradient-to-tr from-violet-500 to-fuchsia-500 rounded-xl shadow-inner">
        <User className="w-4 h-4 text-white" />
      </div>
      
      {isEditing ? (
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={tempName}
            onChange={(e) => setTempName(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleSave}
            className="bg-transparent border-b-2 border-fuchsia-500 focus:outline-none text-sm font-semibold text-gray-800 w-32 sm:w-48 placeholder-gray-400"
          />
          <button onClick={handleSave} className="text-green-600 hover:bg-green-50 p-1.5 rounded-full transition-colors">
            <Check className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 cursor-pointer group" onClick={() => setIsEditing(true)}>
          <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-gray-400 font-bold leading-none mb-0.5">Visible as</span>
              <span className="text-sm font-bold text-gray-800 group-hover:text-fuchsia-600 transition-colors">
                {name}
              </span>
          </div>
          <button className="text-gray-300 group-hover:text-fuchsia-500 transition-colors p-1">
            <Edit2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
