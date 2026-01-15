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
  const [expanded, setExpanded] = useState(false);


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
      setTempName(name);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") {
      setTempName(name);
      setIsEditing(false);
    }
  };

  if (!mounted) return null;

  return (
    <div
      className={`flex items-center justify-center gap-3 bg-white/70 backdrop-blur-md md:px-4 md:py-2.5 px-1 py-1 
  rounded-2xl border border-white/50 shadow-sm hover:shadow-md 
  transition-all duration-300 min-w-0 w-full sm:w-auto ${className}`}
    >

      <div className="p-2 bg-gradient-to-tr from-violet-500 to-fuchsia-500 rounded-xl shadow-inner flex-shrink-0">
        <User className="md:w-4 md:h-4 w-3 h-3 text-white" />
      </div>

      {isEditing ? (
        <div className="flex items-center gap-2 min-w-0">
          <input
            ref={inputRef}
            type="text"
            value={tempName}
            onChange={(e) => setTempName(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleSave}
            className="bg-transparent border-b-2 border-fuchsia-500 focus:outline-none 
            text-sm font-semibold text-gray-800 w-[90px] sm:w-[140px]"
          />
          <button
            onClick={handleSave}
            className="text-green-600 hover:bg-green-50 p-1.5 rounded-full transition-colors flex-shrink-0"
          >
            <Check className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div
          className="flex items-center gap-2 cursor-pointer group min-w-0"
          onClick={() => setIsEditing(true)}
        >
          <div className="flex flex-col min-w-0">
            <span className="text-[10px] uppercase tracking-wider text-gray-400 font-bold leading-none mb-0.5">
              Visible as
            </span>

            {/* MOBILE-SAFE TRUNCATED NAME */}
            <span
              onClick={() => setExpanded(!expanded)}
              className={`
    md:text-sm text-xs font-bold cursor-pointer text-gray-900
    ${expanded ? "whitespace-normal break-words" : "sm:truncate"}
  `}
            >
              {name}
            </span>


          </div>
          <button className="md:group-hover:text-fuchsia-500 text-fuchsia-500 md:transition-colors p-1 flex-shrink-0">
            <Edit2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
