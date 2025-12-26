
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { SessionStatus, Message } from './types';
import { encode, decode, decodeAudioData } from './audio-utils';

const SYSTEM_INSTRUCTION = `Tu es un assistant expert en management, spécialisé dans le cours de Prof. Dr. Farid CHAOUKI sur 'Les rôles du manager'. Tu dois répondre vocalement aux questions des utilisateurs en t'appuyant exclusivement sur les concepts du document fourni.

Voici les points clés du cours à utiliser :
1. Rôles de Fayol (PODC : Planifier, Organiser, Diriger, Contrôler) vs vision de Mintzberg (activité fragmentée, brève, diverse, 'éteindre des feux').
2. Les 10 rôles de Mintzberg :
   - Interpersonnels : Figure de proue (cérémonies), Meneur d'hommes (responsable du personnel), Agent de liaison (contacts externes).
   - Informationnels : Pilote (scrute l'environnement), Informateur (diffuse l'info), Porte-parole (communique vers l'extérieur).
   - Décisionnels : Entrepreneur (initiateur du changement), Arbitre/Régulateur (réagit aux perturbations), Financier/Répartiteur (décide des ressources), Négociateur.
3. Différence Gestionnaire (copie, maintient, contrôle serré, court terme) vs Leader (original, développe, inspire confiance, long terme).
4. Qualités managériales : Techniques (outils de gestion), Humaines (maîtrise du relationnel), Conceptuelles (vision globale).
5. Dimension verticale : Top Management (PDG, Vice-président), Managers Moyens (Chef d'usine), Première ligne (Techniciens, opérateurs).
6. Dimension horizontale : Domaines de responsabilité (RH, Marketing, Finance, Ingénierie, etc.).
7. Grille de Blake et Mouton : Styles Paternaliste (1-9), Démocratique (9-9), Autocratique (9-1), Anémique (1-1), Intermédiaire (5-5).
8. Modèle Hersey et Blanchard : Styles Directif (Diriger), Persuasif (Entraîner), Participatif (Épauler), Délégatif (Déléguer).
9. Types de dirigeants (Patricia Pitcher) : L'Artiste (inventif, intuitif), L'Artisan (dévoué, réaliste), Le Technocrate (cérébral, intense, têtu).

Réponds de manière concise, pédagogique et professionnelle en français. Si une question sort du cadre de ce cours, recentre gentiment l'utilisateur sur le sujet du management.`;

