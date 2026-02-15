import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';

const FONT_SANS = "'Inter', 'Helvetica Neue', Arial, sans-serif";
const FONT_MONO = "'JetBrains Mono', 'SF Mono', Menlo, Monaco, monospace";

const fontsCSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');
`;

export const videoConfig = {
  width: 1280,
  height: 720,
  fps: 30,
  durationInFrames: 390,
};

const qrSize = 25;

const scenePlan = {
  desktop: { start: 0, duration: 108 },
  phoneQr: { start: 90, duration: 72 },
  phoneLogin: { start: 154, duration: 72 },
  phoneStart: { start: 218, duration: 72 },
  phoneLive: { start: 282, duration: 108 },
};

const finders = [
  { x: 0, y: 0 },
  { x: qrSize - 7, y: 0 },
  { x: 0, y: qrSize - 7 },
];

function isFinderCell(x, y) {
  for (const finder of finders) {
    const localX = x - finder.x;
    const localY = y - finder.y;
    if (localX < 0 || localY < 0 || localX > 6 || localY > 6) continue;
    if (localX === 0 || localX === 6 || localY === 0 || localY === 6) return true;
    if (localX >= 2 && localX <= 4 && localY >= 2 && localY <= 4) return true;
    return false;
  }
  return false;
}

function qrBit(x, y) {
  if (isFinderCell(x, y)) return 1;
  if (x === 6 || y === 6) return (x + y) % 2 === 0 ? 1 : 0;
  const n = (x * 17 + y * 31 + x * y * 7 + 11) % 9;
  return n < 4 ? 1 : 0;
}

const qrCells = Array.from({ length: qrSize * qrSize }, (_, i) => {
  const x = i % qrSize;
  const y = Math.floor(i / qrSize);
  return qrBit(x, y) === 1;
});

function sceneOpacity(frame, start, duration, fade = 8) {
  const fadeIn = interpolate(frame, [start, start + fade], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.2, 0.9, 0.2, 1),
  });
  const fadeOut = interpolate(frame, [start + duration - fade, start + duration], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.4, 0, 0.8, 0.1),
  });
  return Math.min(fadeIn, fadeOut);
}

function useTypedText(text, frame, startFrame, charsPerFrame = 0.6) {
  const elapsed = Math.max(0, frame - startFrame);
  const count = Math.min(text.length, Math.floor(elapsed * charsPerFrame));
  return text.slice(0, count);
}

/* ── Scene 0: Desktop terminal with typing ── */
function DesktopQrScene({ frame, plan }) {
  const opacity = sceneOpacity(frame, plan.start, plan.duration);
  const local = Math.max(0, frame - plan.start);
  const scale = interpolate(local, [0, plan.duration], [0.97, 1.01], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.2, 0.7, 0.1, 1),
  });
  const lift = interpolate(local, [0, plan.duration], [14, -4], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const cmdText = 'npx culater mypassword';
  const typedCmd = useTypedText(cmdText, local, 8, 0.8);
  const cmdDone = typedCmd.length >= cmdText.length;
  const showCursor = !cmdDone || Math.floor(frame / 8) % 2 === 0;

  const outputStart = 8 + Math.ceil(cmdText.length / 0.8) + 6;
  const showSpinner = local >= outputStart;
  const showUrl = local >= outputStart + 14;
  const showPassword = local >= outputStart + 18;
  const showQr = local >= outputStart + 10;

  const spinnerFrames = ['\u2801', '\u2809', '\u2819', '\u2818', '\u281C', '\u2814', '\u2806', '\u2807', '\u2803', '\u280F'];
  const spinner = spinnerFrames[Math.floor(frame / 3) % spinnerFrames.length];

  return (
    <AbsoluteFill style={{ opacity, justifyContent: 'flex-start', alignItems: 'center', paddingTop: 28 }}>
      <div style={{ width: 1120, marginBottom: 16, display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <div style={{ fontFamily: FONT_SANS, color: '#e5eeff', fontSize: 36, fontWeight: 700, letterSpacing: 0.3 }}>
          Start on your computer.
        </div>
        <div style={{ fontFamily: FONT_SANS, color: '#8fa5c7', fontSize: 20 }}>
          Scan the QR code with your phone.
        </div>
      </div>

      <div
        style={{
          width: 1120,
          borderRadius: 16,
          border: '1px solid rgba(255,255,255,0.12)',
          background: '#0c1119',
          boxShadow: '0 34px 90px rgba(3,7,12,0.55)',
          overflow: 'hidden',
          transform: `translateY(${lift}px) scale(${scale})`,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 16px',
            background: 'rgba(255,255,255,0.04)',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div style={{ width: 12, height: 12, borderRadius: 12, background: '#ff5f57' }} />
          <div style={{ width: 12, height: 12, borderRadius: 12, background: '#febc2e' }} />
          <div style={{ width: 12, height: 12, borderRadius: 12, background: '#28c840' }} />
          <span style={{ marginLeft: 12, fontFamily: FONT_MONO, color: '#6b7a94', fontSize: 13 }}>Terminal</span>
        </div>

        <div style={{ display: 'flex', padding: '20px 22px', minHeight: 380 }}>
          <div style={{ flex: 1, fontFamily: FONT_MONO, fontSize: 20, color: '#d7e1f5', lineHeight: 1.7 }}>
            <div>
              <span style={{ color: '#28c840' }}>~</span>
              <span style={{ color: '#6b7a94' }}> $ </span>
              <span>{typedCmd}</span>
              {!cmdDone && showCursor && <span style={{ background: '#d7e1f5', color: '#0c1119', marginLeft: 1 }}>&nbsp;</span>}
            </div>
            {showSpinner && !showUrl && (
              <div style={{ color: '#57e6cb', marginTop: 2 }}>{spinner} Connecting</div>
            )}
            {showUrl && (
              <>
                <div style={{ color: '#32d583', marginTop: 2 }}>Connected.</div>
                <div style={{ marginTop: 8 }} />
                <div style={{ color: '#57e6cb' }}>  https://abc-def-ghi.trycloudflare.com</div>
                {showPassword && (
                  <div style={{ color: '#ffc07f' }}>  Password: mypassword</div>
                )}
              </>
            )}
          </div>

          {showQr && (
            <div
              style={{
                width: 240,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: interpolate(local, [outputStart + 10, outputStart + 16], [0, 1], {
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                }),
              }}
            >
              <div
                style={{
                  width: 200,
                  height: 200,
                  borderRadius: 10,
                  background: '#f6fbff',
                  display: 'grid',
                  gridTemplateColumns: `repeat(${qrSize}, 1fr)`,
                  gridTemplateRows: `repeat(${qrSize}, 1fr)`,
                  padding: 8,
                  gap: 1,
                }}
              >
                {qrCells.map((on, idx) => (
                  <div key={idx} style={{ background: on ? '#091325' : 'transparent', borderRadius: 1 }} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
}

/* ── Scene 1: QR scan (rendered, no screenshot) ── */
function PhoneQrScanScene({ frame, plan }) {
  const opacity = sceneOpacity(frame, plan.start, plan.duration);
  const local = Math.max(0, frame - plan.start);
  const move = interpolate(local, [0, plan.duration], [14, -6], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.2, 0.8, 0.2, 1),
  });

  // Scanning line animation
  const scanY = interpolate(local, [0, plan.duration * 0.6], [0, 100], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // After scan, show URL
  const showUrl = local > plan.duration * 0.5;
  const urlOpacity = interpolate(local, [plan.duration * 0.5, plan.duration * 0.6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const phoneW = 340;
  const phoneH = 680;

  return (
    <AbsoluteFill style={{ opacity, flexDirection: 'row', alignItems: 'center', padding: '0 60px' }}>
      {/* Left: step info */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 40 }}>
        <div style={{ color: '#57e6cb', fontFamily: FONT_MONO, fontSize: 16, letterSpacing: 1.5, textTransform: 'uppercase' }}>Step 1</div>
        <div style={{ fontFamily: FONT_SANS, color: '#e8f0ff', fontSize: 44, fontWeight: 700, letterSpacing: 0.2 }}>Scan the QR code</div>
        <div style={{ fontFamily: FONT_SANS, color: '#b7c6e2', fontSize: 22, lineHeight: 1.5 }}>Point your phone camera at the terminal QR code to open the tunnel URL.</div>
      </div>

      {/* Right: phone with QR scanner */}
      <div
        style={{
          width: phoneW,
          height: phoneH,
          borderRadius: 36,
          border: '2px solid rgba(255,255,255,0.2)',
          background: '#0a0f18',
          padding: 10,
          boxShadow: '0 36px 90px rgba(2,5,9,0.55)',
          transform: `translateY(${move}px)`,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}
      >
        {/* Camera viewfinder */}
        <div style={{ position: 'relative', width: 220, height: 220 }}>
          {/* QR code */}
          <div
            style={{
              width: 220,
              height: 220,
              borderRadius: 12,
              background: '#f6fbff',
              display: 'grid',
              gridTemplateColumns: `repeat(${qrSize}, 1fr)`,
              gridTemplateRows: `repeat(${qrSize}, 1fr)`,
              padding: 10,
              gap: 1,
            }}
          >
            {qrCells.map((on, idx) => (
              <div key={idx} style={{ background: on ? '#091325' : 'transparent', borderRadius: 1 }} />
            ))}
          </div>

          {/* Scanning line */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${scanY}%`,
              height: 3,
              background: 'linear-gradient(90deg, transparent, #57e6cb, transparent)',
              boxShadow: '0 0 16px rgba(87,230,203,0.6)',
              opacity: showUrl ? 0 : 0.9,
            }}
          />

          {/* Corner brackets */}
          {[
            { top: -2, left: -2, borderTop: '3px solid #57e6cb', borderLeft: '3px solid #57e6cb' },
            { top: -2, right: -2, borderTop: '3px solid #57e6cb', borderRight: '3px solid #57e6cb' },
            { bottom: -2, left: -2, borderBottom: '3px solid #57e6cb', borderLeft: '3px solid #57e6cb' },
            { bottom: -2, right: -2, borderBottom: '3px solid #57e6cb', borderRight: '3px solid #57e6cb' },
          ].map((style, i) => (
            <div key={i} style={{ position: 'absolute', width: 28, height: 28, borderRadius: 4, ...style }} />
          ))}
        </div>

        {/* URL bar below QR */}
        {showUrl && (
          <div
            style={{
              marginTop: 24,
              padding: '10px 16px',
              borderRadius: 12,
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.12)',
              fontFamily: FONT_MONO,
              fontSize: 12,
              color: '#57e6cb',
              opacity: urlOpacity,
            }}
          >
            abc-def-ghi.trycloudflare.com
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
}

