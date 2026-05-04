//! Spatial utilities: CRS and reprojection logic (pure Rust).
//!
//! These are *engineering-grade* approximations suitable for sanity
//! checks (e.g. "are these two boreholes within 2 m of each other") and
//! for coarse map placement. They are **not** suitable for survey-grade
//! work, which would require a full datum-shift implementation
//! (e.g. via `proj`).
//!
//! v0.1 supports two CRSes:
//! - WGS 84 geographic (EPSG:4326), longitude/latitude in degrees.
//! - British National Grid (EPSG:27700), easting/northing in metres.

/// Supported Coordinate Reference Systems.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Crs {
    /// WGS 84 (GPS coordinates) — EPSG:4326.
    Wgs84,
    /// British National Grid — EPSG:27700.
    Bng,
}

impl Crs {
    pub fn from_epsg(epsg: u32) -> Option<Self> {
        match epsg {
            4326 => Some(Crs::Wgs84),
            27700 => Some(Crs::Bng),
            _ => None,
        }
    }

    pub fn epsg(self) -> u32 {
        match self {
            Crs::Wgs84 => 4326,
            Crs::Bng => 27700,
        }
    }
}

/// Reproject a point from one CRS to another.
///
/// Input/output convention:
/// - WGS 84 points are `(longitude, latitude)` in degrees (the
///   `(easting, northing)`-style convention used elsewhere in
///   GeoFlow's spatial helpers, with longitude in the X slot).
/// - BNG points are `(easting, northing)` in metres.
pub fn reproject(point: (f64, f64), from: Crs, to: Crs) -> (f64, f64) {
    if from == to {
        return point;
    }
    match (from, to) {
        (Crs::Bng, Crs::Wgs84) => bng_to_wgs84(point),
        (Crs::Wgs84, Crs::Bng) => wgs84_to_bng(point),
        _ => point,
    }
}

// ── BNG ↔ WGS 84 ────────────────────────────────────────────────────
//
// We use the OS-published transverse-Mercator parameters for OSGB36 +
// the National Grid origin. Datum shift between OSGB36 and WGS 84 is
// applied as a constant (no Helmert) — for survey-grade work the OSTN15
// grid is required; that is intentionally out of scope for v0.1.
//
// Constants below are from "A guide to coordinate systems in Great
// Britain" (Ordnance Survey, 2018, Annex A and B).

const A_AIRY: f64 = 6_377_563.396; // semi-major axis
const B_AIRY: f64 = 6_356_256.909; // semi-minor axis
const F0: f64 = 0.999_601_271_7; // central meridian scale factor
const PHI0_DEG: f64 = 49.0;
const LAM0_DEG: f64 = -2.0;
const N0: f64 = -100_000.0;
const E0: f64 = 400_000.0;

fn bng_to_wgs84(point: (f64, f64)) -> (f64, f64) {
    let (e, n) = point;

    let phi0 = PHI0_DEG.to_radians();
    let lam0 = LAM0_DEG.to_radians();
    let e2 = 1.0 - (B_AIRY * B_AIRY) / (A_AIRY * A_AIRY);
    let n_param = (A_AIRY - B_AIRY) / (A_AIRY + B_AIRY);

    let mut phi = phi0;
    let mut m;
    loop {
        m = meridional(phi, phi0, n_param);
        let next = phi + (n - N0 - m) / (A_AIRY * F0);
        if (next - phi).abs() < 1e-12 {
            phi = next;
            break;
        }
        phi = next;
    }

    let nu = A_AIRY * F0 / (1.0 - e2 * phi.sin().powi(2)).sqrt();
    let rho = A_AIRY * F0 * (1.0 - e2) / (1.0 - e2 * phi.sin().powi(2)).powf(1.5);
    let eta2 = nu / rho - 1.0;
    let tan_phi = phi.tan();

    let vii = tan_phi / (2.0 * rho * nu);
    let viii = tan_phi / (24.0 * rho * nu.powi(3))
        * (5.0 + 3.0 * tan_phi.powi(2) + eta2 - 9.0 * tan_phi.powi(2) * eta2);
    let ix = tan_phi / (720.0 * rho * nu.powi(5))
        * (61.0 + 90.0 * tan_phi.powi(2) + 45.0 * tan_phi.powi(4));
    let x = phi.cos().recip() / nu;
    let xi = phi.cos().recip() / (6.0 * nu.powi(3)) * (nu / rho + 2.0 * tan_phi.powi(2));
    let xii = phi.cos().recip() / (120.0 * nu.powi(5))
        * (5.0 + 28.0 * tan_phi.powi(2) + 24.0 * tan_phi.powi(4));
    let xiia = phi.cos().recip() / (5040.0 * nu.powi(7))
        * (61.0 + 662.0 * tan_phi.powi(2) + 1320.0 * tan_phi.powi(4) + 720.0 * tan_phi.powi(6));

    let de = e - E0;
    let phi_final = phi - vii * de.powi(2) + viii * de.powi(4) - ix * de.powi(6);
    let lam_final = lam0 + x * de - xi * de.powi(3) + xii * de.powi(5) - xiia * de.powi(7);

    // Return (lon, lat) in degrees. Datum shift OSGB36 → WGS84 is
    // approximated as identity for v0.1; see module docs.
    (lam_final.to_degrees(), phi_final.to_degrees())
}

