/**
 * Playwright tests for the VoxelTab in the GeoFlow React SPA.
 *
 * Tests cover UI structure, control visibility, and state transitions
 * before and after loading the browser_explorer fixture file.
 *
 * AGS fixture: tests/fixtures/ags/browser_explorer.ags
 *   → 3 boreholes: BH01 (E=100, N=200, GL=15.2), BH02 (E=115, N=212, GL=14.8), TP01 (E=130, N=225, GL=15.0)
 *   → ISPT_NVAL numeric field (2 observations: BH01=18, BH02=35)
 *   → GEOL_LEG categorical field (5 entries across 3 boreholes)
 */

import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE   = join(__dirname, '../fixtures/ags/browser_explorer.ags');
const BASE      = '/geoflow/';

// ── Helpers ───────────────────────────────────────────────────────────────────

type Page = import('@playwright/test').Page;

async function uploadFixture(page: Page): Promise<void> {
  await page.setInputFiles('input[type="file"]', FIXTURE);
  // Use .first() in case multiple elements contain the filename (e.g. p vs pre)
  await expect(page.getByText('browser_explorer.ags').first()).toBeVisible();
}

async function goToVoxel(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Voxels' }).click();
}

async function buildGrid(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Build Voxel Grid' }).click();
  // Grid info label only renders when grid state is set — reliable completion signal
  await expect(page.getByText('Grid', { exact: true })).toBeVisible({ timeout: 20_000 });
}

// ── App shell ─────────────────────────────────────────────────────────────────

test('Voxel tab button is visible in app shell', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.getByRole('button', { name: 'Voxels' })).toBeVisible();
});

// ── Voxel tab — no file loaded ────────────────────────────────────────────────

test.describe('Voxel tab — no file loaded', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await goToVoxel(page);
  });

  test('shows "Load an AGS file to begin" prompt in the property panel', async ({ page }) => {
    await expect(page.getByText('Load an AGS file to begin.')).toBeVisible();
  });

  test('Build Voxel Grid button is present but disabled', async ({ page }) => {
    const btn = page.getByRole('button', { name: 'Build Voxel Grid' });
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
  });

  test('canvas placeholder text is visible', async ({ page }) => {
    await expect(page.getByText('Select a property and click Build Voxel Grid')).toBeVisible();
  });

  test('Topo surface section is visible with load and fetch buttons', async ({ page }) => {
    await expect(page.getByText('Topo surface')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load .asc / .xyz' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fetch SRTM 30m' })).toBeVisible();
  });

  test('Grid resolution slider is present', async ({ page }) => {
    await expect(page.getByText(/Grid resolution/)).toBeVisible();
    const slider = page.locator('input[type="range"]').first();
    await expect(slider).toBeVisible();
  });

  test('Opacity and vertical exaggeration sliders are present', async ({ page }) => {
    await expect(page.getByText(/Opacity/)).toBeVisible();
    await expect(page.getByText(/Vertical exaggeration/)).toBeVisible();
  });

  test('Cross-section control is visible with Off toggle button', async ({ page }) => {
    await expect(page.getByText('Cross-section')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Off', exact: true })).toBeVisible();
  });
});

// ── Voxel tab — after file upload ─────────────────────────────────────────────

test.describe('Voxel tab — browser_explorer.ags loaded', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await uploadFixture(page);
    await goToVoxel(page);
  });

  test('"Load an AGS file to begin" prompt is gone after upload', async ({ page }) => {
    await expect(page.getByText('Load an AGS file to begin.')).not.toBeAttached();
  });

  test('property dropdown is visible and contains ISPT_NVAL', async ({ page }) => {
    const select = page.locator('select').first();
    await expect(select).toBeVisible();
    await expect(select.locator('option', { hasText: 'ISPT_NVAL' })).toBeAttached();
  });

  test('property dropdown contains GEOL_LEG categorical field', async ({ page }) => {
    const select = page.locator('select').first();
    await expect(select.locator('option', { hasText: 'GEOL_LEG' })).toBeAttached();
  });

  test('Build Voxel Grid button becomes enabled after file load', async ({ page }) => {
    const btn = page.getByRole('button', { name: 'Build Voxel Grid' });
    await expect(btn).toBeEnabled();
  });

  test('Topo surface panel shows collar TPS status', async ({ page }) => {
    await expect(page.getByText(/Collar TPS/)).toBeVisible();
  });

  test('Fetch SRTM button is enabled when a model is available', async ({ page }) => {
    const srtmBtn = page.getByRole('button', { name: 'Fetch SRTM 30m' });
    await expect(srtmBtn).toBeEnabled();
  });
});