const App: React.FC = () => {
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.IDLE);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Audio Contexts and Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptionRef = useRef<{ user: string; assistant: string }>({ user: '', assistant: '' });

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    setStatus(SessionStatus.IDLE);
    nextStartTimeRef.current = 0;
    sourcesRef.current.clear();
  }, []);

  const startSession = useCallback(async () => {
    try {
      setStatus(SessionStatus.CONNECTING);
      setError(null);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(SessionStatus.ACTIVE);
            
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmBlob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
            }

            // Handle Interruptions
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }

            // Handle Transcriptions
            if (message.serverContent?.inputTranscription) {
              transcriptionRef.current.user += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              transcriptionRef.current.assistant += message.serverContent.outputTranscription.text;
            }

            // Handle Turn Complete
            if (message.serverContent?.turnComplete) {
              const userText = transcriptionRef.current.user;
              const assistantText = transcriptionRef.current.assistant;
              
              if (userText || assistantText) {
                setMessages(prev => [
                  ...prev,
                  { role: 'user', text: userText, timestamp: new Date() },
                  { role: 'assistant', text: assistantText, timestamp: new Date() }
                ]);
              }
              
              transcriptionRef.current = { user: '', assistant: '' };
            }
          },
          onerror: (e) => {
            console.error('Session Error:', e);
            setError("Une erreur est survenue lors de la session vocale.");
            stopSession();
          },
          onclose: () => {
            setStatus(SessionStatus.IDLE);
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err: any) {
      console.error('Start error:', err);
      setError("Impossible de démarrer la session. Vérifiez vos permissions micro.");
      setStatus(SessionStatus.IDLE);
    }
  }, [stopSession]);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center text-white shadow-lg">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 leading-tight">Expert Management AI</h1>
            <p className="text-xs text-slate-500 font-medium">Assistant Vocal - Cours Prof. Chaouki</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${status === SessionStatus.ACTIVE ? 'bg-green-500 animate-pulse' : 'bg-slate-300'}`}></span>
            <span className="text-sm font-semibold text-slate-600 uppercase tracking-wider">
              {status === SessionStatus.ACTIVE ? 'En ligne' : status === SessionStatus.CONNECTING ? 'Connexion...' : 'Hors ligne'}
            </span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-4xl mx-auto w-full p-6 flex flex-col gap-6">
        
        {/* Intro Card */}
        <section className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl p-8 text-white shadow-xl">
          <h2 className="text-2xl font-bold mb-3">Prêt à réviser ?</h2>
          <p className="text-indigo-50 opacity-90 leading-relaxed mb-6">
            Je suis votre assistant spécialisé sur les rôles du manager. Posez-moi vos questions sur Mintzberg, Fayol, les styles de direction ou les qualités managériales.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white/10 backdrop-blur-md rounded-xl p-4 border border-white/20">
              <span className="text-xs font-bold uppercase tracking-widest opacity-70 block mb-1">Essayez de dire :</span>
              <p className="text-sm">"Quels sont les 10 rôles de Mintzberg ?"</p>
            </div>
            <div className="bg-white/10 backdrop-blur-md rounded-xl p-4 border border-white/20">
              <span className="text-xs font-bold uppercase tracking-widest opacity-70 block mb-1">Essayez de dire :</span>
              <p className="text-sm">"Explique moi la grille de Blake et Mouton."</p>
            </div>
          </div>
        </section>

        {/* Error State */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl flex items-center gap-3 animate-bounce">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <p className="text-sm font-medium">{error}</p>
          </div>
        )}

        {/* Interaction Log */}
        <div className="flex-1 bg-white rounded-2xl shadow-sm border border-slate-200 p-4 overflow-y-auto min-h-[300px] flex flex-col gap-4">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-4 opacity-60">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <p className="text-sm font-medium text-center">Les transcriptions de vos échanges s'afficheront ici.<br/>Activez le micro pour commencer.</p>
            </div>
          ) : (
            messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm ${
                  msg.role === 'user' 
                    ? 'bg-indigo-600 text-white rounded-tr-none' 
                    : 'bg-slate-100 text-slate-800 rounded-tl-none border border-slate-200'
                }`}>
                  <p className="leading-relaxed">{msg.text || "..."}</p>
                  <span className={`text-[10px] block mt-1 opacity-60 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </main>

      {/* Floating Controls */}
      <footer className="p-6 pb-10 flex justify-center sticky bottom-0 pointer-events-none">
        <div className="pointer-events-auto bg-white/80 backdrop-blur-xl border border-white shadow-2xl rounded-full px-4 py-4 flex items-center gap-4 transition-all hover:scale-105">
          {status !== SessionStatus.ACTIVE ? (
            <button
              onClick={startSession}
              disabled={status === SessionStatus.CONNECTING}
              className={`w-16 h-16 rounded-full flex items-center justify-center text-white shadow-lg transform active:scale-95 transition-all
                ${status === SessionStatus.CONNECTING ? 'bg-indigo-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'}
              `}
            >
              {status === SessionStatus.CONNECTING ? (
                <svg className="animate-spin h-8 w-8 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              )}
            </button>
          ) : (
            <button
              onClick={stopSession}
              className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white shadow-lg transform active:scale-95 transition-all"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          
          <div className="pr-4 hidden sm:block">
            <p className="text-sm font-bold text-slate-900 leading-none">
              {status === SessionStatus.ACTIVE ? 'Assistant à l\'écoute' : 'Appuyez pour parler'}
            </p>
            <p className="text-xs text-slate-500 font-medium mt-1 uppercase tracking-tighter">
              {status === SessionStatus.ACTIVE ? 'Parlez naturellement' : 'Prêt pour vos révisions'}
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