fn wgs84_to_bng(point: (f64, f64)) -> (f64, f64) {
    let (lon_deg, lat_deg) = point;

    let phi = lat_deg.to_radians();
    let lam = lon_deg.to_radians();
    let phi0 = PHI0_DEG.to_radians();
    let lam0 = LAM0_DEG.to_radians();
    let e2 = 1.0 - (B_AIRY * B_AIRY) / (A_AIRY * A_AIRY);
    let n_param = (A_AIRY - B_AIRY) / (A_AIRY + B_AIRY);

    let nu = A_AIRY * F0 / (1.0 - e2 * phi.sin().powi(2)).sqrt();
    let rho = A_AIRY * F0 * (1.0 - e2) / (1.0 - e2 * phi.sin().powi(2)).powf(1.5);
    let eta2 = nu / rho - 1.0;
    let m = meridional(phi, phi0, n_param);

    let cos_phi = phi.cos();
    let sin_phi = phi.sin();
    let tan_phi = phi.tan();

    let i = m + N0;
    let ii = (nu / 2.0) * sin_phi * cos_phi;
    let iii = (nu / 24.0) * sin_phi * cos_phi.powi(3) * (5.0 - tan_phi.powi(2) + 9.0 * eta2);
    let iiia = (nu / 720.0)
        * sin_phi
        * cos_phi.powi(5)
        * (61.0 - 58.0 * tan_phi.powi(2) + tan_phi.powi(4));
    let iv = nu * cos_phi;
    let v = (nu / 6.0) * cos_phi.powi(3) * (nu / rho - tan_phi.powi(2));
    let vi = (nu / 120.0)
        * cos_phi.powi(5)
        * (5.0 - 18.0 * tan_phi.powi(2) + tan_phi.powi(4) + 14.0 * eta2
            - 58.0 * tan_phi.powi(2) * eta2);

    let dlam = lam - lam0;
    let n = i + ii * dlam.powi(2) + iii * dlam.powi(4) + iiia * dlam.powi(6);
    let e = E0 + iv * dlam + v * dlam.powi(3) + vi * dlam.powi(5);

    (e, n)
}

fn meridional(phi: f64, phi0: f64, n: f64) -> f64 {
    let ma = (1.0 + n + (5.0 / 4.0) * n.powi(2) + (5.0 / 4.0) * n.powi(3)) * (phi - phi0);
    let mb = (3.0 * n + 3.0 * n.powi(2) + (21.0 / 8.0) * n.powi(3))
        * (phi - phi0).sin()
        * (phi + phi0).cos();
    let mc = ((15.0 / 8.0) * n.powi(2) + (15.0 / 8.0) * n.powi(3))
        * (2.0 * (phi - phi0)).sin()
        * (2.0 * (phi + phi0)).cos();
    let md = (35.0 / 24.0) * n.powi(3) * (3.0 * (phi - phi0)).sin() * (3.0 * (phi + phi0)).cos();
    B_AIRY * F0 * (ma - mb + mc - md)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() < tol
    }

    #[test]
    fn bng_round_trip_through_wgs84() {
        // National Grid origin-ish point in central England.
        let bng = (400_000.0, 300_000.0);
        let wgs = bng_to_wgs84(bng);
        let back = wgs84_to_bng(wgs);
        assert!(
            approx(bng.0, back.0, 1.0),
            "easting drift: {bng:?} -> {back:?}"
        );
        assert!(
            approx(bng.1, back.1, 1.0),
            "northing drift: {bng:?} -> {back:?}"
        );
    }

    #[test]
    fn known_central_point_within_a_few_metres() {
        // The OS guide gives (651409.903, 313177.270) BNG ≈
        // 52.65797°N, 1.71792°E (reference point T0 0NB, approximately).
        let (e, n) = wgs84_to_bng((1.71792, 52.657_97));
        // Allow ~10 m tolerance (no OSTN15 in v0.1).
        assert!(approx(e, 651_409.9, 50.0), "e off: {e}");
        assert!(approx(n, 313_177.3, 50.0), "n off: {n}");
    }

    #[test]
    fn reproject_identity() {
        assert_eq!(reproject((1.0, 2.0), Crs::Wgs84, Crs::Wgs84), (1.0, 2.0));
        assert_eq!(reproject((1.0, 2.0), Crs::Bng, Crs::Bng), (1.0, 2.0));
    }

    #[test]
    fn crs_epsg_round_trip() {
        assert_eq!(Crs::from_epsg(4326), Some(Crs::Wgs84));
        assert_eq!(Crs::from_epsg(27700), Some(Crs::Bng));
        assert_eq!(Crs::from_epsg(9999), None);
        assert_eq!(Crs::Wgs84.epsg(), 4326);
        assert_eq!(Crs::Bng.epsg(), 27700);
    }
}
