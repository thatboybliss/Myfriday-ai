
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import { decode, decodeAudioData, createBlobFromFloat32 } from '../utils/audio';
import { Message, FridayStatus, UserProfile, Attachment } from '../types';
import Visualizer, { VisualizerMode } from './Visualizer';
import DropZone from './DropZone';
import { saveSession, getSessions } from '../services/db';

const LIVE_MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';
const VISION_MODEL_NAME = 'gemini-3-flash-preview';

interface FridayAgentProps {
  userProfile: UserProfile;
}

const FridayAgent: React.FC<FridayAgentProps> = ({ userProfile }) => {
  const [sessionId] = useState(`session-${Date.now()}`);
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<FridayStatus>({
    isConnected: false, isListening: false, isThinking: false, isSpeaking: false,
  });
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [fridayTranscript, setFridayTranscript] = useState('');
  const [error, setError] = useState<{title: string, message: string, actionText?: string, onAction?: () => void} | null>(null);
  const [processingFile, setProcessingFile] = useState<boolean>(false);
  const [detectedEmotion, setDetectedEmotion] = useState<string>('NEUTRAL');
  const [lastSessionSummary, setLastSessionSummary] = useState<string | null>(null);
  const [debugLogs, setDebugLogs] = useState<{time: Date, msg: string, type: 'info'|'error'}[]>([]);
  const [showDebug, setShowDebug] = useState(false);

  const addDebugLog = (msg: string, type: 'info'|'error' = 'info', err?: any) => {
    const fullMsg = err ? `${msg} | Details: ${err.message || String(err)}` : msg;
    setDebugLogs(prev => [...prev, {time: new Date(), msg: fullMsg, type}]);
    if (type === 'error') console.error(`[DEBUG] ${msg}`, err || '');
    else console.log(`[DEBUG] ${msg}`);
  };

  const audioContextRef = useRef<{ input: AudioContext; output: AudioContext; inputNode: GainNode; outputNode: GainNode; analyzer: AnalyserNode; } | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (messages.length > 0) {
        saveSession({
            id: sessionId,
            timestamp: new Date(),
            summary: messages[messages.length - 1].text.substring(0, 60),
            messages: messages
        }).catch(err => addDebugLog("Memory Core Write Failure", 'error', err));
    }
    if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, sessionId]);

  useEffect(() => {
    getSessions().then(sessions => {
      if (sessions && sessions.length > 0) {
        setLastSessionSummary(sessions[0].summary);
      }
    }).catch(err => addDebugLog("Failed to fetch past sessions", 'error', err));
    return () => stopSession(); 
  }, []);

  const getVisualizerMode = (): VisualizerMode => {
    if (processingFile) return 'thinking';
    if (!status.isConnected) return 'idle';
    if (status.isSpeaking) return 'speaking';
    if (status.isThinking) return 'thinking';
    if (status.isListening) return 'listening';
    return 'idle';
  };

  const detectEmotion = async (text: string) => {
    if (!text.trim()) return;
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        addDebugLog("Emotion detection skipped: ANTHROPIC_API_KEY missing", 'error');
        return;
      }
      const anthropic = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
      const response = await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: `Analyze the following user speech transcript and identify the primary emotional cue. Return ONLY ONE WORD representing the emotion (e.g., Happiness, Sadness, Frustration, Anger, Excitement, Neutral, Anxiety, Joy). Transcript: "${text}"`
        }]
      });
      
      const emotionText = (response.content[0] as any).text;
      if (emotionText) {
        setDetectedEmotion(emotionText.trim().toUpperCase());
        addDebugLog(`Emotion detected (Claude): ${emotionText.trim().toUpperCase()}`);
      }
    } catch (e: any) {
      addDebugLog(`Emotion detection failed`, 'error', e);
    }
  };

  const getEmotionColor = (emotion: string) => {
    const e = emotion.toLowerCase();
    if (e.includes('sad') || e.includes('depress')) return 'text-blue-400';
    if (e.includes('happy') || e.includes('joy') || e.includes('excit')) return 'text-yellow-400';
    if (e.includes('frustrat') || e.includes('ang')) return 'text-red-400';
    if (e.includes('anxi') || e.includes('fear')) return 'text-purple-400';
    return 'text-cyan-400';
  };

  const initAudio = async () => {
    if (audioContextRef.current) {
      if (audioContextRef.current.input.state === 'suspended') await audioContextRef.current.input.resume();
      if (audioContextRef.current.output.state === 'suspended') await audioContextRef.current.output.resume();
      return;
    }
    try {
      const inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const inputNode = inputAudioContext.createGain();
      const outputNode = outputAudioContext.createGain();
      const analyzer = outputAudioContext.createAnalyser();
      analyzer.fftSize = 2048; 
      analyzer.smoothingTimeConstant = 0.5;
      outputNode.connect(analyzer);
      outputNode.connect(outputAudioContext.destination);
      audioContextRef.current = { input: inputAudioContext, output: outputAudioContext, inputNode, outputNode, analyzer };
    } catch (e) { throw new Error("Vocal core synchronization failed."); }
  };

  const startSession = async () => {
    setError(null);
    addDebugLog("Initializing session...");
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        const errMsg = "ERR_ENV_MISSING: GEMINI_API_KEY not found in environment.";
        addDebugLog(errMsg, 'error');
        throw new Error(errMsg);
      }
      await initAudio();
      addDebugLog("Audio context initialized.");
      const ai = new GoogleGenAI({ apiKey });
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true } 
      });
      streamRef.current = stream;
      addDebugLog("Microphone stream acquired.");

      let isSetupComplete = false;
      let hasSentGreeting = false;
      let activeSession: any = null;
      
      const hour = new Date().getHours();
      let timeGreeting = 'Good evening';
      if (hour >= 5 && hour < 12) timeGreeting = 'Good morning';
      else if (hour >= 12 && hour < 18) timeGreeting = 'Good afternoon';
      
      let greetingPrompt = `System initialized. Please greet me with a personalized message. The current time is ${timeGreeting}. My name is ${userProfile.name}.`;
      if (lastSessionSummary) {
          greetingPrompt += ` My last session was about: "${lastSessionSummary}". Mention it briefly if relevant.`;
      }

      const sessionPromise = ai.live.connect({
        model: LIVE_MODEL_NAME,
        callbacks: {
          onopen: () => {
            addDebugLog("Live API connection opened.");
            setStatus(prev => ({ ...prev, isConnected: true, isListening: true, isThinking: false }));
            
            sessionPromise.then(session => { activeSession = session; }).catch(() => {});

            const source = audioContextRef.current!.input.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.input.createScriptProcessor(2048, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              if (!activeSession || !isSetupComplete) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const base64Data = createBlobFromFloat32(inputData);
              try {
                activeSession.sendRealtimeInput({ audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' } });
              } catch (err) {}
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.input.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.setupComplete) {
              isSetupComplete = true;
              addDebugLog("Live API setup complete.");
              if (!hasSentGreeting) {
                hasSentGreeting = true;
                sessionPromise.then(session => {
                  try {
                    session.sendRealtimeInput({ text: greetingPrompt });
                    addDebugLog("Initial greeting prompt sent.");
                  } catch (e: any) {
                    addDebugLog(`Failed to send initial greeting prompt`, 'error', e);
                  }
                });
              }
            }
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text || '';
              if (text) {
                setCurrentTranscript(prev => prev + text);
                setStatus(prev => ({ ...prev, isListening: true }));
              }
            }
            if (message.serverContent?.turnComplete) {
               setStatus(prev => ({ ...prev, isThinking: true }));
               setMessages(prev => [
                 ...prev,
                 { id: Date.now().toString(), role: 'user', text: currentTranscript || "[Vocal Command]", timestamp: new Date() },
                 { id: (Date.now() + 1).toString(), role: 'friday', text: fridayTranscript, timestamp: new Date() }
               ]);
               
               if (currentTranscript) {
                 detectEmotion(currentTranscript);
               }

               setCurrentTranscript('');
               setFridayTranscript('');
            }
            if (message.serverContent?.outputTranscription) {
              setFridayTranscript(prev => prev + message.serverContent!.outputTranscription!.text);
              setStatus(prev => ({ ...prev, isThinking: false })); 
            }
            
            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) {
              setStatus(prev => ({ ...prev, isSpeaking: true, isThinking: false }));
              const ctx = audioContextRef.current!.output;
              if (nextStartTimeRef.current < ctx.currentTime) nextStartTimeRef.current = ctx.currentTime + 0.05;
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(audioContextRef.current!.outputNode);
              sourcesRef.current.add(source);
              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) {
                    nextStartTimeRef.current = 0;
                    setStatus(prev => ({ ...prev, isSpeaking: false, isListening: true }));
                }
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
            }
            if (message.serverContent?.interrupted) {
              addDebugLog("AI speech interrupted by user.");
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setStatus(prev => ({ ...prev, isSpeaking: false, isListening: true, isThinking: false }));
            }
          },
          onerror: (e: any) => {
            const errMsg = e.message || "LINK_ERROR: Neural bridge compromised.";
            addDebugLog(`Live API Error`, 'error', e);
            setError({
              title: "Connection Error",
              message: errMsg,
              actionText: "Reconnect",
              onAction: startSession
            });
            setStatus(prev => ({ ...prev, isConnected: false }));
          },
          onclose: () => {
            addDebugLog("Live API connection closed.");
            setStatus(prev => ({ ...prev, isConnected: false, isListening: false }));
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: `You are FRIDAY (Female Replacement Intelligent Digital Assistant Youth), a highly advanced AI. 
Current user: ${userProfile.name}.
EMOTION DETECTION MODULE ACTIVE: You must continuously analyze the user's speech input to identify emotional cues (e.g., happiness, sadness, frustration, anger, excitement). 
Based on the detected emotion, you MUST adjust your own synthesized speech (tone, pace, pitch) and conversational responses to be empathetic and contextually appropriate. 
For example, if sadness is detected, offer comforting words and use a softer, slower tone. If excitement is detected, match their energy with a faster, upbeat tone. If frustration is detected, be calm, patient, and solution-oriented.
When the system initializes, you will receive a prompt to greet the user. Provide a warm, personalized greeting based on the time of day and their last session summary if provided.`
        }
      });
      sessionRef.current = sessionPromise;
    } catch (err: any) {
      const errMsg = err.message || "INITIALIZATION_FAILURE";
      addDebugLog(`Session start failed`, 'error', err);
      setError({
        title: "Initialization Failed",
        message: errMsg,
        actionText: errMsg.includes("GEMINI_API_KEY") ? "Check Settings" : "Retry",
        onAction: errMsg.includes("GEMINI_API_KEY") ? undefined : startSession
      });
    }
  };

  const stopSession = () => {
    addDebugLog("Stopping session...");
    if (sessionRef.current) { sessionRef.current.then((s: any) => s.close()); sessionRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(track => track.stop()); streamRef.current = null; }
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    setStatus(prev => ({ ...prev, isConnected: false, isListening: false, isSpeaking: false, isThinking: false }));
  };

  const handleFileUpload = async (file: File) => {
    if (!status.isConnected) { 
      setError({
        title: "Bridge Offline",
        message: "You must initialize the connection before uploading files.",
        actionText: "Initialize",
        onAction: startSession
      }); 
      return; 
    }
    setProcessingFile(true);
    // Mock processing for now, real implementation would follow
    setTimeout(() => setProcessingFile(false), 2000); 
  };

  const mode = getVisualizerMode();

  return (
    <DropZone onFileAccepted={handleFileUpload} isProcessing={processingFile}>
    <div className="flex flex-col h-full bg-[#030303] border border-white/5 rounded-3xl overflow-hidden shadow-2xl relative group">
      
      {/* Top Status Bar */}
      <div className="p-6 flex items-center justify-between z-20 bg-gradient-to-b from-black/80 to-transparent">
        <div className="flex items-center gap-4">
          <div className={`w-2 h-2 rounded-full transition-all duration-500 ${status.isConnected ? 'bg-cyan-400 shadow-[0_0_10px_#00d4ff]' : 'bg-red-500/50'}`}></div>
          <div className="flex flex-col">
            <h2 className="text-[10px] font-bold tracking-[0.3em] text-white/50 uppercase font-mono">FRIDAY CORE</h2>
            <span className="text-[8px] text-white/20 tracking-widest uppercase">
                {mode === 'idle' ? 'STANDBY' : mode.toUpperCase()}
            </span>
          </div>
        </div>

        {/* Emotion Indicator */}
        {status.isConnected && (
            <div className="flex items-center gap-3 bg-white/5 px-4 py-1.5 rounded-full border border-white/10 hidden sm:flex">
                <span className="text-[8px] text-white/40 uppercase tracking-widest">Detected Emotion:</span>
                <span className={`text-[9px] font-bold tracking-widest uppercase ${getEmotionColor(detectedEmotion)}`}>
                    {detectedEmotion}
                </span>
            </div>
        )}

        <button 
          onClick={status.isConnected ? stopSession : startSession}
          className={`px-6 py-2 rounded-full font-bold transition-all text-[10px] uppercase tracking-widest border backdrop-blur-md ${status.isConnected ? 'border-red-500/30 text-red-400 hover:bg-red-950/30' : 'border-cyan-500/30 text-cyan-400 hover:bg-cyan-950/30'}`}
        >
          {status.isConnected ? 'DISCONNECT' : 'INITIALIZE'}
        </button>
        
        <button 
          onClick={() => setShowDebug(!showDebug)}
          className={`px-4 py-2 rounded-full font-bold transition-all text-[10px] uppercase tracking-widest border backdrop-blur-md ml-2 ${showDebug ? 'bg-white/10 border-white/30 text-white' : 'border-white/10 text-white/50 hover:bg-white/5'}`}
        >
          DEBUG
        </button>
      </div>

      {/* Main Visualizer Stage */}
      <div className="flex-1 flex flex-col items-center justify-center relative p-8">
        {/* Background Glow */}
        <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full blur-[100px] pointer-events-none transition-all duration-1000 ${mode === 'speaking' ? 'bg-[#ffcc00]/10' : mode === 'thinking' ? 'bg-purple-500/10' : 'bg-cyan-500/5'}`}></div>
        
        {/* Holographic Avatar Projection Stage */}
        <div className="relative w-full max-w-md aspect-square flex items-center justify-center z-10 group">
            {/* Holographic Brackets */}
            <div className={`absolute inset-0 border-2 border-transparent transition-all duration-1000 ${status.isConnected ? 'border-cyan-500/10 scale-100' : 'scale-90 opacity-0'}`}>
                <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-cyan-400/30"></div>
                <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-cyan-400/30"></div>
                <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-cyan-400/30"></div>
                <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-cyan-400/30"></div>
            </div>

            {/* Scanning Line */}
            {status.isConnected && (
              <div className="absolute top-0 left-0 w-full h-[2px] bg-cyan-400/20 shadow-[0_0_10px_rgba(0,200,255,0.5)]" style={{ animation: 'scan 4s ease-in-out infinite' }}></div>
            )}

            {/* The Avatar Visualizer */}
            <div className={`relative w-full h-full transition-transform duration-1000 ${status.isConnected ? 'scale-100' : 'scale-75 opacity-50'}`}>
              <Visualizer 
                analyzer={audioContextRef.current?.analyzer || null} 
                mode={mode}
                emotion={detectedEmotion}
              />
            </div>

            {/* Holographic Base/Pedestal */}
            <div className={`absolute -bottom-12 left-1/2 -translate-x-1/2 w-3/4 h-8 rounded-[100%] border border-cyan-500/20 bg-cyan-500/5 blur-[2px] transition-all duration-1000 ${status.isConnected ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}`}>
               <div className="absolute inset-0 rounded-[100%] border-t border-cyan-400/40 animate-pulse"></div>
            </div>
        </div>

        {/* Floating Captions */}
        <div className="absolute bottom-12 w-full max-w-2xl text-center min-h-[4rem] z-20 px-8">
          {fridayTranscript ? (
            <p className="text-xl md:text-2xl font-light text-white/90 drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-2 duration-500">
                {fridayTranscript}
            </p>
          ) : currentTranscript ? (
            <p className="text-lg text-cyan-400/80 italic font-mono animate-pulse">
                {currentTranscript}...
            </p>
          ) : (
            <div className={`transition-opacity duration-1000 ${status.isConnected ? 'opacity-100' : 'opacity-0'}`}>
                <p className="text-[10px] uppercase tracking-[0.5em] text-white/20 animate-pulse">Listening for input</p>
            </div>
          )}
        </div>
      </div>

      {/* Compact Chat Log (Collapsed Terminal Style) */}
      <div className="h-40 bg-[#080808]/90 border-t border-white/5 backdrop-blur-xl relative flex flex-col font-mono text-[10px]">
        <div className="px-6 py-2 border-b border-white/5 bg-white/[0.02] flex justify-between items-center">
            <span className="text-white/30 font-bold uppercase tracking-widest">Neural Log</span>
            <div className="flex gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-white/20"></div>
                <div className="w-1.5 h-1.5 rounded-full bg-white/20"></div>
            </div>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2 scroll-smooth">
            {messages.length === 0 && <div className="text-white/10 italic text-center mt-4">System Initialized. Awaiting Interaction.</div>}
            {messages.map((msg) => (
              <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'text-white/50' : msg.role === 'system' ? 'text-cyan-500/70' : 'text-[#ffcc00]/70'}`}>
                 <span className="font-bold shrink-0 w-12">{msg.role === 'user' ? 'USER' : 'AI'}</span>
                 <span className="flex-1 leading-relaxed">{msg.text}</span>
              </div>
            ))}
        </div>
      </div>

      {/* Debug Panel Overlay */}
      {showDebug && (
        <div className="absolute top-24 right-6 w-80 max-h-96 bg-black/90 border border-white/10 rounded-xl overflow-hidden shadow-2xl z-40 flex flex-col font-mono text-[9px]">
          <div className="px-4 py-2 border-b border-white/10 bg-white/5 flex justify-between items-center">
            <span className="text-white/50 font-bold uppercase tracking-widest">Debug Protocol</span>
            <button onClick={() => setShowDebug(false)} className="text-white/50 hover:text-white">×</button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {debugLogs.length === 0 && <div className="text-white/20 italic">No debug logs yet.</div>}
            {debugLogs.map((log, idx) => {
              const [mainMsg, ...details] = log.msg.split(' | Details: ');
              return (
                <div key={idx} className={`flex flex-col gap-1 border-b border-white/5 pb-2 ${log.type === 'error' ? 'text-red-400' : 'text-white/60'}`}>
                  <span className="text-[8px] opacity-50">{log.time.toLocaleTimeString()}</span>
                  <span className="break-words font-bold">{mainMsg}</span>
                  {details.length > 0 && (
                    <span className="break-words text-[8px] opacity-70 bg-black/50 p-1 rounded mt-1">{details.join(' | Details: ')}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Error Overlay */}
      {error && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-50 bg-red-950/95 border border-red-500/50 text-red-200 px-6 py-4 rounded-2xl text-xs flex flex-col gap-3 shadow-[0_0_30px_rgba(220,38,38,0.3)] max-w-md w-[90%] backdrop-blur-md animate-in slide-in-from-top-4 fade-in duration-300">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="w-2 h-2 bg-red-500 animate-pulse rounded-full shrink-0 mt-1.5"></span>
              <div>
                <h3 className="font-bold uppercase tracking-widest text-red-400 mb-1">{error.title}</h3>
                <p className="text-white/70 leading-relaxed">{error.message}</p>
              </div>
            </div>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-white transition-colors text-lg leading-none">&times;</button>
          </div>
          {error.actionText && error.onAction && (
            <div className="flex justify-end mt-2">
              <button 
                onClick={() => {
                  error.onAction!();
                  setError(null);
                }}
                className="px-4 py-1.5 bg-red-500/20 hover:bg-red-500/40 border border-red-500/50 rounded-full text-red-200 uppercase tracking-widest font-bold transition-colors"
              >
                {error.actionText}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
    </DropZone>
  );
};

export default FridayAgent;
