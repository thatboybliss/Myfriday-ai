
import React, { useEffect, useRef } from 'react';

export type VisualizerMode = 'listening' | 'speaking' | 'thinking' | 'idle';

interface VisualizerProps {
  analyzer: AnalyserNode | null;
  mode: VisualizerMode;
  emotion?: string;
}

interface Particle {
  x: number;
  y: number;
  angle: number;
  radius: number;
  speed: number;
  alpha: number;
  baseRadius: number;
}

interface Shockwave {
  id: number;
  radius: number;
  alpha: number;
  color: string;
}

const Visualizer: React.FC<VisualizerProps> = ({ 
  analyzer, 
  mode, 
  emotion = 'NEUTRAL'
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const shockwavesRef = useRef<Shockwave[]>([]);
  const timeRef = useRef<number>(0);

  // Initialize particles
  useEffect(() => {
    const count = 60;
    const particles: Particle[] = [];
    for(let i=0; i<count; i++) {
      particles.push({
        x: 0, 
        y: 0,
        angle: Math.random() * Math.PI * 2,
        radius: 0,
        baseRadius: Math.random() * 80 + 40,
        speed: Math.random() * 0.02 + 0.005,
        alpha: Math.random() * 0.5 + 0.2
      });
    }
    particlesRef.current = particles;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle high DPI
    const dpr = window.devicePixelRatio || 1;
    const updateSize = () => {
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
    };
    updateSize();
    window.addEventListener('resize', updateSize);

    let animationId: number;
    
    const bufferLength = analyzer ? analyzer.frequencyBinCount : 0;
    const dataArray = analyzer ? new Uint8Array(bufferLength) : new Uint8Array(0);

    const draw = () => {
      animationId = requestAnimationFrame(draw);
      timeRef.current += 0.01;
      
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const centerX = width / 2;
      const centerY = height / 2;

      // Soft clear for trails
      ctx.fillStyle = 'rgba(3, 3, 3, 0.35)';
      ctx.fillRect(0, 0, width, height);

      // Add composite operation for glowing effect
      ctx.globalCompositeOperation = 'screen';

      if (analyzer) {
        analyzer.getByteFrequencyData(dataArray);
      }

      // Calculate audio metrics
      let volume = 0;
      if (dataArray.length > 0) {
        let sum = 0;
        const bassCount = Math.floor(dataArray.length * 0.2);
        for(let i=0; i<bassCount; i++) sum += dataArray[i];
        volume = sum / bassCount;
      }
      
      const pulse = volume / 255; // 0.0 to 1.0

      // --- EMOTION & MODE CONFIGURATION ---
      let baseColor1 = '0, 200, 255';   // Cyan
      let baseColor2 = '0, 100, 255';   // Blue
      let turbulence = 0.1;
      let coreSizeMult = 1;
      let isErratic = false;
      let ringSpeed = 0.5;
      let sides = 36; // Circle by default

      const e = emotion.toLowerCase();
      
      // 1. Emotion Base
      if (e.includes('happy') || e.includes('joy') || e.includes('excit')) {
          baseColor1 = '255, 200, 0'; baseColor2 = '255, 100, 0';
          coreSizeMult = 1.1; turbulence = 0.3; ringSpeed = 1.0; sides = 8;
      } else if (e.includes('sad') || e.includes('depress')) {
          baseColor1 = '50, 100, 255'; baseColor2 = '20, 50, 150';
          coreSizeMult = 0.8; turbulence = 0.02; ringSpeed = 0.2; sides = 4;
      } else if (e.includes('frustrat') || e.includes('ang')) {
          baseColor1 = '255, 50, 50'; baseColor2 = '200, 0, 0';
          coreSizeMult = 1.2; turbulence = 1.2; isErratic = true; ringSpeed = 2.0; sides = 3;
      } else if (e.includes('anxi') || e.includes('fear')) {
          baseColor1 = '200, 100, 255'; baseColor2 = '100, 0, 200';
          coreSizeMult = 0.9; turbulence = 0.8; isErratic = true; ringSpeed = 1.5; sides = 6;
      }

      // 2. Mode Overrides
      if (mode === 'listening') {
          baseColor1 = '50, 255, 100'; baseColor2 = '0, 200, 50';
          coreSizeMult *= 1.1;
          ringSpeed *= 0.5;
      } else if (mode === 'thinking') {
          baseColor1 = '180, 0, 255'; baseColor2 = '0, 255, 200';
          turbulence += 0.5;
          ringSpeed *= 3.0;
      } else if (mode === 'speaking') {
          coreSizeMult *= (1.2 + pulse * 0.6);
          turbulence += pulse;
      } else if (mode === 'idle') {
          coreSizeMult *= 0.8;
          ringSpeed *= 0.3;
      }

      // --- 1. SHOCKWAVES (Speaking/Erratic) ---
      if ((mode === 'speaking' && pulse > 0.3 && Math.random() > 0.8) || (isErratic && Math.random() > 0.95)) {
         shockwavesRef.current.push({
             id: Date.now(),
             radius: 50 * coreSizeMult,
             alpha: 0.8,
             color: `rgba(${baseColor1},`
         });
      }

      shockwavesRef.current = shockwavesRef.current.filter(wave => wave.alpha > 0.01);
      shockwavesRef.current.forEach(wave => {
          wave.radius += isErratic ? 4 : 2;
          wave.alpha *= 0.92;
          
          ctx.beginPath();
          ctx.arc(centerX, centerY, wave.radius, 0, Math.PI * 2);
          ctx.strokeStyle = `${wave.color} ${wave.alpha})`;
          ctx.lineWidth = isErratic ? 3 : 2;
          ctx.stroke();
      });

      // --- 2. CORE ORB ---
      const breathe = Math.sin(timeRef.current * 2) * 5;
      const audioBump = pulse * 50;
      const r = 50 * coreSizeMult + breathe + audioBump;

      // Outer Glow
      const grad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, r * 1.8);
      grad.addColorStop(0, `rgba(255, 255, 255, 0.9)`);
      grad.addColorStop(0.2, `rgba(${baseColor1}, 0.8)`);
      grad.addColorStop(0.5, `rgba(${baseColor2}, 0.4)`);
      grad.addColorStop(1, `rgba(${baseColor2}, 0)`);

      ctx.beginPath();
      ctx.arc(centerX, centerY, r * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      // Inner Geometric "Iris"
      ctx.beginPath();
      const angleStep = (Math.PI * 2) / sides;
      for (let i = 0; i <= sides; i++) {
          const a = i * angleStep + (timeRef.current * ringSpeed);
          let jitter = 0;
          if (isErratic) {
              jitter = Math.sin(timeRef.current * 20 + i) * 10 * (pulse + 0.5);
          } else if (mode === 'speaking') {
              jitter = Math.sin(timeRef.current * 10 + i) * 5 * pulse;
          }
          
          const px = centerX + Math.cos(a) * (r * 0.5 + jitter);
          const py = centerY + Math.sin(a) * (r * 0.5 + jitter);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = `rgba(255, 255, 255, 0.9)`;
      ctx.lineWidth = 2 + pulse * 3;
      ctx.stroke();
      if (!isErratic && mode !== 'thinking') {
          ctx.fillStyle = `rgba(255, 255, 255, 0.15)`;
          ctx.fill();
      }

      // Center Pupil
      ctx.beginPath();
      ctx.arc(centerX, centerY, r * 0.15, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();

      // --- 3. PARTICLES / ELECTRONS ---
      particlesRef.current.forEach((p, i) => {
          p.angle += p.speed * (isErratic ? 3 : 1) + (turbulence * 0.05);
          
          const currentRadius = p.baseRadius * coreSizeMult + (pulse * 60);
          // Lissajous curve for thinking mode
          const xFactor = mode === 'thinking' ? Math.sin(timeRef.current + i) : 1;
          const yFactor = mode === 'thinking' ? Math.cos(timeRef.current * 1.5 + i) : 1;
          
          const x = centerX + Math.cos(p.angle) * currentRadius * xFactor;
          const y = centerY + Math.sin(p.angle) * currentRadius * yFactor;

          ctx.beginPath();
          ctx.arc(x, y, isErratic ? 3 : 2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${baseColor1}, ${p.alpha})`;
          ctx.fill();

          // Connect to core
          if (Math.random() > 0.85 && mode !== 'idle') {
              ctx.beginPath();
              ctx.moveTo(centerX, centerY);
              ctx.lineTo(x, y);
              ctx.strokeStyle = `rgba(${baseColor1}, ${0.15 + pulse * 0.2})`;
              ctx.lineWidth = isErratic ? 1.5 : 0.5;
              ctx.stroke();
          }
      });

      // --- 4. DATA RINGS (Rotating) ---
      if (mode !== 'idle') {
          const numRings = isErratic ? 5 : 3;
          for(let i=1; i<=numRings; i++) {
              ctx.beginPath();
              const ringR = r * (1.2 + i * 0.4) + (isErratic ? Math.sin(timeRef.current * 10 + i) * 10 : 0);
              const rotation = timeRef.current * (i % 2 === 0 ? 1 : -1) * ringSpeed;
              
              ctx.ellipse(centerX, centerY, ringR, ringR * (isErratic ? 0.6 : 0.8), rotation, 0, Math.PI * 2);
              ctx.strokeStyle = `rgba(${baseColor2}, ${0.15 / i + pulse * 0.1})`;
              ctx.lineWidth = isErratic ? 2 : 1;
              ctx.stroke();
          }
      }

      ctx.globalCompositeOperation = 'source-over';
    };

    draw();
    return () => {
        window.removeEventListener('resize', updateSize);
        cancelAnimationFrame(animationId);
    };
  }, [analyzer, mode, emotion]);

  return (
    <canvas 
      ref={canvasRef} 
      className="w-full h-full pointer-events-none"
    />
  );
};

export default Visualizer;
