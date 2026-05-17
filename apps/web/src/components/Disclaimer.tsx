import { useEffect } from 'react';

export const DISCLAIMER_LINES: string[] = [
  'GeoFlow is provided "as is", without warranty of any kind, express or implied.',
  'It is an open-source utility for inspecting, validating and converting geotechnical data. It is not a substitute for professional engineering judgement.',
  'All processing happens locally in your browser — no data is uploaded to a server — but you remain responsible for verifying the accuracy of any output before relying on it for design, construction, reporting or any safety-critical decision.',
  'The authors and contributors accept no liability for any loss, damage or cost arising from use of this tool or the data it produces.',
];

interface DisclaimerModalProps {
  onClose: () => void;
}

export function DisclaimerModal({ onClose }: DisclaimerModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="gf-disclaimer-title"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(20, 28, 42, 0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--card)', borderRadius: 'var(--radius)',
          border: '1px solid var(--border)',
          maxWidth: 560, width: '100%',
          boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 18px', background: 'var(--amber-soft)',
          borderBottom: '1px solid var(--amber-border)',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="2" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4 M12 17h.01 M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <h2 id="gf-disclaimer-title" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
            Disclaimer
          </h2>
        </div>
        <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {DISCLAIMER_LINES.map((line, i) => (
            <p key={i} style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text)' }}>{line}</p>
          ))}
        </div>
        <div style={{
          padding: '12px 18px', borderTop: '1px solid var(--border)',
          display: 'flex', justifyContent: 'flex-end',
        }}>
          <button
            onClick={onClose}
            autoFocus
            style={{
              padding: '7px 16px', fontSize: 12, fontWeight: 600,
              background: 'var(--navy)', color: '#fff',
              border: '1px solid var(--navy)', borderRadius: 6,
            }}
          >
            I understand
          </button>
        </div>
      </div>
    </div>
  );
}

interface DisclaimerBannerProps {
  onOpen: () => void;
}

export function DisclaimerBanner({ onOpen }: DisclaimerBannerProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '12px 14px',
      background: 'var(--amber-soft)',
      border: '1px solid var(--amber-border)',
      borderRadius: 'var(--radius)',
      color: 'var(--text)',
      fontSize: 12.5,
      lineHeight: 1.55,
      textAlign: 'left',
    }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4 M12 17h.01 M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
      <div>
        <strong>Disclaimer.</strong>{' '}GeoFlow is provided <em>as is</em>, with no warranty, and is not a substitute for professional engineering judgement. You remain responsible for verifying any output before use.{' '}
        <button
          onClick={onOpen}
          style={{
            padding: 0, background: 'transparent', border: 'none',
            color: 'var(--accent)', fontWeight: 600, cursor: 'pointer',
            textDecoration: 'underline', fontSize: 'inherit',
          }}
        >
          Read full disclaimer
        </button>
      </div>
    </div>
  );
}