/* ── Phone scenes with screenshot (text on left, phone on right) ── */
function PhoneScene({ frame, plan, image, title, subtitle, step }) {
  const opacity = sceneOpacity(frame, plan.start, plan.duration);
  const local = Math.max(0, frame - plan.start);
  const move = interpolate(local, [0, plan.duration], [14, -6], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.2, 0.8, 0.2, 1),
  });
  const scale = interpolate(local, [0, plan.duration], [1, 1.03], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const phoneW = 340;
  const phoneH = 680;

  return (
    <AbsoluteFill style={{ opacity, flexDirection: 'row', alignItems: 'center', padding: '0 60px' }}>
      {/* Left: step info */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 40 }}>
        <div style={{ color: '#57e6cb', fontFamily: FONT_MONO, fontSize: 16, letterSpacing: 1.5, textTransform: 'uppercase' }}>Step {step}</div>
        <div style={{ fontFamily: FONT_SANS, color: '#e8f0ff', fontSize: 44, fontWeight: 700, letterSpacing: 0.2 }}>{title}</div>
        <div style={{ fontFamily: FONT_SANS, color: '#b7c6e2', fontSize: 22, lineHeight: 1.5 }}>{subtitle}</div>
      </div>

      {/* Right: phone */}
      <div
        style={{
          width: phoneW,
          height: phoneH,
          borderRadius: 36,
          border: '2px solid rgba(255,255,255,0.2)',
          background: 'rgba(7,10,16,0.9)',
          padding: 10,
          boxShadow: '0 36px 90px rgba(2,5,9,0.55)',
          transform: `translateY(${move}px) scale(${scale})`,
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <Img
          src={staticFile(image)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            borderRadius: 26,
          }}
        />
      </div>
    </AbsoluteFill>
  );
}

export const CulaterReadmeDemo = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      style={{
        fontFamily: FONT_SANS,
        background:
          'radial-gradient(1200px 900px at 12% -10%, #1c2d48 0%, transparent 46%), radial-gradient(900px 700px at 110% 5%, #1f433a 0%, transparent 44%), linear-gradient(150deg, #05070d, #0d1422 58%, #071019)',
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: fontsCSS }} />
      <DesktopQrScene frame={frame} plan={scenePlan.desktop} />

      <PhoneQrScanScene frame={frame} plan={scenePlan.phoneQr} />

      <PhoneScene
        frame={frame}
        plan={scenePlan.phoneLogin}
        image="demo/phone-login.png"
        step="2"
        title="Log in"
        subtitle="Enter your password to authenticate."
      />

      <PhoneScene
        frame={frame}
        plan={scenePlan.phoneStart}
        image="demo/phone-start.png"
        step="3"
        title="Start your shell"
        subtitle="Pick a recent project and connect."
      />

      <PhoneScene
        frame={frame}
        plan={scenePlan.phoneLive}
        image="demo/phone-live.png"
        step="4"
        title="Run Claude anywhere"
        subtitle="Check output, run commands, nudge your agent from any phone."
      />
    </AbsoluteFill>
  );
};