// ── Voxel tab — build and inspect controls ─────────────────────────────────────

test.describe('Voxel tab — controls after building a grid', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await uploadFixture(page);
    await goToVoxel(page);
    await buildGrid(page);
  });

  test('Grid info panel appears after build', async ({ page }) => {
    await expect(page.getByText('Grid', { exact: true })).toBeVisible();
    await expect(page.getByText('Method')).toBeVisible();
    await expect(page.getByText(/Populated/)).toBeVisible();
  });

  test('Colour by panel appears with Value, Geology, Certainty buttons', async ({ page }) => {
    await expect(page.getByText('Colour by')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Value', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Geology', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Certainty', exact: true })).toBeVisible();
  });

  test('clicking Certainty colour mode shows certainty scale legend', async ({ page }) => {
    await page.getByRole('button', { name: 'Certainty', exact: true }).click();
    await expect(page.getByText('Certainty scale')).toBeVisible();
    await expect(page.getByText('Low', { exact: true })).toBeVisible();
    await expect(page.getByText('High', { exact: true })).toBeVisible();
  });

  test('clicking Geology colour mode keeps colour buttons visible', async ({ page }) => {
    await page.getByRole('button', { name: 'Geology', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Value', exact: true })).toBeVisible();
  });

  test('tool bar shows Orbit, Cell Info, and Virtual BH buttons', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Orbit' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cell Info' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Virtual BH' })).toBeVisible();
  });

  test('clicking Cell Info changes the cursor hint text', async ({ page }) => {
    await page.getByRole('button', { name: 'Cell Info' }).click();
    await expect(page.getByText('Click a voxel to inspect its lineage')).toBeVisible();
  });

  test('clicking Virtual BH changes the cursor hint text', async ({ page }) => {
    await page.getByRole('button', { name: 'Virtual BH' }).click();
    await expect(page.getByText('Click the model surface to drill a virtual borehole')).toBeVisible();
  });

  test('switching back to Orbit restores orbit hint', async ({ page }) => {
    await page.getByRole('button', { name: 'Cell Info' }).click();
    await page.getByRole('button', { name: 'Orbit' }).click();
    await expect(page.getByText('Drag to orbit · Scroll to zoom')).toBeVisible();
  });

  test('Export panel shows CSV, OBJ and GLB buttons', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'CSV', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'OBJ', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'GLB', exact: true })).toBeVisible();
  });

  test('cross-section toggle turns On when clicked', async ({ page }) => {
    const offBtn = page.getByRole('button', { name: 'Off', exact: true });
    await expect(offBtn).toBeEnabled();
    await offBtn.click();
    await expect(page.getByRole('button', { name: 'On', exact: true })).toBeVisible();
  });

  test('enabling cross-section reveals X, Y, Z axis buttons', async ({ page }) => {
    await page.getByRole('button', { name: 'Off', exact: true }).click();
    await expect(page.getByRole('button', { name: 'X', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Y', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Z', exact: true })).toBeVisible();
  });

  test('enabling cross-section reveals position slider', async ({ page }) => {
    await page.getByRole('button', { name: 'Off', exact: true }).click();
    await expect(page.getByText(/Position/)).toBeVisible();
  });

  test('disabling cross-section hides axis buttons', async ({ page }) => {
    await page.getByRole('button', { name: 'Off', exact: true }).click();
    await expect(page.getByRole('button', { name: 'X', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'On', exact: true }).click();
    await expect(page.getByRole('button', { name: 'X', exact: true })).not.toBeAttached();
  });
});

// ── Voxel tab — interpolation method selector ─────────────────────────────────

test.describe('Voxel tab — interpolation method controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await uploadFixture(page);
    await goToVoxel(page);
    // Select a numeric property so interpolation method controls are shown
    await page.locator('select').first().selectOption('ISPT_NVAL');
  });

  test('interpolation method panel shows 3-D RBF and IDW buttons', async ({ page }) => {
    await expect(page.getByText('Interpolation method')).toBeVisible();
    await expect(page.getByRole('button', { name: '3-D RBF' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'IDW' })).toBeVisible();
  });

  test('switching to IDW hides the smoothing λ control', async ({ page }) => {
    await page.getByRole('button', { name: 'IDW' }).click();
    await expect(page.getByText(/Smoothing/)).not.toBeVisible();
  });

  test('switching back to RBF shows the smoothing λ control', async ({ page }) => {
    await page.getByRole('button', { name: 'IDW' }).click();
    await page.getByRole('button', { name: '3-D RBF' }).click();
    await expect(page.getByText(/Smoothing/)).toBeVisible();
  });
});
