import { useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet';
import proj4 from 'proj4';
import 'leaflet/dist/leaflet.css';
import { decodeBytes, parseStr } from '../core.js';
import type { AgsFile, AgsValue } from '../core.js';

// British National Grid (EPSG:27700) → WGS84 (EPSG:4326)
const BNG = '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.247,0.8421,-20.4894 +units=m +no_defs';

interface BoreholePt {
  id: string;
  lat: number;
  lng: number;
  type: string | null;
  depth: string | null;
}

function toNum(v: AgsValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseFloat(v);
    if (!isNaN(n)) return n;
  }
  return NaN;
}

function toStr(v: AgsValue): string | null {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number') return String(v);
  return null;
}

function extractPoints(agsFile: AgsFile): BoreholePt[] {
  const loca = agsFile.groups['LOCA'];
  if (!loca) return [];

  const pts: BoreholePt[] = [];
  for (const row of loca.rows) {
    const id = toStr(row['LOCA_ID'] ?? null);
    if (!id) continue;

    const type = toStr(row['LOCA_TYPE'] ?? null);
    const depth = toStr(row['LOCA_FDEP'] ?? null);

    // Prefer explicit lat/lon fields
    const latVal = toNum(row['LOCA_LAT'] ?? null);
    const lonVal = toNum(row['LOCA_LON'] ?? row['LOCA_LONG'] ?? null);
    if (!isNaN(latVal) && !isNaN(lonVal) && latVal !== 0 && lonVal !== 0) {
      pts.push({ id, lat: latVal, lng: lonVal, type, depth });
      continue;
    }

    // Fall back to BNG easting/northing
    const easting = toNum(row['LOCA_NATE'] ?? null);
    const northing = toNum(row['LOCA_NATN'] ?? null);
    if (!isNaN(easting) && !isNaN(northing) && easting > 0 && northing > 0) {
      try {
        const [lng, lat] = proj4(BNG, 'EPSG:4326', [easting, northing]);
        pts.push({ id, lat, lng, type, depth });
      } catch {
        // skip unconvertible coordinates
      }
    }
  }
  return pts;
}

interface Props {
  fileBytes: Uint8Array | null;
  fileName: string | undefined;
  onLocaClick?: (locaId: string) => void;
}

export function MapTab({ fileBytes, fileName, onLocaClick }: Props) {
  const agsFile = useMemo<AgsFile | null>(() => {
    if (!fileBytes) return null;
    try {
      const text = decodeBytes(fileBytes);
      return parseStr(text).file;
    } catch {
      return null;
    }
  }, [fileBytes, fileName]);

  const points = useMemo(() => (agsFile ? extractPoints(agsFile) : []), [agsFile]);

  if (!fileBytes) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
        <p>Drop an AGS file above to view borehole locations.</p>
      </div>
    );
  }

  if (points.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
        <p>No mappable coordinates found.</p>
        <p style={{ fontSize: 12, marginTop: 8 }}>
          Map view requires <code>LOCA_LAT</code>/<code>LOCA_LON</code> or BNG
          <code> LOCA_NATE</code>/<code>LOCA_NATN</code> fields in the LOCA group.
        </p>
      </div>
    );
  }

  const centerLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const centerLng = points.reduce((s, p) => s + p.lng, 0) / points.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          {points.length} borehole{points.length !== 1 ? 's' : ''} plotted
        </span>
      </div>

      <div style={{ borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--border)', height: 520 }}>
        <MapContainer
          center={[centerLat, centerLng]}
          zoom={13}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {points.map((pt) => (
            <CircleMarker
              key={pt.id}
              center={[pt.lat, pt.lng]}
              radius={7}
              pathOptions={{ color: '#0f2644', fillColor: '#1a4080', fillOpacity: 0.85, weight: 2 }}
            >
              <Popup>
                <div style={{ minWidth: 140 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{pt.id}</div>
                  {pt.type && (
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 2 }}>Type: {pt.type}</div>
                  )}
                  {pt.depth && (
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>Depth: {pt.depth} m</div>
                  )}
                  {onLocaClick && (
                    <button
                      onClick={() => onLocaClick(pt.id)}
                      style={{
                        marginTop: 4, padding: '4px 10px', fontSize: 11, fontWeight: 600,
                        background: '#0f2644', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer',
                      }}
                    >
                      View Data
                    </button>
                  )}
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}
