
import React, { useEffect, useState } from 'react';
import { getSessions, clearMemory } from '../services/db';
import { Session } from '../types';

const HistoryPanel: React.FC = () => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    try {
      const data = await getSessions();
      setSessions(data);
      setError(null);
    } catch (e: any) {
      console.error("Failed to load memory core", e);
      setError(`Failed to load memory core: ${e.message || String(e)}`);
    }
  };

  const handleClear = async () => {
      try {
        await clearMemory();
        setSessions([]);
        setError(null);
      } catch (e: any) {
        console.error("Failed to clear memory", e);
        setError(`Failed to clear memory: ${e.message || String(e)}`);
      }
  }

  return (
    <div className="h-full flex flex-col bg-[#0a0a0a] rounded-2xl border border-white/5 overflow-hidden relative">
        {error && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-red-950/90 border border-red-500/30 text-red-200 px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 shadow-lg">
                <span className="w-2 h-2 bg-red-500 animate-pulse rounded-full"></span>
                {error}
                <button onClick={() => setError(null)} className="ml-2 hover:text-white">&times;</button>
            </div>
        )}
        <div className="p-6 border-b border-white/5 flex justify-between items-center">
            <h2 className="text-xl font-bold text-[#ffcc00] tracking-widest uppercase">Memory Core</h2>
            <button onClick={handleClear} className="text-[10px] text-red-500 hover:text-red-400 font-bold uppercase border border-red-500/30 px-3 py-1 rounded">
                Format Drive
            </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {sessions.length === 0 && (
                <div className="text-center text-white/20 mt-20 font-mono text-sm">
                    MEMORY BANKS EMPTY
                </div>
            )}
            {sessions.map(session => (
                <div key={session.id} className="bg-white/5 border border-white/5 rounded-lg p-4 hover:border-[#ffcc00]/30 transition-colors group cursor-pointer">
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-[10px] text-white/40 font-mono">
                            {session.timestamp.toLocaleString()}
                        </span>
                        <span className="text-[10px] text-[#ffcc00]/60 font-bold">
                            {session.messages.length} NODES
                        </span>
                    </div>
                    <p className="text-xs text-white/70 font-mono line-clamp-2">
                        {session.summary || "Encrypted Session Data"}
                    </p>
                </div>
            ))}
        </div>
    </div>
  );
};

export default HistoryPanel;
