import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CSSProperties, ReactNode } from 'react';
import type { NodeKind, OutputFormat, SeedFormat } from '@geoflow/transform';

export interface FlowNodeData extends Record<string, unknown> {
  kind: NodeKind;
  label: string;
  detail: string;
  status: 'idle' | 'running' | 'ok' | 'error' | 'skipped';
  error?: string | undefined;
}

const KIND_STYLES: Record<NodeKind, { color: string; border: string; bg: string; icon: ReactNode }> = {
  source: {
    color: '#54678a',
    border: '#c8d5ee',
    bg: '#eef2fb',
    icon: <span style={{ fontWeight: 700 }}>S</span>,
  },
  seed: {
    color: '#7a5a30',
    border: '#ecd5a3',
    bg: '#fbf3e2',
    icon: <span style={{ fontWeight: 700 }}>D</span>,
  },
  sql: {
    color: '#3f6d4a',
    border: '#c4dccb',
    bg: '#ecf4ee',
    icon: <span style={{ fontWeight: 700 }}>{'{ }'}</span>,
  },
  output: {
    color: '#86472a',
    border: '#f2d2b0',
    bg: '#fbeee0',
    icon: <span style={{ fontWeight: 700 }}>→</span>,
  },
  file: {
    color: '#6b4e85',
    border: '#d8c7e6',
    bg: '#f3edf7',
    icon: <span style={{ fontWeight: 700 }}>F</span>,
  },
};

const STATUS_DOT: Record<FlowNodeData['status'], string> = {
  idle: '#c7cdd6',
  running: '#d9a05a',
  ok: '#82c096',
  error: '#d57878',
  skipped: '#a3b1c8',
};

function NodeShell({
  data,
  selected,
  hasInput,
  hasOutput,
}: {
  data: FlowNodeData;
  selected: boolean;
  hasInput: boolean;
  hasOutput: boolean;
}) {
  const s = KIND_STYLES[data.kind];
  const style: CSSProperties = {
    minWidth: 180,
    background: s.bg,
    border: `1.5px solid ${selected ? s.color : s.border}`,
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 12,
    color: '#334155',
    boxShadow: selected ? `0 0 0 2px ${s.color}33` : '0 1px 2px rgba(0,0,0,0.04)',
  };
  return (
    <div style={style}>
      {hasInput && <Handle type="target" position={Position.Left} style={{ background: s.color }} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            width: 22, height: 22, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: s.color, color: 'white', fontSize: 11,
          }}
        >
          {s.icon}
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ fontWeight: 700, color: s.color, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {data.label}
          </div>
          <div style={{ fontSize: 10, color: '#7c8b9b', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            {data.kind}
          </div>
        </div>
        <span
          title={data.status === 'error' ? data.error ?? 'error' : data.status}
          style={{
            width: 8, height: 8, borderRadius: '50%',
            background: STATUS_DOT[data.status],
            flexShrink: 0,
          }}
        />
      </div>
      {data.detail && (
        <div style={{ marginTop: 6, fontFamily: 'monospace', fontSize: 11, color: '#5a6878', maxHeight: 32, overflow: 'hidden' }}>
          {data.detail}
        </div>
      )}
      {hasOutput && <Handle type="source" position={Position.Right} style={{ background: s.color }} />}
    </div>
  );
}

export function SourceNodeView({ data, selected }: NodeProps) {
  return <NodeShell data={data as FlowNodeData} selected={selected ?? false} hasInput={false} hasOutput={true} />;
}
export function SeedNodeView({ data, selected }: NodeProps) {
  return <NodeShell data={data as FlowNodeData} selected={selected ?? false} hasInput={false} hasOutput={true} />;
}
export function SqlNodeView({ data, selected }: NodeProps) {
  return <NodeShell data={data as FlowNodeData} selected={selected ?? false} hasInput={true} hasOutput={true} />;
}
export function OutputNodeView({ data, selected }: NodeProps) {
  return <NodeShell data={data as FlowNodeData} selected={selected ?? false} hasInput={true} hasOutput={false} />;
}
export function FileNodeView({ data, selected }: NodeProps) {
  return <NodeShell data={data as FlowNodeData} selected={selected ?? false} hasInput={false} hasOutput={true} />;
}

export const NODE_TYPES = {
  source: SourceNodeView,
  seed: SeedNodeView,
  sql: SqlNodeView,
  output: OutputNodeView,
  file: FileNodeView,
};

export const SEED_FORMATS: SeedFormat[] = ['csv', 'json'];
export const OUTPUT_FORMATS: OutputFormat[] = ['preview', 'csv', 'json', 'parquet', 'geojson'];
