//! GeoPackage binary geometry encoding for 2-D points.
//!
//! Layout: 8-byte GP header + 21-byte WKB Point = 29 bytes total.
//! Spec reference: OGC 12-128r15 §2.1.3.

/// Encode a 2-D point as a GeoPackage geometry blob.
///
/// `x` = easting or longitude, `y` = northing or latitude, in the unit
/// of `srs_id` (use EPSG 4326 for WGS 84, 27700 for BNG).
pub fn encode_point(x: f64, y: f64, srs_id: i32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(29);
    // GP header
    buf.extend_from_slice(b"GP"); // magic
    buf.push(0x00); // version
    buf.push(0x01); // flags: byte-order=LE, envelope=none
    buf.extend_from_slice(&srs_id.to_le_bytes());
    // WKB Point (little-endian)
    buf.push(0x01); // byte order
    buf.extend_from_slice(&1u32.to_le_bytes()); // wkbType = Point
    buf.extend_from_slice(&x.to_le_bytes());
    buf.extend_from_slice(&y.to_le_bytes());
    buf
}

/// Decode the (x, y) from a GeoPackage geometry blob.
pub fn decode_point(blob: &[u8]) -> Option<(f64, f64)> {
    if blob.len() < 29 || &blob[..2] != b"GP" {
        return None;
    }
    // 8-byte header + 1 (byte-order) + 4 (wkbType) = offset 13 for x
    let x = f64::from_le_bytes(blob[13..21].try_into().ok()?);
    let y = f64::from_le_bytes(blob[21..29].try_into().ok()?);
    Some((x, y))
}

/// Guess whether `(e, n)` looks like British National Grid metres or
/// WGS 84 degrees, and return the likely EPSG code.
pub fn guess_epsg(e: f64, n: f64) -> i32 {
    if (100_000.0..=700_000.0).contains(&e) && (0.0..=1_300_000.0).contains(&n) {
        27700
    } else {
        4326
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_wgs84_point() {
        let (x, y) = (-0.1278, 51.5074); // London
        let blob = encode_point(x, y, 4326);
        assert_eq!(blob.len(), 29);
        let (dx, dy) = decode_point(&blob).unwrap();
        assert!((dx - x).abs() < 1e-10);
        assert!((dy - y).abs() < 1e-10);
    }

    #[test]
    fn decode_rejects_invalid() {
        assert!(decode_point(b"").is_none());
        assert!(decode_point(b"XX").is_none());
    }

    #[test]
    fn guess_bng_vs_wgs84() {
        assert_eq!(guess_epsg(530_000.0, 180_000.0), 27700); // Southampton area
        assert_eq!(guess_epsg(-1.5, 53.0), 4326); // Leeds in WGS84
    }
}
